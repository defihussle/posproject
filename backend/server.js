require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { generateSecret: generateTotpSecret, generateURI: generateTotpUri, verify: verifyTotpToken } = require("otplib");
const QRCode = require("qrcode");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 4000;

// Render's real request path is TWO hops, not one: Client -> Cloudflare
// edge -> Render's own internal load balancer -> this process. Confirmed
// empirically (GET /api/_debug_proxy against production): with
// `trust proxy: 1`, req.ip resolved to Cloudflare's edge IP
// (104.23.211.128) instead of the real client (99.226.201.208, matched by
// the `CF-Connecting-IP`/`True-Client-IP` headers Cloudflare sets) —
// Render's LB is the actual socket peer (a private 10.x address) but
// doesn't append itself to X-Forwarded-For, so it still consumes one hop
// of trust without ever showing up in the header chain. `trust proxy: 1`
// stops one hop short as a result. `2` correctly lands on the true client.
// This also governs `req.secure` below (Express reads X-Forwarded-Proto
// once the immediate socket peer is trusted, which `1` already covered —
// so the cross-site cookie logic was unaffected by this specific bug, but
// `req.ip` was not reliable for anything, including rate limiting).
app.set("trust proxy", 2);

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET env var is required (signs Back Office session cookies)");
}
// Deliberately separate from SESSION_SECRET — device trust (this) and
// staff session trust (above) are orthogonal layers per the device-
// pairing plan; a leak of one secret shouldn't compromise the other.
const DEVICE_SECRET = process.env.DEVICE_SECRET;
if (!DEVICE_SECRET) {
  throw new Error("DEVICE_SECRET env var is required (signs device-pairing cookies)");
}

// --------------- Stripe Terminal configuration (plan Slice 0.3) ---------------
// Configuration and client ONLY. Nothing in the payment path reads any of this
// yet: checkout still writes a mocked 'captured' payments row exactly as it did
// before, and Cash is untouched. See docs/architecture/stripe-terminal-plan.md.
//
// PAYMENTS_PROVIDER is the kill-switch (decision D10) and defaults to 'mock',
// so the safe state is the one you get by doing nothing — a missing, broken or
// half-finished Stripe setup can never take card payments down, it just leaves
// today's mocked path running. Flipping to 'stripe' is the deliberate act, and
// that is when the Stripe vars become mandatory: a missing key then throws at
// BOOT (Render's health check fails and the deploy rolls back) rather than at
// the first customer standing at the counter.
//
// An unrecognised value is a hard error rather than a silent fall back to
// 'mock'. A typo ("stipe", "Stripe " with a trailing space) that quietly
// disabled real card payments would be invisible until someone reconciled the
// day's takings — exactly the class of failure this app keeps getting bitten by.
const PAYMENTS_PROVIDERS = ["mock", "stripe"];
const PAYMENTS_PROVIDER = (process.env.PAYMENTS_PROVIDER || "mock").trim().toLowerCase();
if (!PAYMENTS_PROVIDERS.includes(PAYMENTS_PROVIDER)) {
  throw new Error(
    `PAYMENTS_PROVIDER must be one of: ${PAYMENTS_PROVIDERS.join(", ")} — got "${process.env.PAYMENTS_PROVIDER}". ` +
      `Refusing to guess: silently falling back to 'mock' would mean taking no real card payments with nothing to show for it.`
  );
}

// The API version is pinned EXPLICITLY (decision D12). Terminal endpoints are
// version-sensitive, and an unpinned version means an SDK bump or a redeploy
// can change payment behaviour with no code change to review.
//
// The constant below is the version the installed SDK was generated against —
// the one its request/response shapes actually match — and it is what mock mode
// uses so the diagnostic endpoint can prove connectivity before anything goes
// live. In 'stripe' mode STRIPE_API_VERSION must be set explicitly (see the
// required-vars check below): once real money is moving, the pin belongs in the
// environment where it is visible and reviewable, not defaulted in code.
const STRIPE_SDK_API_VERSION = "2026-07-29.dahlia"; // stripe-node 22.x
const STRIPE_API_VERSION = (process.env.STRIPE_API_VERSION || STRIPE_SDK_API_VERSION).trim();
const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();

if (PAYMENTS_PROVIDER === "stripe") {
  const missing = [
    ["STRIPE_SECRET_KEY", STRIPE_SECRET_KEY],
    ["STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET],
    ["STRIPE_API_VERSION", (process.env.STRIPE_API_VERSION || "").trim()],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `PAYMENTS_PROVIDER=stripe requires: ${missing.join(", ")}. ` +
        `Set them, or set PAYMENTS_PROVIDER=mock to keep running on the mocked payment path.`
    );
  }
}

// Constructed ONCE (D12), and only when a secret key is present. In mock mode
// with no key the entire Stripe surface stays inert instead of throwing — that
// is the whole point of the default. A key present while still in mock mode
// DOES build the client on purpose: Slice 0.3's diagnostic has to be able to
// prove the backend can reach Stripe BEFORE the kill-switch is flipped.
const stripeClient = STRIPE_SECRET_KEY
  ? new (require("stripe"))(STRIPE_SECRET_KEY, {
      apiVersion: STRIPE_API_VERSION,
      appInfo: { name: "Narcos Tacos POS", url: "https://pos.narcostacos.ca" },
    })
  : null;

// test vs live, derived from the key PREFIX only. The key itself is never
// logged, echoed in a response, or returned by the diagnostic below.
function stripeKeyMode(key) {
  if (/^(sk|rk)_live_/.test(key)) return "live";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  return "unknown";
}

// One line at boot so the mode is never a mystery in the Render logs. Deliberately
// says nothing about the key beyond test/live.
console.log(
  `Payments: provider=${PAYMENTS_PROVIDER}, stripeClient=${stripeClient ? "configured" : "not configured"}` +
    (stripeClient ? `, keyMode=${stripeKeyMode(STRIPE_SECRET_KEY)}, apiVersion=${STRIPE_API_VERSION}` : "")
);

const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");

// The frontend (pos.narcostacos.ca) and backend (api.narcostacos.ca) now
// share the same registrable domain — that's what lets the cookie-domain
// fix below (sessionCookieOpts) turn this into a same-SITE relationship
// for cookie purposes. It's still an explicit CORS allowlist with
// credentials:true regardless, since same-site and same-origin are
// different things and CORS cares about the latter: api.narcostacos.ca
// and pos.narcostacos.ca are still different origins as far as the
// browser's CORS check goes, even though they're no longer different
// sites for SameSite cookie purposes. A wildcard `Access-Control-Allow-
// Origin: *` is fundamentally incompatible with credentialed (cookie)
// requests regardless — browsers refuse to expose the response to the
// page when both are combined. The known-good production origins are
// hardcoded here (not just sourced from FRONTEND_URL) so a missing/wrong
// FRONTEND_URL env var on Render can't silently break Back Office login
// the way a missing SPA rewrite rule once broke KDS (see Known Gotchas in
// CLAUDE.md) — FRONTEND_URL is still included too, so a future staging
// domain only needs an env var, not a code change. The raw onrender.com
// URLs (both frontend's and backend's own) stay listed too — direct
// access to either must keep working as a debugging fallback; CORS
// doesn't apply to non-browser requests (curl, Postman) at all, but a
// browser hitting the raw frontend URL still needs its Origin allowed
// here, and the backend's own raw URL is included for symmetry/any
// browser-based testing done directly against it.
const ALLOWED_ORIGINS = [
  ...new Set([
    FRONTEND_URL,
    "https://pos.narcostacos.ca", // production frontend (custom domain)
    "https://narcospos-site.onrender.com", // production frontend (raw Render URL, fallback/testing)
    "https://api.narcostacos.ca", // production backend's own custom domain
    "https://posproject-tnlm.onrender.com", // production backend's raw Render URL, same fallback/testing reasoning
    "http://localhost:5173", // local dev, default Vite port
    "http://localhost:5174", // local dev, Vite's fallback port if 5173 is taken
  ]),
];

const SESSION_COOKIE_NAME = "bo_session";
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h — roughly a shift

// Back Office session cookie flags — httpOnly so client-side JS (and any
// XSS) can never read it. `secure`/`sameSite` are derived from the ACTUAL
// request (req.secure, reliable now that `trust proxy` is set above)
// rather than a NODE_ENV env var that might not be set on the host:
//   - Local dev (plain http://localhost): secure:false, sameSite:"lax",
//     no domain attribute — frontend and backend are same-site (both
//     "localhost"), so Lax is both sufficient and required (a Secure
//     cookie is silently refused over plain HTTP), and an explicit domain
//     is unnecessary (and would need to be "localhost", not
//     narcostacos.ca, so it's simplest to just leave it unset here).
//   - Production (HTTPS): secure:true, sameSite:"none" — required
//     regardless of the domain fix below, since SameSite=Lax is NEVER
//     sent on a cross-SITE fetch/XHR (only on top-level navigations), and
//     SameSite=None is only valid on Secure cookies, hence the two flags
//     moving together.
//
// Domain attribute (the actual fix for the mobile Safari bug — Safari is
// notably stricter than other browsers about cookies on genuinely
// cross-site requests): frontend and backend now share the registrable
// domain narcostacos.ca (pos.narcostacos.ca / api.narcostacos.ca), so
// explicitly setting Domain=.narcostacos.ca makes this a same-SITE
// relationship instead of cross-site, which is what Safari's stricter
// cookie policy actually keys off — SameSite=None already told browsers
// to send it cross-site, but Safari was still dropping/blocking it in
// practice on mobile, and same-site is the more robust fix regardless of
// browser-specific cross-site cookie quirks.
//
// This can ONLY be set when the response is actually being served from a
// narcostacos.ca host — a cookie's Domain attribute must match (or be a
// parent of) the host that set it, or the browser silently drops the
// Set-Cookie entirely. Requests that reach this same code via the raw
// Render URL (posproject-tnlm.onrender.com, kept as a debugging fallback
// — see ALLOWED_ORIGINS above) must NOT get a narcostacos.ca domain
// attribute, or login over that fallback URL would silently break.
// req.hostname respects X-Forwarded-Host given `trust proxy` above, so
// this correctly reflects whichever host the client actually used.
function sessionCookieOpts(req) {
  const isHttps = req.secure;
  const host = req.hostname || "";
  const isNarcosDomain = host === "narcostacos.ca" || host.endsWith(".narcostacos.ca");
  return {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? "none" : "lax",
    path: "/",
    ...(isHttps && isNarcosDomain ? { domain: ".narcostacos.ca" } : {}),
  };
}

// --------------- Middleware ---------------
app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true, // required for the Back Office session cookie to be sent/received cross-origin
  })
);
// Stripe webhook signature verification hashes the EXACT bytes Stripe sent, so
// this one path must keep its raw body. It has to be mounted BEFORE the global
// express.json() below — once that has parsed and discarded the raw buffer,
// every signature check fails and there is no way to recover it. Scoped to the
// single webhook path so nothing else changes shape.
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(cookieParser());

// --------------- Postgres pool ---------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Small helper for throwing HTTP-status-carrying validation errors from
// deep inside the order transaction, caught centrally to roll back + reply.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// --------------- Rate limiter (PIN/login-guessing protection) ---------------
// Keyed by the IDENTITY being guessed — the PIN string itself, the email,
// or the staffId behind an already-validated tempToken — NEVER by IP or
// device. This app runs on a shared counter tablet used by many staff
// across a shift; one person mistyping (or someone deliberately guessing
// a DIFFERENT PIN) must never lock out anyone else. This is a deliberate
// change from an earlier IP-based version, which turned out to be
// completely non-functional in production (Render's real proxy chain
// meant `req.ip` couldn't be trusted as a stable per-client identifier —
// see the trust-proxy note near `app.set("trust proxy", ...)` above).
// Keying by identity sidesteps that dependency entirely: it doesn't matter
// what IP a request claims to come from, since the same PIN/email/account
// is always the same key regardless.
//
// After 3 wrong attempts against the SAME identity within a 5-minute
// window, that identity specifically is locked for 5 minutes. A correct
// attempt before the 3rd failure resets its count back to zero — a
// legitimate staff member who mistyped once or twice isn't penalized once
// they get it right.
//
// `bucket` keeps independent counters per login surface — PIN login, Back
// Office's password step, and Back Office's TOTP step are rate-limited
// separately, so hammering one doesn't consume the allowance of another.
const MAX_ATTEMPTS = 3;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000; // 5 min — how long failures accumulate toward the 3-strike limit
const LOCKOUT_MS = 5 * 60 * 1000; // 5 min lockout once tripped

const loginAttempts = new Map(); // key: `${bucket}::${identity}`, value: { count, firstAttempt, blockedUntil }

function rateLimitKey(identity, bucket) {
  return `${bucket}::${identity}`;
}

function formatLockoutMessage(retryAfterSeconds) {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function checkRateLimit(identity, bucket) {
  const now = Date.now();
  const key = rateLimitKey(identity, bucket);
  const record = loginAttempts.get(key);

  if (!record) return { allowed: true };

  // Currently locked out?
  if (record.blockedUntil && now < record.blockedUntil) {
    const retryAfter = Math.ceil((record.blockedUntil - now) / 1000);
    return { allowed: false, retryAfter };
  }

  // Not locked — but if the accumulation window has expired, drop the
  // stale record so old, spaced-out typos don't count toward a new streak.
  if (now - record.firstAttempt > ATTEMPT_WINDOW_MS) {
    loginAttempts.delete(key);
  }
  return { allowed: true };
}

// Returns { lockedOut, retryAfter? }. `lockedOut` is true exactly on the
// attempt that trips the 3rd strike, so the caller can respond with the
// lockout message immediately — not a generic "wrong" on strike 3 followed
// by a separate 4th attempt that's the first to discover the lockout.
function recordFailedAttempt(identity, bucket) {
  const now = Date.now();
  const key = rateLimitKey(identity, bucket);
  const record = loginAttempts.get(key);

  if (!record || now - record.firstAttempt > ATTEMPT_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttempt: now, blockedUntil: null });
    return { lockedOut: false };
  }

  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.blockedUntil = now + LOCKOUT_MS;
    return { lockedOut: true, retryAfter: Math.ceil(LOCKOUT_MS / 1000) };
  }
  return { lockedOut: false };
}

function clearAttempts(identity, bucket) {
  loginAttempts.delete(rateLimitKey(identity, bucket));
}

// --------------- Routes ---------------

// Health check — verifies DB connectivity
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    console.error("Health check failed:", err.message);
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

// Menu items (flat — kept for backward compatibility)
app.get("/api/menu", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM menu_items ORDER BY sort_order, name");
    res.json(rows);
  } catch (err) {
    console.error("Failed to fetch menu items:", err.message);
    res.status(500).json({ error: "Failed to fetch menu items" });
  }
});

// Full menu structure — categories → items → variants / modifiers / addons
app.get("/api/menu/full", async (req, res) => {
  try {
    // 1. Categories
    const { rows: categories } = await pool.query(
      "SELECT id, name, sort_order FROM menu_categories WHERE active = true ORDER BY sort_order"
    );

    // 2. Items
    const { rows: items } = await pool.query(
      "SELECT id, category_id, name, description, base_price, image_url, sort_order, is_upsell FROM menu_items WHERE active = true ORDER BY sort_order, name"
    );

    // 3. Variants
    const { rows: variants } = await pool.query(
      "SELECT id, item_id, name, price, sku, sort_order FROM item_variants WHERE active = true ORDER BY sort_order"
    );

    // 4. Modifier groups linked to items (join table + group details)
    const { rows: itemModGroups } = await pool.query(`
      SELECT img.item_id, img.sort_order AS link_sort,
             mg.id, mg.name, mg.min_select, mg.max_select, mg.required
      FROM item_modifier_groups img
      JOIN modifier_groups mg ON mg.id = img.modifier_group_id
      ORDER BY img.sort_order
    `);

    // 5. Modifier options
    const { rows: modOptions } = await pool.query(
      "SELECT id, group_id, name, price_delta, sort_order, max_quantity, default_selected FROM modifier_options WHERE active = true ORDER BY sort_order"
    );

    // 6. Item addons
    const { rows: addons } = await pool.query(`
      SELECT ia.id, ia.item_id, ia.addon_item_id, ia.included_quantity,
             ia.extra_price, ia.sort_order,
             mi.name AS addon_name, mi.base_price AS addon_base_price
      FROM item_addons ia
      JOIN menu_items mi ON mi.id = ia.addon_item_id
      ORDER BY ia.sort_order
    `);

    // ---------- Assemble in memory ----------

    // Index modifier options by group_id
    const optionsByGroup = {};
    for (const opt of modOptions) {
      (optionsByGroup[opt.group_id] ||= []).push(opt);
    }

    // Index modifier groups by item_id (attach options inline)
    const modGroupsByItem = {};
    for (const mg of itemModGroups) {
      const group = {
        id: mg.id,
        name: mg.name,
        min_select: mg.min_select,
        max_select: mg.max_select,
        required: mg.required,
        options: optionsByGroup[mg.id] || [],
      };
      (modGroupsByItem[mg.item_id] ||= []).push(group);
    }

    // Index variants by item_id
    const variantsByItem = {};
    for (const v of variants) {
      (variantsByItem[v.item_id] ||= []).push(v);
    }

    // Index addons by item_id
    const addonsByItem = {};
    for (const a of addons) {
      (addonsByItem[a.item_id] ||= []).push(a);
    }

    // Index items by category_id, enriching each with nested data
    const itemsByCat = {};
    for (const item of items) {
      const enriched = {
        ...item,
        variants: variantsByItem[item.id] || [],
        modifier_groups: modGroupsByItem[item.id] || [],
        addons: addonsByItem[item.id] || [],
      };
      (itemsByCat[item.category_id] ||= []).push(enriched);
    }

    // Build final response
    const result = categories.map((cat) => ({
      ...cat,
      items: itemsByCat[cat.id] || [],
    }));

    res.json(result);
  } catch (err) {
    console.error("Failed to fetch full menu:", err.message);
    res.status(500).json({ error: "Failed to fetch full menu" });
  }
});

// PIN login. requireDevicePairing gates this so an unpaired device can't
// even attempt PINs against Order Entry (the original threat — see
// docs/architecture/device-pairing.md). A 401 here surfaces in the UI as
// the pairing screen via RequireDevicePairing.
app.post("/api/auth/login", requireDevicePairing, async (req, res) => {
  const { pin } = req.body;
  if (!pin || typeof pin !== "string") {
    return res.status(400).json({ success: false, message: "PIN is required" });
  }

  // Rate-limit check — keyed by the PIN itself, not this device, so one
  // PIN's lockout never affects another staff member on the same shared
  // tablet (see the rate limiter section above for why).
  const rateCheck = checkRateLimit(pin, "pin");
  if (!rateCheck.allowed) {
    return res.status(429).json({
      success: false,
      message: formatLockoutMessage(rateCheck.retryAfter),
      retryAfter: rateCheck.retryAfter,
    });
  }

  try {
    // Fetch all active staff with their hashed PINs
    const { rows } = await pool.query(
      "SELECT id, name, role, location_id, pin_hash FROM staff WHERE active = true"
    );

    // Compare submitted PIN against each hash
    let matchedStaff = null;
    for (const staff of rows) {
      const isMatch = await bcrypt.compare(pin, staff.pin_hash);
      if (isMatch) {
        matchedStaff = staff;
        break;
      }
    }

    if (!matchedStaff) {
      const attempt = recordFailedAttempt(pin, "pin");
      if (attempt.lockedOut) {
        return res.status(429).json({
          success: false,
          message: formatLockoutMessage(attempt.retryAfter),
          retryAfter: attempt.retryAfter,
        });
      }
      return res.status(401).json({ success: false, message: "PIN not recognized" });
    }

    // Success — reset this PIN's failure count
    clearAttempts(pin, "pin");

    // Return staff info WITHOUT pin_hash
    const { pin_hash, ...staffData } = matchedStaff;
    return res.json({ success: true, staff: staffData });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// --------------- Checkout: create an order ---------------
// POST /api/orders
// Body: {
//   staffId, paymentMethod ("cash" | "card"),
//   items: [{ itemId, variantId|null, quantity, notes|null,
//             modifiers: [{ optionId, quantity }],
//             addons:    [{ addonId, extraQty }] }]
// }
//
// SECURITY: prices are ALWAYS recomputed from the live database. The
// payload only tells us WHAT was selected, never what it costs — so a
// tampered client can't change the total. The entire write runs inside
// a single transaction; any validation failure rolls the whole thing back.

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const DISCOUNT_REASONS = ["family", "friend", "employee", "neighbouring_store"];
const DISCOUNT_FLAG_THRESHOLD = 50; // % — not blocked, but logged so it's not silently invisible

// Refund/Void — fixed reason set (CHECK-constrained in database/refunds.sql,
// same spirit as DISCOUNT_REASONS) and the two reversal types. See
// docs/architecture/refunds-plan.md.
const REFUND_REASONS = [
  "wrong_order", "kitchen_error", "quality_issue",
  "customer_cancelled", "overcharge", "duplicate", "other",
];
const REFUND_TYPES = ["void", "refund"];
const REFUND_FLAG_THRESHOLD = 50; // $ — logged, never silently invisible (mirrors discounts)
// At/above this $ amount a manager PIN is NOT enough — an owner/admin must
// approve (misuse guard). Back Office callers are already owner/admin.
const REFUND_OWNER_APPROVAL_THRESHOLD = 100; // $

// Is this checkout the one that talks to a physical reader? Cash never is, and
// neither is Card while PAYMENTS_PROVIDER=mock — both keep the synchronous
// insert-an-order-immediately path they have always had (decision D11).
function isStripeCardCheckout(paymentMethod) {
  return paymentMethod === "card" && PAYMENTS_PROVIDER === "stripe";
}

// Money is NUMERIC(10,2) here and integer cents at Stripe. ONE helper and one
// rounding rule, so the two representations can never disagree by a cent —
// which matters because Slice 2 asserts the amount Stripe charged against the
// amount we stored before it will write an order.
function toStripeAmount(dollars) {
  const cents = Math.round(Number(dollars) * 100);
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new HttpError(400, `Refusing to charge an invalid amount (${dollars})`);
  }
  return cents;
}

// Which reader should this till drive? The binding lives on the device pairing
// (device_pairings.stripe_reader_id), so a second till is configuration rather
// than a code change. Stripe readers remain a SEPARATE trust layer from device
// pairing — this column binds them without merging them.
async function resolveReaderForDevice(client, deviceId) {
  const { rows } = await client.query(
    "SELECT stripe_reader_id FROM device_pairings WHERE device_id = $1",
    [deviceId]
  );
  const readerId = rows[0]?.stripe_reader_id ? String(rows[0].stripe_reader_id).trim() : null;
  if (!readerId) {
    throw new HttpError(
      409,
      "This till has no card reader assigned yet. Assign one in Back Office → Devices before taking card payments."
    );
  }
  return readerId;
}

// Classifies a Stripe Terminal failure into something a cashier can act on.
// "Reader busy" and "reader offline" need genuinely different responses at the
// counter — wait a moment and retry vs. go and check the device — so they must
// not collapse into one generic error message.
function readerErrorKind(err) {
  const code = String(err?.code || "").toLowerCase();
  const message = String(err?.message || "").toLowerCase();
  const says = (s) => code.includes(s) || message.includes(s);

  if (says("busy") || says("already in progress") || says("intent_invalid_state")) {
    return "reader_busy";
  }
  if (says("offline") || says("timeout") || says("unreachable") || says("hardware_fault")) {
    return "reader_offline";
  }
  return "reader_error";
}

// Creates the PaymentIntent for an already-committed pending checkout and hands
// it to the reader.
//
// Deliberately runs OUTSIDE the checkout transaction, after the pooled client
// has been released. The pending_checkouts row is committed FIRST so that a
// crash between here and Stripe can never leave money moving with nothing
// locally to explain it. The reverse order — holding a transaction open across
// two network round-trips to Stripe — would pin a pooled connection for seconds
// and risk a committed PaymentIntent whose row got rolled back.
//
// Both calls carry an Idempotency-Key derived from the pending-checkout id
// (decision D9), so a network timeout and retry can never double-charge. One
// attempt per pending checkout in this slice; retry-after-decline creates a new
// attempt and arrives with the frontend states in Slice 3.
async function startTerminalPayment(res, pending) {
  const idemBase = `pc_${pending.id}`;
  try {
    const paymentIntent = await stripeClient.paymentIntents.create(
      {
        amount: toStripeAmount(pending.total),
        currency: "cad",
        payment_method_types: ["card_present", "interac_present"],
        capture_method: "automatic",
        metadata: {
          pending_checkout_id: pending.id,
          location_id: pending.locationId,
          staff_id: pending.staffId,
        },
      },
      { idempotencyKey: `${idemBase}_pi` }
    );

    await pool.query(
      "UPDATE pending_checkouts SET stripe_payment_intent_id = $2, updated_at = now() WHERE id = $1",
      [pending.id, paymentIntent.id]
    );

    // On-reader tipping (Slice 4). The 15/18/20% Terminal Configuration on the
    // Stripe Location supplies the PERCENTAGES, but in a server-driven
    // integration it does not by itself make the reader ask: process_config
    // .tipping is the switch. Without it the reader charges the exact amount
    // and never shows a tip screen, however the Configuration is set up.
    //
    // amount_eligible is the base those percentages are calculated from, and
    // it is deliberately the DISCOUNTED PRE-TAX subtotal, not the full charge:
    // tipping on HST would quietly inflate every suggestion by 13%. To tip on
    // the full amount instead, drop amount_eligible and Stripe falls back to
    // the PaymentIntent total.
    const tipEligibleCents = Math.round(
      (parseFloat(pending.subtotal) - parseFloat(pending.discount)) * 100
    );
    await stripeClient.terminal.readers.processPaymentIntent(
      pending.readerId,
      {
        payment_intent: paymentIntent.id,
        // A fully-discounted (free) order has nothing to tip on — asking would
        // be absurd, and Stripe rejects a zero/negative eligible amount.
        ...(tipEligibleCents > 0
          ? { process_config: { tipping: { amount_eligible: tipEligibleCents } } }
          : {}),
      },
      { idempotencyKey: `${idemBase}_process` }
    );

    // 202, not 201: nothing has been created yet. No order and no payments row
    // exist, and none will until the success webhook arrives (Slice 2).
    return res.status(202).json({
      pending: true,
      pendingCheckoutId: pending.id,
      paymentIntentId: paymentIntent.id,
      readerId: pending.readerId,
      status: "awaiting_payment",
      subtotal: pending.subtotal,
      discount: pending.discount,
      tax: pending.tax,
      total: pending.total,
    });
  } catch (err) {
    // A rejected amount, an offline reader, a reader already mid-action, a bad
    // key. No money has moved: an un-processed PaymentIntent holds no funds.
    // Mark the attempt failed so it stops looking in-flight, and keep the
    // reason for the cashier and for the Slice 6 sweep.
    await pool
      .query(
        `UPDATE pending_checkouts
            SET status = 'failed', error_message = $2, updated_at = now()
          WHERE id = $1 AND status = 'awaiting_payment'`,
        [pending.id, String(err.message || "Unknown Stripe error").slice(0, 500)]
      )
      .catch((e) => console.error("Could not mark pending checkout failed:", e.message));

    const kind = readerErrorKind(err);
    console.error(
      `Terminal payment failed (pending_checkout=${pending.id}, kind=${kind}):`,
      err.message
    );
    return res.status(502).json({
      error: `Could not start the payment on the reader: ${err.message}`,
      // Machine-readable so Order Entry can say something specific and
      // actionable instead of "something went wrong".
      code: kind,
      detail: err.message,
      pendingCheckoutId: pending.id,
    });
  }
}

// ---------------- Stripe webhook: order materialization (Slice 2) ------------
//
// This is where a card sale becomes real. Everything before it — the pending
// checkout, the PaymentIntent, the reader prompt — is provisional; nothing has
// been recorded as a sale. Decision D1 (Option B) puts the whole
// order-creation step HERE, behind confirmed payment, which is what keeps a
// declined or abandoned checkout from leaving any trace: no KDS ticket, no
// pos-recall row, no phantom 'cancelled' order in the Transaction Log.
//
// Writes, in ONE transaction, from the FROZEN snapshot (D2 — never re-priced):
//   orders → order_items → order_item_modifiers/addons → payments →
//   pending_checkouts.status='succeeded' + order_id
//
// The caller holds a `SELECT … FOR UPDATE` on the pending row, so two
// concurrent webhook deliveries serialise here and the second sees
// status='succeeded' and does nothing. The partial UNIQUE index on
// payments.processor_txn_id is the backstop underneath that.
async function materializeOrderFromPendingCheckout(client, { pending, paymentIntent, charge }) {
  const snapshot = pending.payload || {};
  const lines = Array.isArray(snapshot.lines) ? snapshot.lines : [];
  if (lines.length === 0) {
    throw new Error(`pending_checkout ${pending.id} has an empty snapshot — refusing to write an order`);
  }

  // ---- Money: what the snapshot said vs. what Stripe actually took ----
  // The tip is not known until the customer taps, so the amount charged is the
  // snapshot total PLUS whatever they tipped on the reader. Deriving the tip as
  // the difference makes the arithmetic self-checking: it can only be right if
  // Stripe charged exactly what we asked plus a non-negative tip.
  const snapshotCents = toStripeAmount(pending.total);
  const chargedCents = Number(
    paymentIntent.amount_received != null ? paymentIntent.amount_received : paymentIntent.amount
  );
  const tipCents = chargedCents - snapshotCents;

  if (!Number.isFinite(chargedCents) || tipCents < 0) {
    // Stripe took LESS than the cart. Not something a retry can fix, so this is
    // not a transient error: refuse to write an order and let the reversal be a
    // human decision.
    throw new HttpError(
      409,
      `Amount mismatch on pending_checkout ${pending.id}: charged ${chargedCents}¢ but the cart was ${snapshotCents}¢`
    );
  }

  // Cross-check against the charge's own tip figure when Stripe reports one.
  // Disagreement means our model of the amounts is wrong, which is exactly the
  // thing that must never be papered over.
  const reportedTipCents = charge?.amount_details?.tip?.amount;
  if (reportedTipCents != null && Number(reportedTipCents) !== tipCents) {
    throw new HttpError(
      409,
      `Tip mismatch on pending_checkout ${pending.id}: derived ${tipCents}¢ but Stripe reports ${reportedTipCents}¢`
    );
  }

  const tip = round2(tipCents / 100);
  // THE money invariant: orders.total is tip-inclusive, and the payments row
  // equals it exactly. Every report reconciles through
  //   SUM(orders.total) [ready] − refunds == SUM(settled payments)
  // so if these two ever diverge, Sales Summary stops balancing silently.
  const total = round2(parseFloat(pending.total) + tip);
  if (toStripeAmount(total) !== chargedCents) {
    throw new HttpError(
      409,
      `Refusing to write an order whose total (${total}) does not equal what Stripe charged (${chargedCents}¢)`
    );
  }

  // ---- orders ----
  const { rows: orderRows } = await client.query(
    `INSERT INTO orders (location_id, staff_id, status, subtotal, tax, tip, total,
                          discount, discount_percent, discount_reason, discount_applied_by)
     VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, order_number`,
    [
      pending.location_id,
      pending.staff_id,
      pending.subtotal,
      pending.tax,
      tip,
      total,
      pending.discount,
      pending.discount_percent,
      pending.discount_reason,
      snapshot.discountAppliedBy || null,
    ]
  );
  const order = orderRows[0];

  // ---- lines, modifiers, addons — replayed verbatim from the snapshot ----
  for (const line of lines) {
    const { rows: oiRows } = await client.query(
      `INSERT INTO order_items (order_id, item_id, variant_id, quantity, unit_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [order.id, line.itemId, line.variantId, line.quantity, line.unitPrice, line.notes]
    );
    const orderItemId = oiRows[0].id;

    for (const mod of line.modifiers || []) {
      await client.query(
        `INSERT INTO order_item_modifiers (order_item_id, modifier_option_id, price_delta, quantity)
         VALUES ($1, $2, $3, $4)`,
        [orderItemId, mod.optionId, mod.priceDelta, mod.quantity]
      );
    }

    for (const addon of line.addons || []) {
      await client.query(
        `INSERT INTO order_item_addons (order_item_id, addon_item_id, quantity, unit_price, is_complimentary)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderItemId, addon.addonItemId, addon.quantity, addon.unitPrice, addon.isComplimentary]
      );
    }
  }

  // ---- payments: ONE captured row, amount === orders.total ----
  // processor_payment_type is what the Interac refund rule (D5) reads later:
  // an interac_present sale cannot be refunded remotely from Back Office.
  const details = charge?.payment_method_details || {};
  const presentDetails = details.card_present || details.interac_present || null;
  const processorPaymentType = details.card_present
    ? "card_present"
    : details.interac_present
      ? "interac_present"
      : charge
        ? "other"
        : null;

  await client.query(
    `INSERT INTO payments (order_id, method, amount, status, processor_txn_id,
                           processor_payment_type, card_brand, card_last4)
     VALUES ($1, 'card', $2, 'captured', $3, $4, $5, $6)`,
    [
      order.id,
      total,
      paymentIntent.id,
      processorPaymentType,
      presentDetails?.brand || null,
      presentDetails?.last4 || null,
    ]
  );

  // ---- assert the money invariant against what was actually written ----
  // orders.total and payments.amount come from the same `total` above, so they
  // agree by construction today — but "by construction" silently stops being
  // true the moment someone edits one of those two INSERTs. This reads both
  // rows back and compares them for real. It runs inside the transaction, so a
  // mismatch rolls the whole order back rather than recording a sale whose
  // money does not add up, and the outer handler flags it as orphaned.
  const { rows: checkRows } = await client.query(
    `SELECT o.total::numeric AS order_total,
            COALESCE(SUM(p.amount), 0)::numeric AS captured
       FROM orders o
  LEFT JOIN payments p ON p.order_id = o.id AND p.status = 'captured'
      WHERE o.id = $1
   GROUP BY o.total`,
    [order.id]
  );
  const written = checkRows[0];
  if (!written || parseFloat(written.order_total) !== parseFloat(written.captured)) {
    throw new HttpError(
      409,
      `Money invariant violated on order ${order.id}: orders.total=${written?.order_total} ` +
        `but captured payments=${written?.captured}`
    );
  }

  // ---- close out the pending checkout ----
  // status and order_id move together; the CHECK constraint on the table
  // rejects 'succeeded' with a NULL order_id, so a half-written outcome cannot
  // be recorded even if this were called wrongly.
  await client.query(
    `UPDATE pending_checkouts
        SET status = 'succeeded', order_id = $2, error_message = NULL, updated_at = now()
      WHERE id = $1`,
    [pending.id, order.id]
  );

  return { order, tip, total };
}

// Marks an in-flight attempt failed. Never touches a checkout that already
// succeeded — a late `payment_failed` for a superseded attempt must not
// invalidate a real sale (decision D7: a failure writes no order and no
// payments row, it only closes out the attempt).
async function markPendingCheckoutFailed(paymentIntentId, message) {
  const { rowCount } = await pool.query(
    `UPDATE pending_checkouts
        SET status = 'failed', error_message = $2, updated_at = now()
      WHERE stripe_payment_intent_id = $1
        AND status = 'awaiting_payment'`,
    [paymentIntentId, String(message || "Payment failed").slice(0, 500)]
  );
  return rowCount;
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  // Card brand/last4 and Stripe's own tip figure live on the CHARGE, which the
  // event carries only as an id. This is a read — idempotency keys apply to
  // POSTs, not GETs — and it is best-effort: if it fails we still materialize
  // the order (money correctness outranks receipt metadata) with the tip
  // derived from the amounts.
  let charge = null;
  if (paymentIntent.latest_charge) {
    try {
      charge =
        typeof paymentIntent.latest_charge === "string"
          ? await stripeClient.charges.retrieve(paymentIntent.latest_charge)
          : paymentIntent.latest_charge;
    } catch (err) {
      console.error(`Could not retrieve charge for ${paymentIntent.id}:`, err.message);
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // FOR UPDATE serialises concurrent deliveries of the same event: the second
    // one blocks here, then sees status='succeeded' below and does nothing.
    const { rows } = await client.query(
      "SELECT * FROM pending_checkouts WHERE stripe_payment_intent_id = $1 FOR UPDATE",
      [paymentIntent.id]
    );
    const pending = rows[0];

    if (!pending) {
      await client.query("ROLLBACK");
      console.warn(
        `payment_intent.succeeded for ${paymentIntent.id} with no matching pending checkout — ignoring ` +
          `(most likely a different environment pointed at this endpoint)`
      );
      return { handled: false, reason: "no_pending_checkout" };
    }
    if (pending.status === "succeeded") {
      await client.query("ROLLBACK");
      return { handled: true, duplicate: true, orderId: pending.order_id };
    }

    const result = await materializeOrderFromPendingCheckout(client, {
      pending,
      paymentIntent,
      charge,
    });
    await client.query("COMMIT");
    console.log(
      `Order #${result.order.order_number} created from ${paymentIntent.id} ` +
        `(total $${result.total}, tip $${result.tip})`
    );
    return { handled: true, orderId: result.order.id, orderNumber: result.order.order_number };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});

    // Money has moved but no order exists — decision D8's orphan case, the one
    // real cost of Option B. Record it so the Slice 6 sweep and a human can
    // find it. 'orphaned' is not terminal: a later retry that succeeds moves
    // the row straight to 'succeeded'.
    await pool
      .query(
        `UPDATE pending_checkouts
            SET status = 'orphaned', error_message = $2, updated_at = now()
          WHERE stripe_payment_intent_id = $1 AND status <> 'succeeded'`,
        [paymentIntent.id, String(err.message || "Order materialization failed").slice(0, 500)]
      )
      .catch((e) => console.error("Could not flag orphaned checkout:", e.message));

    console.error(
      `ORPHANED PAYMENT — ${paymentIntent.id} succeeded at Stripe but no order was written: ${err.message}`
    );

    // An amount/tip mismatch is not something a retry can fix, so swallow it
    // here (200) rather than have Stripe redeliver forever against a problem
    // only a human can resolve. Anything else is treated as transient and
    // rethrown so the delivery fails and Stripe retries.
    if (err instanceof HttpError) {
      return { handled: false, reason: "amount_mismatch", error: err.message };
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------- Reconciliation sweep (Slice 6) -----------------------------
//
// Webhooks are the PRIMARY mechanism; this is the safety net. If a delivery is
// lost, or the process dies between Stripe capturing the money and the order
// being written, the pending checkout sits at 'awaiting_payment' forever and a
// customer has paid for food nobody is cooking. Nothing else in the system
// notices — that is exactly the failure this exists to catch.
//
// It asks Stripe for the truth about each stale row and reconciles to it. Rows
// younger than the threshold are left alone: a customer can legitimately take a
// couple of minutes at the reader, and racing a live payment would be worse
// than waiting.
const RECONCILE_STALE_MINUTES = Number(process.env.RECONCILE_STALE_MINUTES || 20);
// Opt-in background run. Unset (the default) means the sweep only ever runs
// when someone asks for it, so this slice changes no runtime behaviour until
// it is deliberately switched on.
const RECONCILE_INTERVAL_MINUTES = Number(process.env.RECONCILE_INTERVAL_MINUTES || 0);

// PaymentIntent statuses that mean the customer never completed. Stripe keeps
// an unfinished intent in one of these indefinitely, so age is what makes them
// abandoned rather than in-progress.
const PI_ABANDONED_STATUSES = ["requires_payment_method", "requires_confirmation", "requires_action"];
// Genuinely still in flight — leave these alone however old they look.
const PI_IN_FLIGHT_STATUSES = ["processing", "requires_capture"];

async function markPendingCheckoutOutcome(id, status, message) {
  // Guarded on 'awaiting_payment' so a webhook that lands mid-sweep always
  // wins. The sweep is a backstop; it must never overwrite a real outcome.
  const { rowCount } = await pool.query(
    `UPDATE pending_checkouts
        SET status = $2, error_message = $3, updated_at = now()
      WHERE id = $1 AND status = 'awaiting_payment'`,
    [id, status, message]
  );
  return rowCount === 1;
}

async function reconcilePendingCheckouts({ staleMinutes = RECONCILE_STALE_MINUTES, limit = 200 } = {}) {
  const summary = {
    staleMinutes,
    scanned: 0,
    materialized: 0, // a missed webhook, recovered
    alreadyResolved: 0, // the webhook had in fact landed
    expired: 0, // customer walked away
    cancelled: 0, // PaymentIntent was cancelled
    orphaned: 0, // MONEY TAKEN, NO ORDER — the one that matters
    stillOpen: 0, // genuinely mid-payment
    errors: 0, // could not reach Stripe for this row
    orphans: [],
  };

  if (!stripeClient) {
    summary.skipped = "Stripe is not configured on this server";
    return summary;
  }

  const { rows } = await pool.query(
    `SELECT id, stripe_payment_intent_id, total, created_at
       FROM pending_checkouts
      WHERE status = 'awaiting_payment'
        AND created_at < now() - make_interval(mins => $1)
      ORDER BY created_at
      LIMIT $2`,
    [staleMinutes, limit]
  );
  summary.scanned = rows.length;

  for (const row of rows) {
    // No PaymentIntent id: the process died between committing the pending row
    // and calling Stripe. No money can have moved, so this is simply abandoned.
    if (!row.stripe_payment_intent_id) {
      if (await markPendingCheckoutOutcome(row.id, "expired", "No payment was ever started")) {
        summary.expired++;
      }
      continue;
    }

    let paymentIntent;
    try {
      paymentIntent = await stripeClient.paymentIntents.retrieve(row.stripe_payment_intent_id);
    } catch (err) {
      // Cannot reach Stripe: leave the row exactly as it is and try again next
      // sweep. Guessing here could strand a real payment.
      summary.errors++;
      console.error(`Reconcile: could not retrieve ${row.stripe_payment_intent_id}: ${err.message}`);
      continue;
    }

    try {
      if (paymentIntent.status === "succeeded") {
        // Reuse the webhook's own path — same locking, same amount assertions,
        // same orphan marking. A second implementation of order creation is the
        // last thing this codebase needs.
        const result = await handlePaymentIntentSucceeded(paymentIntent);
        if (result.duplicate) {
          summary.alreadyResolved++;
        } else if (result.handled) {
          summary.materialized++;
          console.warn(
            `Reconcile: recovered a MISSED WEBHOOK — order #${result.orderNumber} written from ` +
              `${paymentIntent.id} (pending_checkout=${row.id})`
          );
        } else {
          // handlePaymentIntentSucceeded already flagged the row orphaned.
          summary.orphaned++;
        }
      } else if (paymentIntent.status === "canceled") {
        if (await markPendingCheckoutOutcome(row.id, "cancelled", "PaymentIntent was cancelled")) {
          summary.cancelled++;
        }
      } else if (PI_ABANDONED_STATUSES.includes(paymentIntent.status)) {
        if (
          await markPendingCheckoutOutcome(
            row.id,
            "expired",
            `Abandoned at the reader (PaymentIntent ${paymentIntent.status})`
          )
        ) {
          summary.expired++;
        }
      } else if (PI_IN_FLIGHT_STATUSES.includes(paymentIntent.status)) {
        summary.stillOpen++;
      } else {
        summary.stillOpen++;
        console.warn(`Reconcile: unhandled PaymentIntent status "${paymentIntent.status}" on ${paymentIntent.id}`);
      }
    } catch (err) {
      // handlePaymentIntentSucceeded rethrows anything it considers transient,
      // having already marked the row orphaned. Count it and keep going — one
      // bad row must not abort the sweep.
      summary.orphaned++;
      console.error(`Reconcile: failed to resolve ${paymentIntent.id}: ${err.message}`);
    }
  }

  // Every outstanding orphan, not just ones found this run: money is sitting at
  // Stripe with no order behind it, and it stays visible until a human clears
  // it. Deliberately reported on every sweep so it cannot quietly age out.
  const { rows: orphanRows } = await pool.query(
    `SELECT id, stripe_payment_intent_id, total, error_message, updated_at
       FROM pending_checkouts
      WHERE status = 'orphaned'
      ORDER BY updated_at DESC
      LIMIT 50`
  );
  summary.orphans = orphanRows.map((o) => ({
    pendingCheckoutId: o.id,
    paymentIntentId: o.stripe_payment_intent_id,
    amount: parseFloat(o.total),
    error: o.error_message,
    since: o.updated_at,
  }));
  summary.outstandingOrphans = summary.orphans.length;

  if (summary.orphans.length > 0) {
    // Structured so a log drain can alert on it without parsing prose.
    console.error(
      JSON.stringify({
        alert: "PAYMENTS_ORPHANED",
        message: "Money captured at Stripe with no order written",
        count: summary.orphans.length,
        totalAmount: summary.orphans.reduce((t, o) => t + o.amount, 0),
        orphans: summary.orphans,
      })
    );
  }

  return summary;
}

// POST /api/backoffice/payments/reconcile — run the sweep now. Owner/admin.
// Deliberately manual-first: a scheduled run is opt-in via
// RECONCILE_INTERVAL_MINUTES, so the sweep can be exercised and trusted before
// it is left to run unattended.
app.post("/api/backoffice/payments/reconcile", async (req, res) => {
  try {
    await requireBackofficeSession(req);
    // Overridable for testing/triage. Floor of 0 is allowed so an operator can
    // deliberately sweep everything, but the default stays conservative.
    const raw = req.query.minutes ?? req.body?.minutes;
    const staleMinutes = raw === undefined ? RECONCILE_STALE_MINUTES : Math.max(0, Number(raw) || 0);
    const summary = await reconcilePendingCheckouts({ staleMinutes });
    res.json(summary);
  } catch (err) {
    sendHttpError(res, err, "Failed to reconcile payments");
  }
});

// GET /api/backoffice/payments/reconcile/status — read-only snapshot. Answers
// "is anything stuck right now?" without changing anything, so it is safe to
// poll from a dashboard or a health check.
app.get("/api/backoffice/payments/reconcile/status", async (req, res) => {
  try {
    await requireBackofficeSession(req);
    const { rows } = await pool.query(
      `SELECT status, count(*)::int AS n, COALESCE(SUM(total), 0) AS amount,
              MIN(created_at) AS oldest
         FROM pending_checkouts
        WHERE status IN ('awaiting_payment', 'orphaned')
        GROUP BY status`
    );
    const byStatus = Object.fromEntries(
      rows.map((r) => [r.status, { count: r.n, amount: parseFloat(r.amount), oldest: r.oldest }])
    );
    const { rows: staleRows } = await pool.query(
      `SELECT count(*)::int AS n FROM pending_checkouts
        WHERE status = 'awaiting_payment' AND created_at < now() - make_interval(mins => $1)`,
      [RECONCILE_STALE_MINUTES]
    );
    res.json({
      staleMinutes: RECONCILE_STALE_MINUTES,
      scheduledEveryMinutes: RECONCILE_INTERVAL_MINUTES || null,
      awaitingPayment: byStatus.awaiting_payment || { count: 0, amount: 0, oldest: null },
      // The number the sweep would act on right now.
      staleAwaitingPayment: staleRows[0].n,
      // Non-zero here always needs a human.
      orphaned: byStatus.orphaned || { count: 0, amount: 0, oldest: null },
    });
  } catch (err) {
    sendHttpError(res, err, "Failed to read reconciliation status");
  }
});

// POST /api/stripe/webhook — Stripe's callback. NOT device-gated (Stripe has no
// pairing cookie), and CORS does not apply: this is server-to-server. Its
// authentication is the signature check below and nothing else, which is why
// that check runs before anything is read from the body.
app.post("/api/stripe/webhook", async (req, res) => {
  if (!stripeClient || !STRIPE_WEBHOOK_SECRET) {
    // Fails closed: an unconfigured server must never accept unverifiable
    // payment events.
    return res.status(503).json({ error: "Stripe webhooks are not configured on this server" });
  }

  let event;
  try {
    event = stripeClient.webhooks.constructEvent(
      req.body, // raw Buffer — see the express.raw mount near the top
      req.headers["stripe-signature"],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).json({ error: "Signature verification failed" });
  }

  // ---- Durable dedup (decision D9) ----
  // Keyed on Stripe's own event id so a redelivery is recognised across
  // restarts. A row that exists but was never processed (a crash mid-handler)
  // is deliberately allowed through again — dedup must not turn a crash into a
  // permanently skipped payment.
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO stripe_events (id, type, api_version, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [event.id, event.type, event.api_version || null, JSON.stringify(event)]
    );
    if (rowCount === 0) {
      const { rows } = await pool.query(
        "SELECT processed_at FROM stripe_events WHERE id = $1",
        [event.id]
      );
      if (rows[0]?.processed_at) {
        return res.json({ received: true, duplicate: true });
      }
      console.warn(`Reprocessing ${event.id} (${event.type}) — recorded earlier but never completed`);
    }
  } catch (err) {
    console.error("Could not record Stripe event:", err.message);
    return res.status(500).json({ error: "Could not record event" });
  }

  // ---- Dispatch ----
  // Handled synchronously rather than acknowledged-then-queued: the critical
  // path is a handful of inserts in one transaction, and doing it inline keeps
  // Stripe's retry as a real safety net. Returning 200 first would throw that
  // away — a failed write would look delivered and never come back.
  try {
    let outcome = { handled: false };

    switch (event.type) {
      case "payment_intent.succeeded":
        outcome = await handlePaymentIntentSucceeded(event.data.object);
        break;

      case "payment_intent.payment_failed": {
        const pi = event.data.object;
        const reason = pi.last_payment_error?.message || "Card was declined";
        const n = await markPendingCheckoutFailed(pi.id, reason);
        outcome = { handled: true, markedFailed: n };
        break;
      }

      case "terminal.reader.action_failed": {
        // The reader itself could not complete — customer cancelled at the
        // reader, timed out, or the device errored. Same outcome as a decline:
        // close the attempt, write nothing.
        const reader = event.data.object;
        const action = reader.action || {};
        const piId = action.process_payment_intent?.payment_intent || null;
        const reason = action.failure_message || action.failure_code || "Reader action failed";
        const n = piId ? await markPendingCheckoutFailed(piId, reason) : 0;
        outcome = { handled: true, markedFailed: n, paymentIntentId: piId };
        break;
      }

      case "terminal.reader.action_succeeded":
        // Informational only. The reader finishing its action is not the same
        // as money being captured — payment_intent.succeeded is the event that
        // creates the order, and it is the only one that may. (A reader-driven
        // Interac refund settles through the refund.* events below.)
        outcome = { handled: true, informational: true };
        break;

      // ---- Refund settlement (Slice 7) ----
      // These are what actually promote a reversal from 'pending' to money
      // returned. Until one arrives, settledPaymentsWhere() ignores the
      // negative row entirely, so an in-flight or rejected refund never
      // becomes a deduction in any report.
      case "refund.created":
      case "refund.updated":
      case "refund.failed":
        outcome = await applyStripeRefundOutcome(event.data.object);
        break;

      case "charge.refunded": {
        // Fallback path: a charge-level event carrying the refunds inline.
        // Same resolver, so a refund settled here behaves identically.
        const charge = event.data.object;
        const refunds = charge.refunds?.data || [];
        const applied = [];
        for (const r of refunds) {
          applied.push(await applyStripeRefundOutcome({ ...r, payment_intent: r.payment_intent || charge.payment_intent }));
        }
        outcome = { handled: true, refunds: applied };
        break;
      }

      default:
        // Refund events land here for now and are handled in Slice 7. Recorded
        // in stripe_events either way, so nothing is lost.
        outcome = { handled: false, reason: "unhandled_event_type" };
    }

    await pool
      .query("UPDATE stripe_events SET processed_at = now(), process_error = NULL WHERE id = $1", [
        event.id,
      ])
      .catch((e) => console.error("Could not mark event processed:", e.message));

    return res.json({ received: true, ...outcome });
  } catch (err) {
    console.error(`Stripe webhook handler failed for ${event.id} (${event.type}):`, err.message);
    await pool
      .query("UPDATE stripe_events SET process_error = $2 WHERE id = $1", [
        event.id,
        String(err.message).slice(0, 1000),
      ])
      .catch(() => {});
    // 500 so Stripe redelivers; processed_at stays NULL so the retry is allowed
    // back through the dedup check above.
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

// Prices and validates a whole cart server-side, from the database, and
// returns a fully-priced snapshot. Extracted from the checkout route so that
// Cash (which inserts an order synchronously) and Card-under-Stripe (which
// freezes this snapshot onto a pending_checkouts row and charges the reader)
// price through EXACTLY the same code. That shared path is the point: the
// amount a customer is charged at the reader and the amount an order is
// eventually written for cannot drift apart, because they are computed once,
// here, from the menu — never from the request.
//
// Throws HttpError on any validation failure; the caller rolls back and
// surfaces the message unchanged.
async function priceCart(client, { staffId, items, discountPercent, discountReason }) {
  // ---- Resolve staff + location (source of the tax rate) ----
  const { rows: staffRows } = await client.query(
    "SELECT id, location_id FROM staff WHERE id = $1 AND active = true",
    [staffId]
  );
  if (staffRows.length === 0) {
    throw new HttpError(400, "Unknown or inactive staff member");
  }
  const staff = staffRows[0];

  // Owners have location_id = NULL (all locations) — fall back to the
  // single active location for a concrete order/tax context.
  const locResult = staff.location_id
    ? await client.query("SELECT id, tax_rate FROM locations WHERE id = $1", [staff.location_id])
    : await client.query(
        "SELECT id, tax_rate FROM locations WHERE active = true ORDER BY created_at LIMIT 1"
      );
  if (locResult.rows.length === 0) {
    throw new HttpError(400, "No location available for this order");
  }
  const location = locResult.rows[0];
  const taxRate = parseFloat(location.tax_rate);

  // ---- Recompute every line from the database ----
  // We build a fully-priced structure first (validating as we go), then
  // do the inserts. Nothing is written until all lines pass validation.
  const pricedLines = [];
  let subtotal = 0;

  for (let i = 0; i < items.length; i++) {
    const line = items[i] || {};
    const { itemId, variantId, modifiers, addons, notes } = line;
    const quantity = Number(line.quantity);

    if (!itemId || typeof itemId !== "string") {
      throw new HttpError(400, `Line ${i + 1}: itemId is required`);
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new HttpError(400, `Line ${i + 1}: quantity must be a positive integer`);
    }

    // Menu item (authoritative base price)
    const { rows: itemRows } = await client.query(
      "SELECT id, name, base_price FROM menu_items WHERE id = $1 AND active = true",
      [itemId]
    );
    if (itemRows.length === 0) {
      throw new HttpError(400, `Line ${i + 1}: menu item not found or unavailable`);
    }
    const menuItem = itemRows[0];

    // Base unit price = variant price (if any) else item base_price
    let unitPrice = parseFloat(menuItem.base_price);

    // Does this item have active variants? If so, a variant is required.
    const { rows: itemVariants } = await client.query(
      "SELECT id, price FROM item_variants WHERE item_id = $1 AND active = true",
      [itemId]
    );
    let resolvedVariantId = null;
    if (itemVariants.length > 0) {
      if (!variantId) {
        throw new HttpError(400, `Line ${i + 1}: "${menuItem.name}" requires a variant selection`);
      }
      const variant = itemVariants.find((v) => v.id === variantId);
      if (!variant) {
        throw new HttpError(400, `Line ${i + 1}: invalid variant for "${menuItem.name}"`);
      }
      unitPrice = parseFloat(variant.price);
      resolvedVariantId = variant.id;
    } else if (variantId) {
      throw new HttpError(400, `Line ${i + 1}: "${menuItem.name}" has no variants`);
    }

    // ---- Modifiers ----
    // Which modifier groups are valid for this item?
    const { rows: itemGroups } = await client.query(
      `SELECT mg.id, mg.name, mg.min_select, mg.max_select, mg.required
         FROM item_modifier_groups img
         JOIN modifier_groups mg ON mg.id = img.modifier_group_id
        WHERE img.item_id = $1`,
      [itemId]
    );
    const groupById = new Map(itemGroups.map((g) => [g.id, g]));
    const selectedPerGroup = new Map(); // groupId -> count of distinct selected options

    const pricedModifiers = [];
    const submittedMods = Array.isArray(modifiers) ? modifiers : [];
    for (const mod of submittedMods) {
      const optionId = mod?.optionId;
      const modQty = Number(mod?.quantity);
      if (!optionId || typeof optionId !== "string") {
        throw new HttpError(400, `Line ${i + 1}: modifier optionId is required`);
      }
      if (!Number.isInteger(modQty) || modQty < 1) {
        throw new HttpError(400, `Line ${i + 1}: modifier quantity must be a positive integer`);
      }

      const { rows: optRows } = await client.query(
        "SELECT id, group_id, price_delta, max_quantity FROM modifier_options WHERE id = $1 AND active = true",
        [optionId]
      );
      if (optRows.length === 0) {
        throw new HttpError(400, `Line ${i + 1}: modifier option not found`);
      }
      const opt = optRows[0];

      // The option's group must actually apply to this item
      if (!groupById.has(opt.group_id)) {
        throw new HttpError(400, `Line ${i + 1}: modifier does not belong to "${menuItem.name}"`);
      }
      const maxQ = opt.max_quantity || 1;
      if (modQty > maxQ) {
        throw new HttpError(400, `Line ${i + 1}: modifier quantity exceeds its limit`);
      }

      selectedPerGroup.set(opt.group_id, (selectedPerGroup.get(opt.group_id) || 0) + 1);
      const priceDelta = parseFloat(opt.price_delta);
      unitPrice += priceDelta * modQty;
      pricedModifiers.push({ optionId: opt.id, priceDelta, quantity: modQty });
    }

    // Enforce each group's min/max selection rules
    for (const g of itemGroups) {
      const count = selectedPerGroup.get(g.id) || 0;
      if (g.required && count < g.min_select) {
        throw new HttpError(
          400,
          `Line ${i + 1}: "${g.name}" requires at least ${g.min_select} selection${g.min_select > 1 ? "s" : ""}`
        );
      }
      if (count > g.max_select) {
        throw new HttpError(400, `Line ${i + 1}: "${g.name}" allows at most ${g.max_select}`);
      }
    }

    // ---- Add-ons ----
    // Driven by the item's actual add-ons in the DB (authoritative), so
    // complimentary items are always recorded even if the client omits them.
    // Paid extras come from the extraQty the client submitted per add-on.
    const { rows: itemAddons } = await client.query(
      `SELECT ia.id, ia.addon_item_id, ia.included_quantity, ia.extra_price,
              mi.base_price AS addon_base_price
         FROM item_addons ia
         JOIN menu_items mi ON mi.id = ia.addon_item_id
        WHERE ia.item_id = $1`,
      [itemId]
    );
    const submittedAddons = Array.isArray(addons) ? addons : [];
    const extraByAddonId = new Map();
    for (const a of submittedAddons) {
      if (!a || typeof a.addonId !== "string") continue;
      const extraQty = Number(a.extraQty) || 0;
      if (!Number.isInteger(extraQty) || extraQty < 0) {
        throw new HttpError(400, `Line ${i + 1}: addon extraQty must be a non-negative integer`);
      }
      // Reject add-ons that don't belong to this item
      if (!itemAddons.some((ia) => ia.id === a.addonId)) {
        throw new HttpError(400, `Line ${i + 1}: addon does not belong to "${menuItem.name}"`);
      }
      extraByAddonId.set(a.addonId, extraQty);
    }

    const pricedAddons = [];
    for (const ia of itemAddons) {
      const extraUnitPrice =
        ia.extra_price != null ? parseFloat(ia.extra_price) : parseFloat(ia.addon_base_price);
      const includedQty = ia.included_quantity;
      const extraQty = extraByAddonId.get(ia.id) || 0;

      // Complimentary portion (free, recorded for the kitchen)
      if (includedQty > 0) {
        pricedAddons.push({
          addonItemId: ia.addon_item_id,
          quantity: includedQty,
          unitPrice: 0,
          isComplimentary: true,
        });
      }
      // Paid extras beyond the included quantity
      if (extraQty > 0) {
        unitPrice += extraUnitPrice * extraQty;
        pricedAddons.push({
          addonItemId: ia.addon_item_id,
          quantity: extraQty,
          unitPrice: round2(extraUnitPrice),
          isComplimentary: false,
        });
      }
    }

    unitPrice = round2(unitPrice);
    subtotal += unitPrice * quantity;

    pricedLines.push({
      itemId: menuItem.id,
      variantId: resolvedVariantId,
      quantity,
      unitPrice,
      notes: typeof notes === "string" && notes.trim() ? notes.trim() : null,
      modifiers: pricedModifiers,
      addons: pricedAddons,
    });
  }

  // ---- Totals ----
  // subtotal here is the recomputed pre-discount list price. The discount
  // dollar amount is ALWAYS derived server-side from (subtotal × percent)
  // — the client only ever supplies the percent + reason, never a dollar
  // figure. Tax is charged on the discounted amount (matches how HST is
  // actually applied at point of sale when a % discount is given).
  subtotal = round2(subtotal);
  const discountAmount = discountPercent ? round2(subtotal * (discountPercent / 100)) : 0;
  const discountedSubtotal = round2(subtotal - discountAmount);
  const tax = round2(discountedSubtotal * taxRate);
  // Still 0 here by construction: with on-reader tipping the tip is not known
  // until the customer has tipped, so it is added when the order is written
  // from the webhook (Slice 2), never at pricing time.
  const tip = 0;
  const total = round2(discountedSubtotal + tax + tip);

  return {
    staff,
    location,
    taxRate,
    pricedLines,
    subtotal,
    discountAmount,
    discountPercent,
    discountReason,
    tax,
    tip,
    total,
  };
}

app.post("/api/orders", requireDevicePairing, async (req, res) => {
  const { staffId, paymentMethod, items, discount } = req.body || {};

  // ---- Shape validation (cheap checks before touching the DB) ----
  if (!staffId || typeof staffId !== "string") {
    return res.status(400).json({ error: "staffId is required" });
  }
  if (paymentMethod !== "cash" && paymentMethod !== "card") {
    return res.status(400).json({ error: "paymentMethod must be 'cash' or 'card'" });
  }

  // ---- Discount validation ----
  // Same never-trust-the-client principle as pricing: the client may send a
  // percent + reason, but never a dollar amount — that's always recomputed
  // below from the server-side subtotal. If a percent is present, a valid
  // reason is REQUIRED (checkout is rejected otherwise); if discount is
  // omitted entirely, no discount is applied.
  let discountPercent = null;
  let discountReason = null;
  if (discount !== undefined && discount !== null) {
    if (typeof discount !== "object" || Array.isArray(discount)) {
      return res.status(400).json({ error: "discount must be an object with percent and reason" });
    }
    const percent = Number(discount.percent);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      return res.status(400).json({ error: "discount.percent must be between 0 and 100" });
    }
    if (!DISCOUNT_REASONS.includes(discount.reason)) {
      return res.status(400).json({
        error: `discount.reason is required when a discount is applied, and must be one of: ${DISCOUNT_REASONS.join(", ")}`,
      });
    }
    discountPercent = percent;
    discountReason = discount.reason;
    if (discountPercent >= DISCOUNT_FLAG_THRESHOLD) {
      // Not blocked — but logged so a 50%+ discount is never silently
      // invisible. It's also permanently visible afterward via
      // orders.discount_percent/discount_reason on the stored order itself.
      console.warn(
        `High discount applied: ${discountPercent}% (reason: ${discountReason}) by staffId=${staffId}`
      );
    }
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Order must contain at least one item" });
  }

  const client = await pool.connect();
  // Set only on the Stripe-card path, and only once its row is committed —
  // the Stripe calls then happen after the transaction closes (see
  // startTerminalPayment).
  let pendingForReader = null;
  let committed = false;
  try {
    await client.query("BEGIN");

    // ---- Price + validate the whole cart (shared by Cash and Card) ----
    const priced = await priceCart(client, {
      staffId,
      items,
      discountPercent,
      discountReason,
    });
    const { staff, location, pricedLines, subtotal, discountAmount, tax, tip, total } = priced;

    // ---- Card under real Stripe: freeze the cart, create NO order ----
    // Decision D1 (Option B): the orders + payments rows are written only when
    // the success webhook arrives, so a declined or abandoned checkout leaves
    // nothing behind — nothing on the KDS, nothing in pos-recall, and no
    // phantom 'cancelled' order in the Transaction Log. What is written here is
    // the frozen priced snapshot (D2), which is authoritative from this moment
    // on: a price edit in Manage Menu while the customer is tapping must never
    // change what they are charged.
    if (isStripeCardCheckout(paymentMethod)) {
      if (!stripeClient) {
        // Unreachable in practice: PAYMENTS_PROVIDER=stripe already requires a
        // key at boot. Fails loudly rather than silently falling back to the
        // mocked path and recording a sale nobody paid for.
        throw new HttpError(503, "Card payments are enabled but Stripe is not configured on this server");
      }
      const readerId = await resolveReaderForDevice(client, req.deviceId);

      const { rows: pcRows } = await client.query(
        `INSERT INTO pending_checkouts
           (location_id, staff_id, device_id, payload, subtotal, discount,
            discount_percent, discount_reason, tax, total, stripe_reader_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          location.id,
          staff.id,
          req.deviceId,
          JSON.stringify({
            lines: pricedLines,
            discountAppliedBy: discountPercent ? staff.id : null,
          }),
          subtotal,
          discountAmount,
          discountPercent,
          discountReason,
          tax,
          total,
          readerId,
        ]
      );

      await client.query("COMMIT");
      committed = true;
      pendingForReader = {
        id: pcRows[0].id,
        readerId,
        locationId: location.id,
        staffId: staff.id,
        subtotal,
        discount: discountAmount,
        tax,
        total,
      };
    } else {
      // ---- Cash, and Card under mock: unchanged synchronous path ----

      // ---- Insert order ----
      const { rows: orderRows } = await client.query(
        `INSERT INTO orders (location_id, staff_id, status, subtotal, tax, tip, total,
                              discount, discount_percent, discount_reason, discount_applied_by)
         VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, order_number`,
        [
          location.id,
          staff.id,
          subtotal,
          tax,
          tip,
          total,
          discountAmount,
          discountPercent,
          discountReason,
          discountPercent ? staff.id : null,
        ]
      );
      const order = orderRows[0];

      // ---- Insert lines, modifiers, addons ----
      for (const line of pricedLines) {
        const { rows: oiRows } = await client.query(
          `INSERT INTO order_items (order_id, item_id, variant_id, quantity, unit_price, notes)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [order.id, line.itemId, line.variantId, line.quantity, line.unitPrice, line.notes]
        );
        const orderItemId = oiRows[0].id;

        for (const mod of line.modifiers) {
          await client.query(
            `INSERT INTO order_item_modifiers (order_item_id, modifier_option_id, price_delta, quantity)
             VALUES ($1, $2, $3, $4)`,
            [orderItemId, mod.optionId, mod.priceDelta, mod.quantity]
          );
        }

        for (const addon of line.addons) {
          await client.query(
            `INSERT INTO order_item_addons (order_item_id, addon_item_id, quantity, unit_price, is_complimentary)
             VALUES ($1, $2, $3, $4, $5)`,
            [orderItemId, addon.addonItemId, addon.quantity, addon.unitPrice, addon.isComplimentary]
          );
        }
      }

      // ---- Insert payment (mocked — captured immediately, no processor) ----
      await client.query(
        `INSERT INTO payments (order_id, method, amount, status)
         VALUES ($1, $2, $3, 'captured')`,
        [order.id, paymentMethod, total]
      );

      await client.query("COMMIT");
      return res.status(201).json({
        id: order.id,
        order_number: order.order_number,
        subtotal,
        discount: discountAmount,
        discount_percent: discountPercent,
        discount_reason: discountReason,
        tax,
        tip,
        total,
      });
    }
  } catch (err) {
    // The Stripe path commits before it leaves this block; rolling back after
    // a successful COMMIT would only log a spurious "no transaction in
    // progress" warning.
    if (!committed) {
      await client.query("ROLLBACK").catch(() => {});
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Order creation failed:", err);
    return res.status(500).json({ error: "Failed to create order" });
  } finally {
    client.release();
  }

  // Only reachable on the Stripe-card path: the pending checkout is committed
  // and the pooled connection is released, so the Stripe round-trips below hold
  // no database resources.
  return startTerminalPayment(res, pendingForReader);
});

// --------------- Kitchen Display System (KDS) ---------------
// These two routes are additive and intentionally price/customer-free.
// KDS is a no-auth "open book" screen, so neither route has auth middleware.

// Fetch orders (by id) in the nested shape the KDS renders. Deliberately
// omits ALL prices + customer/payment fields — the kitchen never sees those.
// Orders are returned in the SAME order as `orderIds` — the caller decides
// sort (the live queue passes FIFO oldest-first; history passes most-recent
// -first). A planned elapsed-time UI depends on the live queue's ordering, so
// don't change the caller's sort there without flagging.
// Pass { includeCompletedAt: true } to add completed_at to each order (used by
// history); the live queue omits it to keep its response unchanged.
//
// Per item we split the modifiers into distinct buckets:
//   - selected_options[]: choices from REQUIRED groups (Format=Burrito/Bowl,
//     Base=Nachos/Fries, Protein, Choose 3 Proteins, ...) — these define what
//     the item fundamentally IS, so they get { group, choice } and are never
//     run through the optional add/remove diff. One entry per choice made.
//   - removed_ingredients[]: default options from NON-required groups with NO
//     matching order row (the "NO onions" cases) — name only
//   - added_modifiers[]: non-default options from NON-required groups present
//     on the line — name + quantity, no price
//   - addons[]: name, quantity, is_complimentary — no price
// Kept defaults (default AND present) are the normal build and appear in none
// of these. All output is price-free.
async function fetchKdsOrders(client, orderIds, { includeCompletedAt = false } = {}) {
  if (orderIds.length === 0) return [];

  const { rows: orders } = await client.query(
    `SELECT id, order_number, status, fulfillment_type, created_at, completed_at,
            voided_from_status, void_acknowledged_at
       FROM orders
      WHERE id = ANY($1::uuid[])`,
    [orderIds]
  );

  const { rows: items } = await client.query(
    `SELECT oi.id, oi.order_id, oi.item_id, oi.variant_id, oi.quantity, oi.notes, oi.status,
            mi.name AS item_name, iv.name AS variant_name
       FROM order_items oi
       JOIN menu_items mi ON mi.id = oi.item_id
       LEFT JOIN item_variants iv ON iv.id = oi.variant_id
      WHERE oi.order_id = ANY($1::uuid[])
      ORDER BY oi.created_at ASC`,
    [orderIds]
  );

  const itemIds = items.map((i) => i.id);
  const menuItemIds = [...new Set(items.map((i) => i.item_id))];

  // Modifiers actually on each order line, tagged with their group's name +
  // required flag (to split required choices out) and whether they're a
  // default (standard) ingredient or a customer addition.
  const { rows: mods } = itemIds.length
    ? await client.query(
        `SELECT oim.order_item_id, oim.modifier_option_id,
                mo.name AS option_name, mo.default_selected, oim.quantity,
                mg.name AS group_name, mg.required AS group_required
           FROM order_item_modifiers oim
           JOIN modifier_options mo ON mo.id = oim.modifier_option_id
           JOIN modifier_groups mg ON mg.id = mo.group_id
          WHERE oim.order_item_id = ANY($1::uuid[])
          ORDER BY mo.sort_order`,
        [itemIds]
      )
    : { rows: [] };

  // The default modifier set for each menu item (config, not order-specific):
  // every option flagged default_selected in a NON-required group linked to
  // that item. Required groups are excluded here so a mutually-exclusive
  // choice can never be reported as a "removed" ingredient.
  const { rows: defaults } = menuItemIds.length
    ? await client.query(
        `SELECT img.item_id, mo.id AS option_id, mo.name AS option_name
           FROM item_modifier_groups img
           JOIN modifier_groups mg ON mg.id = img.modifier_group_id
           JOIN modifier_options mo ON mo.group_id = mg.id
          WHERE img.item_id = ANY($1::uuid[])
            AND mg.required = false
            AND mo.default_selected = true
            AND mo.active = true
          ORDER BY mo.sort_order`,
        [menuItemIds]
      )
    : { rows: [] };

  const { rows: addons } = itemIds.length
    ? await client.query(
        `SELECT oa.order_item_id, mi.name AS addon_name,
                oa.quantity, oa.is_complimentary
           FROM order_item_addons oa
           JOIN menu_items mi ON mi.id = oa.addon_item_id
          WHERE oa.order_item_id = ANY($1::uuid[])
          ORDER BY oa.is_complimentary DESC`,
        [itemIds]
      )
    : { rows: [] };

  // Per order line: option ids present, required-group choices, and the added
  // (non-default, non-required) modifiers.
  const presentOptByItem = {}; // order_item_id -> Set(option_id)
  const selectedByItem = {}; // order_item_id -> [{ group, choice }]
  const addedByItem = {}; // order_item_id -> [{ name, quantity }]
  // Raw modifier ids+quantities per line — the KDS Fast Mode grouping key
  // (two items only aggregate if item_id + variant_id + this set all match).
  const rawModsByItem = {}; // order_item_id -> [{ option_id, quantity }]
  for (const m of mods) {
    (presentOptByItem[m.order_item_id] ||= new Set()).add(m.modifier_option_id);
    (rawModsByItem[m.order_item_id] ||= []).push({
      option_id: m.modifier_option_id,
      quantity: m.quantity,
    });
    if (m.group_required) {
      // Required choice — defines what the item IS. Surfaced on its own; never
      // an optional add and never a removal. One entry per choice made.
      (selectedByItem[m.order_item_id] ||= []).push({
        group: m.group_name,
        choice: m.option_name,
      });
    } else if (!m.default_selected) {
      (addedByItem[m.order_item_id] ||= []).push({
        name: m.option_name,
        quantity: m.quantity,
      });
    }
  }

  // Per menu item: its full default option set (for the removed-ingredient diff).
  const defaultsByMenuItem = {}; // item_id -> [{ option_id, name }]
  for (const d of defaults) {
    (defaultsByMenuItem[d.item_id] ||= []).push({
      option_id: d.option_id,
      name: d.option_name,
    });
  }

  const addonsByItem = {};
  for (const a of addons) {
    (addonsByItem[a.order_item_id] ||= []).push({
      name: a.addon_name,
      quantity: a.quantity,
      is_complimentary: a.is_complimentary,
    });
  }

  const itemsByOrder = {};
  for (const it of items) {
    const present = presentOptByItem[it.id] || new Set();
    const itemDefaults = defaultsByMenuItem[it.item_id] || [];
    const removed_ingredients = itemDefaults
      .filter((d) => !present.has(d.option_id))
      .map((d) => d.name);

    (itemsByOrder[it.order_id] ||= []).push({
      id: it.id,
      // item_id / variant_id / modifiers_raw exist for Fast Mode's exact
      // grouping key; the ticket view ignores them (additive fields only).
      item_id: it.item_id,
      variant_id: it.variant_id,
      modifiers_raw: rawModsByItem[it.id] || [],
      name: it.item_name,
      variant: it.variant_name, // null when the item has no variant
      quantity: it.quantity,
      notes: it.notes,
      status: it.status,
      selected_options: selectedByItem[it.id] || [],
      removed_ingredients,
      added_modifiers: addedByItem[it.id] || [],
      addons: addonsByItem[it.id] || [],
    });
  }

  // Build a lookup, then emit in the caller's requested order (order of orderIds).
  const byId = {};
  for (const o of orders) {
    byId[o.id] = {
      id: o.id,
      order_number: o.order_number,
      status: o.status,
      fulfillment_type: o.fulfillment_type,
      created_at: o.created_at,
      ...(includeCompletedAt ? { completed_at: o.completed_at } : {}),
      // Void context (Slice 5). `voided` is the flag the KDS renders off;
      // voided_from_status says whether the kitchen ever saw the ticket.
      voided: o.status === "cancelled",
      voided_from_status: o.voided_from_status,
      void_acknowledged_at: o.void_acknowledged_at,
      items: itemsByOrder[o.id] || [],
    };
  }
  return orderIds.map((id) => byId[id]).filter(Boolean);
}

const KDS_ALLOWED_STATUSES = ["open", "preparing", "ready", "completed", "cancelled"];

// GET /api/orders?status=open,preparing  (defaults to open,preparing)
app.get("/api/orders", requireDevicePairing, async (req, res) => {
  const statusParam = (req.query.status ?? "open,preparing").toString();
  const statuses = statusParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const invalid = statuses.filter((s) => !KDS_ALLOWED_STATUSES.includes(s));
  if (statuses.length === 0 || invalid.length > 0) {
    return res.status(400).json({
      error:
        invalid.length > 0
          ? `Invalid status value(s): ${invalid.join(", ")}`
          : "No status values provided",
    });
  }

  const client = await pool.connect();
  try {
    // KDS is per-location; today there is a single active location.
    const { rows: locRows } = await client.query(
      "SELECT id FROM locations WHERE active = true ORDER BY created_at LIMIT 1"
    );
    if (locRows.length === 0) {
      return res.status(500).json({ error: "No active location" });
    }
    const locationId = locRows[0].id;

    // Live statuses match plainly. 'cancelled' is special (Slice 5): a voided
    // order only belongs on the board if the kitchen was ALREADY cooking it
    // (voided_from_status in preparing/ready — a void of an 'open' order never
    // reached the line) and has not yet acknowledged it. Voided tickets are
    // dismissed by hand, so an acknowledged one leaves the board permanently
    // and reappears only in history.
    const liveStatuses = statuses.filter((s) => s !== "cancelled");
    const wantsVoided = statuses.includes("cancelled");

    const { rows: idRows } = await client.query(
      `SELECT id FROM orders
        WHERE location_id = $1
          AND ( ($2::text[] <> '{}' AND status::text = ANY($2::text[]))
             OR ($3::boolean
                 AND status = 'cancelled'
                 AND voided_from_status IN ('preparing', 'ready')
                 AND void_acknowledged_at IS NULL) )
        ORDER BY created_at ASC`, // FIFO oldest-first
      [locationId, liveStatuses, wantsVoided]
    );

    const orders = await fetchKdsOrders(client, idRows.map((r) => r.id));
    res.json(orders);
  } catch (err) {
    console.error("KDS list failed:", err.message);
    res.status(500).json({ error: "Failed to fetch orders" });
  } finally {
    client.release();
  }
});

// GET /api/orders/history?sinceHours=4  (default 4)
// Recently-completed (status='ready') orders whose completed_at falls within
// the last N hours, MOST-RECENT-FIRST (opposite of the live queue). Same nested
// price-free shape, plus created_at + completed_at so the frontend can compute
// prep time (placed → ready). No auth, single active location.
app.get("/api/orders/history", requireDevicePairing, async (req, res) => {
  const sinceHours = req.query.sinceHours === undefined ? 4 : Number(req.query.sinceHours);
  if (!Number.isFinite(sinceHours) || sinceHours <= 0) {
    return res.status(400).json({ error: "sinceHours must be a positive number" });
  }

  const client = await pool.connect();
  try {
    const { rows: locRows } = await client.query(
      "SELECT id FROM locations WHERE active = true ORDER BY created_at LIMIT 1"
    );
    if (locRows.length === 0) {
      return res.status(500).json({ error: "No active location" });
    }
    const locationId = locRows[0].id;

    // Completed orders, plus (Slice 5) voided tickets the kitchen has already
    // acknowledged — a void stays visible here marked as voided rather than
    // vanishing off the board without trace. Only voids that actually reached
    // the kitchen appear; one voided while still 'open' was never the
    // kitchen's business. A voided order may have no completed_at (it was
    // cancelled mid-prep), so the window and sort fall back to created_at.
    const { rows: idRows } = await client.query(
      `SELECT id FROM orders
        WHERE location_id = $1
          AND ( ( status = 'ready'
                  AND completed_at >= now() - ($2::numeric * interval '1 hour') )
             OR ( status = 'cancelled'
                  AND voided_from_status IN ('preparing', 'ready')
                  AND void_acknowledged_at IS NOT NULL
                  AND COALESCE(completed_at, created_at)
                        >= now() - ($2::numeric * interval '1 hour') ) )
        ORDER BY COALESCE(completed_at, created_at) DESC`, // most-recent-first
      [locationId, sinceHours]
    );

    const orders = await fetchKdsOrders(client, idRows.map((r) => r.id), {
      includeCompletedAt: true,
    });
    res.json(orders);
  } catch (err) {
    console.error("KDS history failed:", err.message);
    res.status(500).json({ error: "Failed to fetch order history" });
  } finally {
    client.release();
  }
});

// POST /api/orders/:id/acknowledge-void   (KDS — device-paired, no staff auth)
// Kitchen staff dismissing a VOIDED ticket from the board. Voided tickets are
// NEVER auto-cleared on a timer — someone has to actively confirm they've seen
// it and stopped cooking — so this is the only way one leaves the board. The
// acknowledgement is persisted (not client-side) so it survives a reload and
// clears the ticket on every KDS device at once. Idempotent: acknowledging an
// already-acknowledged ticket is a no-op, which makes a double-tap harmless.
app.post("/api/orders/:id/acknowledge-void", requireDevicePairing, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE orders
          SET void_acknowledged_at = COALESCE(void_acknowledged_at, now())
        WHERE id = $1 AND status = 'cancelled'
        RETURNING id, order_number, void_acknowledged_at`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "No voided order with that id" });
    }
    res.json({
      id: rows[0].id,
      order_number: rows[0].order_number,
      void_acknowledged_at: rows[0].void_acknowledged_at,
    });
  } catch (err) {
    console.error("Void acknowledge failed:", err.message);
    res.status(500).json({ error: "Failed to acknowledge voided order" });
  }
});

// PATCH /api/orders/:id/status   body: { status: "preparing" | "ready" }
// Advances the whole order one step and keeps order_items.status in lockstep,
// all inside one transaction so the two can never drift out of sync.
app.patch("/api/orders/:id/status", requireDevicePairing, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};

  if (status !== "preparing" && status !== "ready") {
    return res.status(400).json({ error: "status must be 'preparing' or 'ready'" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the order row for the duration of the transition
    const { rows } = await client.query(
      "SELECT status FROM orders WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const current = rows[0].status;
    // Only forward, one step at a time: open→preparing, preparing→ready
    const allowed =
      (current === "open" && status === "preparing") ||
      (current === "preparing" && status === "ready");
    if (!allowed) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `Cannot transition order from '${current}' to '${status}'`,
      });
    }

    // Update the order. 'ready' is treated as complete → stamp completed_at.
    if (status === "ready") {
      await client.query(
        "UPDATE orders SET status = $1, completed_at = now() WHERE id = $2",
        [status, id]
      );
    } else {
      await client.query("UPDATE orders SET status = $1 WHERE id = $2", [status, id]);
    }

    // Cascade the same status to every line (no per-item status in this UI —
    // order_items.status must always match orders.status after this call).
    // Mapping is 1:1: preparing→preparing, ready→ready.
    await client.query("UPDATE order_items SET status = $1 WHERE order_id = $2", [
      status,
      id,
    ]);

    await client.query("COMMIT");

    const [order] = await fetchKdsOrders(client, [id]);
    res.json(order);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("KDS status update failed:", err.message);
    res.status(500).json({ error: "Failed to update order status" });
  } finally {
    client.release();
  }
});

// PATCH /api/orders/:id/status/revert
// Reverses the most recent status change: preparing→open, ready→preparing.
// Mirrors the forward endpoint's transactional lockstep pattern.
app.patch("/api/orders/:id/status/revert", requireDevicePairing, async (req, res) => {
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT status FROM orders WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const current = rows[0].status;
    // Only one step back: preparing→open, ready→preparing
    const PREV_STATUS = { preparing: "open", ready: "preparing" };
    const prev = PREV_STATUS[current];
    if (!prev) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `Cannot revert order from '${current}' — no previous state`,
      });
    }

    // Revert the order. If reverting from 'ready', clear completed_at.
    if (current === "ready") {
      await client.query(
        "UPDATE orders SET status = $1, completed_at = NULL WHERE id = $2",
        [prev, id]
      );
    } else {
      await client.query("UPDATE orders SET status = $1 WHERE id = $2", [prev, id]);
    }

    // Cascade to order_items (same lockstep as the forward endpoint).
    // Mapping: open→pending, preparing→preparing (but we're going back,
    // so preparing→open means items go back to 'pending').
    const itemStatus = prev === "open" ? "pending" : "preparing";
    await client.query("UPDATE order_items SET status = $1 WHERE order_id = $2", [
      itemStatus,
      id,
    ]);

    await client.query("COMMIT");

    const [order] = await fetchKdsOrders(client, [id]);
    res.json(order);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("KDS status revert failed:", err.message);
    res.status(500).json({ error: "Failed to revert order status" });
  } finally {
    client.release();
  }
});

// --------------- Refunds & Voids ---------------
// See docs/architecture/refunds-plan.md. Two reversal types:
//   - VOID   — erase a sale that should never have counted; full-order only;
//              sets orders.status='cancelled' so it drops out of every report
//              (all report queries already filter status='ready').
//   - REFUND — return money on a standing (ready) sale; full, partial-by-
//              amount, or line-item; the order stays 'ready' and remains in
//              gross/net/tax, the refund is a deduction from money collected.
// The MONEY lives in the existing payments ledger: every reversal writes a
// negative payments row (status='refunded', amount=−refunded, refund_id → the
// audit record), so SUM(payments.amount) over settled rows (settledPaymentsWhere:
// captured + refunded) is net collected by construction and every report
// reconciles through one predicate. order_refunds holds the audit + forward-
// looking Stripe fields, and order_refund_items the optional per-line detail
// for a line-item refund — whose amount is priced here from the order's own
// unit_price rows, never taken from the request.
// The original capture behind an order — what was paid, and how. Drives the
// whole Slice 7 settlement decision: whether money has to go back through
// Stripe at all, and if so by which route.
async function loadOriginalPayment(client, orderId) {
  const { rows } = await client.query(
    `SELECT method, processor_txn_id, processor_payment_type
       FROM payments
      WHERE order_id = $1 AND refund_id IS NULL
      ORDER BY created_at
      LIMIT 1`,
    [orderId]
  );
  const p = rows[0];
  return {
    method: p ? p.method : "other",
    processorTxnId: p ? p.processor_txn_id : null,
    processorPaymentType: p ? p.processor_payment_type : null,
  };
}

// Decides how a reversal actually settles (decision D5). Pure policy, kept
// separate so the rule is readable in one place rather than inferred from
// branches scattered through the write path.
//
//   internal      — no processor involved. A cash sale, or a pre-Stripe mock
//                   card sale. Settles instantly, exactly as it always has.
//   internal_cash — an explicit cash-out of a CARD sale. The money goes back
//                   over the counter in notes, so the ledger records 'cash'
//                   and Stripe is never called. This is the escape hatch for
//                   an Interac customer who cannot return with their card.
//   stripe_api    — credit card_present. Refundable remotely, no customer
//                   present, so Back Office can issue it days later.
//   stripe_reader — interac_present. The network requires the physical card
//                   at the reader, so this is only possible at the POS with
//                   the customer standing there.
function decideRefundSettlement({ original, surface, refundMethod, readerId }) {
  if (refundMethod === "cash") return "internal_cash";

  const isStripeSale = original.method === "card" && Boolean(original.processorTxnId);
  if (!isStripeSale) return "internal";

  if (original.processorPaymentType === "interac_present") {
    if (surface !== "pos") {
      throw new HttpError(
        409,
        "This was an Interac payment, which can only be refunded to the card at the reader. " +
          "Ask the customer to return to the counter with their card, or issue a cash refund instead."
      );
    }
    if (!readerId) {
      throw new HttpError(
        409,
        "This Interac payment must be refunded at the reader, but no card reader is assigned to this till. " +
          "Assign one in Back Office → Devices, or issue a cash refund instead."
      );
    }
    return "stripe_reader";
  }

  return "stripe_api";
}

async function applyRefund(client, {
  orderId, type, reason, reasonNote, amount, items, requestedBy, approvedBy, approverRole,
  selfApproved = false,
  // Slice 7. `surface` decides whether an Interac card refund is even possible
  // (the customer has to be present); `refundMethod: 'cash'` is the explicit
  // cash-out; `readerId` is the till's bound reader for a card-present refund.
  surface = "pos", refundMethod = null, readerId = null,
}) {
  if (!REFUND_TYPES.includes(type)) {
    throw new HttpError(400, "type must be 'void' or 'refund'");
  }
  if (!REFUND_REASONS.includes(reason)) {
    throw new HttpError(400, `reason must be one of: ${REFUND_REASONS.join(", ")}`);
  }
  const note = typeof reasonNote === "string" && reasonNote.trim() ? reasonNote.trim() : null;
  if (reason === "other" && !note) {
    throw new HttpError(400, "reason_note is required when reason is 'other'");
  }

  // Lock the order for the duration of the reversal.
  const { rows: oRows } = await client.query(
    // tip is needed to separate the SALE from the GIFT (see refundableBase below).
    "SELECT id, status, subtotal, total, tax, tip FROM orders WHERE id = $1 FOR UPDATE",
    [orderId]
  );
  if (oRows.length === 0) throw new HttpError(404, "Order not found");
  const order = oRows[0];
  if (order.status === "cancelled") {
    throw new HttpError(409, "Order is already voided — nothing to reverse");
  }

  // Self-approval (no second PIN) is allowed ONLY to void an order the kitchen
  // hasn't finished. Nothing has been handed to a customer yet, so killing a
  // mis-rung ticket is a correction, not a cash-handling risk — and making a
  // cashier hunt for a manager mid-rush is how bad tickets reach the line.
  // Once the order is 'ready' the food exists and money is genuinely moving,
  // so dual control applies again.
  //
  // This check MUST live here, under the FOR UPDATE lock above, not in the
  // route: the order's status is exactly what a concurrent KDS advance
  // changes, so deciding it before the lock would let a cashier start a void
  // on a 'preparing' order and have it land on a 'ready' one unapproved.
  if (selfApproved) {
    if (type !== "void") {
      throw new HttpError(403, "Refunds always require manager or owner approval");
    }
    if (order.status !== "open" && order.status !== "preparing") {
      throw new HttpError(
        403,
        "This order is already complete — voiding it requires manager or owner approval"
      );
    }
  }
  const orderSubtotal = parseFloat(order.subtotal);
  const orderTotal = parseFloat(order.total);
  const orderTax = parseFloat(order.tax);
  const orderTip = parseFloat(order.tip);

  // ---- The tip boundary (plan decision D3) ----
  // orders.total is TIP-INCLUSIVE since on-reader tipping shipped, and a tip is
  // not part of what was sold — it is money the customer chose to give the
  // staff. So the refundable money splits in two:
  //
  //   refundableBase = subtotal − discount + tax   (the SALE)
  //   orderTip                                     (the GIFT)
  //
  // A full refund or a void unwinds the entire transaction and returns both.
  // A partial or line-item refund corrects part of the sale and returns NO tip,
  // so it is capped at refundableBase. Every proration below divides by
  // refundableBase rather than orderTotal: with a tip in the denominator the
  // tax portion of a partial refund comes out too low, which under-records
  // refunded HST and overstates what is owed to the CRA.
  const refundableBase = round2(orderTotal - orderTip);

  // Prior (non-failed) refunds on this order.
  const { rows: rRows } = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS refunded, COALESCE(SUM(tax_amount), 0) AS refunded_tax
       FROM order_refunds WHERE order_id = $1 AND status <> 'failed'`,
    [orderId]
  );
  const alreadyRefunded = parseFloat(rRows[0].refunded);
  const alreadyRefundedTax = parseFloat(rRows[0].refunded_tax);
  // Two caps, because the two kinds of reversal can reach different money.
  // Identical whenever the tip is 0, which is every pre-Stripe order.
  const remainingFull = round2(orderTotal - alreadyRefunded);
  const remainingPartial = round2(refundableBase - alreadyRefunded);

  // ---- Line-item detail: validated, and PRICED, entirely server-side ----
  // Caller-supplied line detail is validated against the ORDER before anything
  // is written, and its dollar value is computed here rather than accepted from
  // the request. The client sends only which lines and how many units; the
  // money is never its to decide (same never-trust-the-client principle as
  // checkout pricing and discounts).
  //   1. the order_item must belong to THIS order
  //   2. quantity must be a positive integer, ≤ the quantity ordered
  //   3. quantity must be ≤ (ordered − already refunded on prior non-failed
  //      refunds), so cumulative line refunds can't exceed what was sold
  //
  // Pricing: order_items.unit_price is the fully-priced per-unit figure
  // (variant + modifier deltas + paid addon extras) and orders.subtotal is
  // exactly Σ(unit_price × quantity), so a line's share of what was actually
  // COLLECTED is (qty × unit_price) × refundableBase/subtotal. Scaling by
  // refundableBase/subtotal allocates the order's discount and tax across the
  // lines proportionally — refunding every line therefore returns exactly
  // orders.total MINUS the tip, and refunding a line of a discounted order
  // returns what was really paid for it, not its undiscounted list price.
  //
  // The tip is deliberately NOT in that ratio (D3). Scaling by total/subtotal
  // instead would hand back a slice of the tip every time a single taco was
  // refunded, which nobody chose — it would just fall out of the arithmetic.
  let validatedItems = null;
  let lineItemsTotal = 0;
  if (Array.isArray(items) && items.length > 0) {
    const { rows: lineRows } = await client.query(
      `SELECT oi.id, oi.quantity, oi.unit_price,
              COALESCE((SELECT SUM(ori.quantity)
                          FROM order_refund_items ori
                          JOIN order_refunds r ON r.id = ori.refund_id
                         WHERE ori.order_item_id = oi.id AND r.status <> 'failed'), 0)
                AS refunded_qty
         FROM order_items oi
        WHERE oi.order_id = $1`,
      [orderId]
    );
    const byId = new Map(
      lineRows.map((r) => [
        r.id,
        {
          ordered: parseInt(r.quantity, 10),
          refunded: parseInt(r.refunded_qty, 10),
          unitPrice: parseFloat(r.unit_price),
        },
      ])
    );

    // Collapse duplicates first — the same line listed twice in one request
    // must be checked on its combined quantity, not per entry.
    const requested = new Map();
    for (const it of items) {
      const lineId = it.orderItemId;
      const line = byId.get(lineId);
      if (!line) {
        throw new HttpError(400, `Line item ${lineId} does not belong to this order`);
      }
      const qty = Number(it.quantity);
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new HttpError(400, `Line item ${lineId}: quantity must be a positive integer`);
      }
      requested.set(lineId, (requested.get(lineId) || 0) + qty);
    }

    // Ratio of collected-to-list, i.e. how discount and tax scale each line.
    // refundableBase, NOT orderTotal — see the tip note above.
    const collectedRatio = orderSubtotal > 0 ? refundableBase / orderSubtotal : 0;

    validatedItems = [];
    for (const [lineId, qty] of requested) {
      const { ordered, refunded, unitPrice } = byId.get(lineId);
      if (qty > ordered) {
        throw new HttpError(400, `Line item ${lineId}: cannot refund ${qty} of ${ordered} ordered`);
      }
      const refundableQty = ordered - refunded;
      if (qty > refundableQty) {
        throw new HttpError(
          409,
          `Line item ${lineId}: ${refunded} of ${ordered} already refunded — only ${refundableQty} remain refundable`
        );
      }
      const lineAmount = round2(qty * unitPrice * collectedRatio);
      lineItemsTotal = round2(lineItemsTotal + lineAmount);
      validatedItems.push({ orderItemId: lineId, quantity: qty, amount: lineAmount });
    }
  }

  // Tax portion of a partial reversal, prorated over the SALE only. The
  // denominator is refundableBase, never orderTotal: a tip carries no tax, so
  // including it would dilute the ratio and under-record refunded HST — on a
  // $113 order with a $10 tip, refunding half would book $5.97 of tax instead
  // of $6.50, and Sales Summary's `tax − refundTax` would overstate what is
  // owed to the CRA.
  const proratedTax = (amt) => (refundableBase > 0 ? round2(amt * (orderTax / refundableBase)) : 0);

  let refundAmount, refundTax, cap;
  if (type === "void") {
    // Full-order erase — only valid before any partial refund exists. A void
    // unwinds the whole transaction, tip included.
    if (alreadyRefunded > 0) {
      throw new HttpError(409, "Order has partial refunds — reverse the remainder with a refund, not a void");
    }
    refundAmount = orderTotal;
    refundTax = orderTax;
    cap = remainingFull;
  } else {
    // Refund — a standing completed sale. In-progress orders reverse via void.
    if (order.status !== "ready") {
      throw new HttpError(409, "Only completed (ready) orders can be refunded; reverse an in-progress order with a void");
    }
    if (validatedItems) {
      // Line-item refund — the amount is the sum of the server-priced lines, so
      // order_refunds.amount always equals SUM(order_refund_items.amount)
      // exactly. Any `amount` in the request is deliberately ignored. Priced
      // off refundableBase, so no tip comes back (D3).
      refundAmount = lineItemsTotal;
      refundTax = proratedTax(refundAmount);
      cap = remainingPartial;
    } else if (amount === undefined || amount === null) {
      // Neither lines nor an amount. Ambiguous once tips exist, so decision D4
      // settles it by whether anything has been refunded yet:
      //   nothing refunded  → this is a FULL refund. Unwind everything,
      //                       tip included, exactly like a void.
      //   already partial   → this is a top-up of the remaining SALE. No tip:
      //                       once the sale has been partly corrected, the tip
      //                       stays with the staff.
      if (alreadyRefunded === 0) {
        refundAmount = orderTotal;
        refundTax = orderTax;
        cap = remainingFull;
      } else {
        refundAmount = remainingPartial;
        refundTax = round2(orderTax - alreadyRefundedTax);
        cap = remainingPartial;
      }
    } else {
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        throw new HttpError(400, "amount must be a positive number");
      }
      refundAmount = round2(amt);
      refundTax = proratedTax(refundAmount);
      cap = remainingPartial;
    }
  }

  if (refundAmount <= 0) throw new HttpError(409, "Order is already fully refunded");
  if (refundAmount > cap + 0.005) {
    // The message names the tip when that is what puts the amount out of reach,
    // so "why can't I refund the full $44.52?" answers itself.
    const tipNote =
      type !== "void" && orderTip > 0 && refundAmount <= remainingFull + 0.005
        ? ` (a partial refund cannot return the $${orderTip.toFixed(2)} tip)`
        : "";
    throw new HttpError(
      400,
      `Refund amount ${refundAmount.toFixed(2)} exceeds remaining refundable ${cap.toFixed(2)}${tipNote}`
    );
  }

  // Misuse guard: a manager PIN can't approve a high-value reversal — owner/admin
  // only. Scoped to the dual-control path: it governs who may APPROVE, and a
  // self-approved in-progress void has no approver by design. Applying it here
  // too would be incoherent — a cashier could self-void a $150 preparing order
  // while a manager doing the identical thing was refused.
  if (!selfApproved && approverRole === "manager" && refundAmount >= REFUND_OWNER_APPROVAL_THRESHOLD) {
    throw new HttpError(403, `Reversals of $${REFUND_OWNER_APPROVAL_THRESHOLD}+ require owner/admin approval`);
  }
  // High-value reversals are logged (not blocked) — never silently invisible.
  // Self-approved voids are logged on the same rule: no second person saw it,
  // so the log line is the only record that it happened.
  if (refundAmount >= REFUND_FLAG_THRESHOLD) {
    console.warn(
      `High-value ${type}: $${refundAmount.toFixed(2)} (reason: ${reason}) order=${orderId} requested_by=${requestedBy} approved_by=${approvedBy}`
    );
  }

  // ---- How does this reversal actually settle? (Slice 7, decision D5) ----
  // Decided before anything is written, so an Interac refund that cannot be
  // issued from this surface is rejected with nothing recorded.
  const original = await loadOriginalPayment(client, orderId);
  const settlement = decideRefundSettlement({ original, surface, refundMethod, readerId });

  // 1. Audit record. Internal reversals settle immediately ('completed'); a
  //    Stripe one starts 'pending' and is promoted by the webhook that
  //    confirms the processor actually returned the money.
  const refundStatus =
    settlement === "stripe_api" || settlement === "stripe_reader" ? "pending" : "completed";
  const { rows: insRows } = await client.query(
    `INSERT INTO order_refunds (order_id, type, amount, tax_amount, reason, reason_note,
                                requested_by, approved_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, created_at`,
    [orderId, type, refundAmount, refundTax, reason, note, requestedBy, approvedBy, refundStatus]
  );
  const refundId = insRows[0].id;

  // 2. Optional line-item detail (populated by the line-item refund path) —
  //    the validated/de-duplicated set from above, never the raw request.
  if (validatedItems) {
    for (const it of validatedItems) {
      await client.query(
        `INSERT INTO order_refund_items (refund_id, order_item_id, quantity, amount)
         VALUES ($1, $2, $3, $4)`,
        [refundId, it.orderItemId, it.quantity, it.amount]
      );
    }
  }

  // 3. Negative money row on the ledger.
  //
  // Internal reversals settle instantly, exactly as they always have. Anything
  // going back through Stripe starts PENDING on both rows and is only promoted
  // by the webhook once the processor confirms it — money is not returned just
  // because we asked. settledPaymentsWhere() counts 'captured' + 'refunded'
  // only, so a pending (or failed) reversal is invisible to every report until
  // it genuinely settles, and a refund Stripe rejects never becomes a deduction.
  const goesThroughStripe = settlement === "stripe_api" || settlement === "stripe_reader";
  const ledgerMethod =
    settlement === "internal_cash" ? "cash" : original.method === "other" ? "other" : original.method;
  //
  // processor_txn_id is deliberately LEFT NULL on this row. It is tempting to
  // copy the PaymentIntent across for traceability, but payments carries a
  // partial UNIQUE index on that column — the backstop that makes it
  // impossible to record the same PaymentIntent as captured twice — and a
  // second row bearing the same id violates it. The link back to the sale
  // already exists through refund_id → order_refunds → order_id, and the
  // reversal's own processor reference lives on order_refunds.stripe_refund_id.
  await client.query(
    `INSERT INTO payments (order_id, method, amount, status, refund_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [orderId, ledgerMethod, -refundAmount, goesThroughStripe ? "pending" : "refunded", refundId]
  );

  // 4. A void erases the sale. voided_from_status preserves how far the order
  //    had got, which 'cancelled' would otherwise destroy — the KDS uses it to
  //    tell "someone is cooking this right now, interrupt them" (preparing/
  //    ready) from "it never reached the line" (open, no ticket needed).
  let orderStatus = order.status;
  if (type === "void") {
    await client.query(
      "UPDATE orders SET status = 'cancelled', voided_from_status = $2 WHERE id = $1",
      [orderId, order.status]
    );
    orderStatus = "cancelled";
  }

  return {
    refund: {
      id: refundId,
      orderId,
      type,
      amount: refundAmount,
      taxAmount: refundTax,
      reason,
      reasonNote: note,
      requestedBy,
      approvedBy,
      status: refundStatus,
      createdAt: insRows[0].created_at,
    },
    settlement,
    // Set only when money still has to leave Stripe. The caller performs this
    // AFTER committing, so no transaction is held open across a network call
    // and a crash can never leave a Stripe refund with no local record of why
    // (same ordering rule as the checkout path in Slice 1).
    pendingStripeRefund:
      settlement === "stripe_api" || settlement === "stripe_reader"
        ? {
            refundId,
            orderId,
            mode: settlement === "stripe_reader" ? "reader" : "api",
            paymentIntentId: original.processorTxnId,
            amount: refundAmount,
            readerId,
          }
        : null,
    orderStatus,
    // What a FUTURE reversal could still return. Anything after this point is
    // necessarily a partial (something has now been refunded), so it is capped
    // at refundableBase — the tip is no longer reachable. Clamped at 0 because
    // a full refund returns orderTotal, which overshoots that base by the tip.
    remainingRefundable: Math.max(
      0,
      round2(refundableBase - alreadyRefunded - refundAmount)
    ),
  };
}

// Sends an already-recorded reversal to Stripe. Runs AFTER the refund
// transaction has committed, so the local audit row always exists before any
// money is asked to move — if this process dies mid-call, the pending row is
// still there to explain what was attempted.
//
// Both calls carry an Idempotency-Key derived from the refund id (D9), so a
// timeout and retry can never refund twice.
//
// Returns the row's resulting state; it does NOT decide success. Only the
// webhook promotes a refund to 'completed', because Stripe accepting the
// request is not the same as the money reaching the customer.
async function settleStripeRefund(pending) {
  if (!stripeClient) {
    await failStripeRefund(pending.refundId, "Stripe is not configured on this server");
    return { status: "failed", error: "Stripe is not configured on this server" };
  }
  const idempotencyKey = `rf_${pending.refundId}`;
  try {
    if (pending.mode === "reader") {
      // Interac: the customer must present the card. This starts an action on
      // the reader; the refund object only exists once they tap, so there is no
      // stripe_refund_id to store yet — the webhook matches on the
      // PaymentIntent instead and fills it in.
      await stripeClient.terminal.readers.refundPayment(
        pending.readerId,
        {
          payment_intent: pending.paymentIntentId,
          amount: toStripeAmount(pending.amount),
          refund_payment_config: { enable_customer_cancellation: true },
        },
        { idempotencyKey }
      );
      await pool.query(
        `UPDATE order_refunds SET processor_status = 'awaiting_card' WHERE id = $1`,
        [pending.refundId]
      );
      return { status: "pending", awaitingCard: true };
    }

    const refund = await stripeClient.refunds.create(
      {
        payment_intent: pending.paymentIntentId,
        amount: toStripeAmount(pending.amount),
        metadata: { order_refund_id: pending.refundId, order_id: pending.orderId },
      },
      { idempotencyKey }
    );

    await pool.query(
      `UPDATE order_refunds
          SET stripe_refund_id = $2, processor_status = $3
        WHERE id = $1`,
      [pending.refundId, refund.id, refund.status || null]
    );

    // Stripe often returns 'succeeded' synchronously for a card refund. Promote
    // immediately in that case rather than leaving the cashier staring at a
    // pending reversal waiting for a webhook that adds nothing.
    if (refund.status === "succeeded") {
      await promoteStripeRefund(pending.refundId, refund.id, refund.status);
      return { status: "completed", stripeRefundId: refund.id };
    }
    if (refund.status === "failed" || refund.status === "canceled") {
      await failStripeRefund(pending.refundId, `Stripe refund ${refund.status}`, refund.id, refund.status);
      return { status: "failed", stripeRefundId: refund.id };
    }
    return { status: "pending", stripeRefundId: refund.id };
  } catch (err) {
    console.error(`Stripe refund failed (order_refund=${pending.refundId}): ${err.message}`);
    await failStripeRefund(pending.refundId, err.message);
    return { status: "failed", error: err.message };
  }
}

// Promote a pending reversal to settled. Guarded on 'pending' so a webhook
// replay cannot re-settle, and so a refund a human already marked failed is
// not silently resurrected.
async function promoteStripeRefund(refundId, stripeRefundId, processorStatus) {
  const { rowCount } = await pool.query(
    `UPDATE order_refunds
        SET status = 'completed',
            stripe_refund_id = COALESCE($2, stripe_refund_id),
            processor_status = $3
      WHERE id = $1 AND status = 'pending'`,
    [refundId, stripeRefundId || null, processorStatus || null]
  );
  if (rowCount === 1) {
    // The money row becomes real at the same moment — this is what makes the
    // reversal visible to settledPaymentsWhere() and therefore to every report.
    await pool.query(
      `UPDATE payments SET status = 'refunded' WHERE refund_id = $1 AND status = 'pending'`,
      [refundId]
    );
  }
  return rowCount === 1;
}

// Mark a reversal failed. The negative payments row goes to 'failed', which
// settledPaymentsWhere() excludes — so a refund Stripe rejected is never
// counted as money returned, and the order's refundable balance is restored.
async function failStripeRefund(refundId, message, stripeRefundId, processorStatus) {
  const { rowCount } = await pool.query(
    `UPDATE order_refunds
        SET status = 'failed',
            stripe_refund_id = COALESCE($2, stripe_refund_id),
            processor_status = COALESCE($3, processor_status),
            reason_note = COALESCE(reason_note, '') ||
                          CASE WHEN COALESCE(reason_note,'') = '' THEN '' ELSE ' | ' END ||
                          $4
      WHERE id = $1 AND status = 'pending'`,
    [refundId, stripeRefundId || null, processorStatus || null, `Refund failed: ${String(message).slice(0, 200)}`]
  );
  if (rowCount === 1) {
    await pool.query(
      `UPDATE payments SET status = 'failed' WHERE refund_id = $1 AND status = 'pending'`,
      [refundId]
    );
  }
  return rowCount === 1;
}

// Resolve a Stripe Refund object onto our row. Matches on stripe_refund_id
// first; failing that (a reader-initiated Interac refund has no id until the
// customer taps) it falls back to the oldest pending reversal for the same
// PaymentIntent and adopts the id.
async function applyStripeRefundOutcome(refund) {
  let refundId = null;
  const { rows } = await pool.query("SELECT id, status FROM order_refunds WHERE stripe_refund_id = $1", [refund.id]);
  if (rows[0]) {
    refundId = rows[0].id;
  } else if (refund.payment_intent) {
    // Matched through the ORIGINAL capture row, which is the only row that
    // carries the PaymentIntent (see the note on the negative row above).
    const { rows: byPi } = await pool.query(
      `SELECT r.id
         FROM order_refunds r
         JOIN payments cap ON cap.order_id = r.order_id AND cap.refund_id IS NULL
        WHERE r.status = 'pending' AND cap.processor_txn_id = $1
        ORDER BY r.created_at
        LIMIT 1`,
      [refund.payment_intent]
    );
    if (byPi[0]) refundId = byPi[0].id;
  }
  if (!refundId) return { matched: false };

  if (refund.status === "succeeded") {
    const promoted = await promoteStripeRefund(refundId, refund.id, refund.status);
    return { matched: true, refundId, outcome: promoted ? "completed" : "already_resolved" };
  }
  if (refund.status === "failed" || refund.status === "canceled") {
    const failed = await failStripeRefund(
      refundId,
      refund.failure_reason || `Stripe reported ${refund.status}`,
      refund.id,
      refund.status
    );
    return { matched: true, refundId, outcome: failed ? "failed" : "already_resolved" };
  }
  // Still pending at Stripe — record the id/status and wait.
  await pool.query(
    `UPDATE order_refunds SET stripe_refund_id = COALESCE($2, stripe_refund_id), processor_status = $3
      WHERE id = $1 AND status = 'pending'`,
    [refundId, refund.id, refund.status || null]
  );
  return { matched: true, refundId, outcome: "still_pending" };
}

// POST /api/orders/:id/refund   (POS — device-paired)
// Body: { staffId, approverStaffId, approverPin, type, reason, reasonNote, amount, items }
// Dual-control: a cashier INITIATES; a manager/owner/admin APPROVES with their
// PIN before it commits (guards against a cashier reversing sales to pocket
// cash). The approver may equal the initiator when the initiator is manager+.
app.post("/api/orders/:id/refund", requireDevicePairing, async (req, res) => {
  const { id } = req.params;
  const { staffId, approverStaffId, approverPin, type, reason, reasonNote, amount, items, refundMethod } =
    req.body || {};
  const client = await pool.connect();
  let committed = false;
  try {
    // Initiator: any working role except kitchen.
    const initiator = await requireStaffIdParam(staffId, ["owner", "admin", "manager", "cashier"]);

    // Omitting the approver is a request to self-approve. That is only legal
    // for voiding an order the kitchen hasn't finished — applyRefund decides,
    // under the row lock, and rejects anything else. Everything with an
    // approver keeps the original dual-control path unchanged.
    const selfApproved = !approverStaffId;
    let approver = initiator;
    if (!selfApproved) {
      // Approver: explicit manager+ AND must prove their PIN (dual-control).
      approver = await requireStaffIdParam(approverStaffId, ["owner", "admin", "manager"]);
      await verifyStaffPin(approver.id, approverPin);
    }

    // The till's bound reader — needed only for an Interac card refund, which
    // the customer must authorise by presenting the card.
    const { rows: devRows } = await client.query(
      "SELECT stripe_reader_id FROM device_pairings WHERE device_id = $1",
      [req.deviceId]
    );

    await client.query("BEGIN");
    const result = await applyRefund(client, {
      orderId: id,
      type,
      reason,
      reasonNote,
      amount,
      items,
      requestedBy: initiator.id,
      approvedBy: approver.id,
      approverRole: approver.role,
      selfApproved,
      // At the counter: the customer can present a card, so an Interac refund
      // is possible here (and only here).
      surface: "pos",
      refundMethod: refundMethod === "cash" ? "cash" : null,
      readerId: devRows[0]?.stripe_reader_id || null,
    });
    await client.query("COMMIT");
    committed = true;

    // Outside the transaction — see settleStripeRefund.
    if (result.pendingStripeRefund) {
      result.stripe = await settleStripeRefund(result.pendingStripeRefund);
      result.refund.status = result.stripe.status;
    }
    delete result.pendingStripeRefund;
    res.status(201).json(result);
  } catch (err) {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    sendHttpError(res, err, "Failed to process refund");
  } finally {
    client.release();
  }
});

// GET /api/orders/pos-recall?search=...&limit=20   (POS — device-paired)
// Order-recall endpoint for POS. Returns recent orders with financial totals,
// line-item breakdown, payment details, and prior refund history.
// GET /api/orders/pending/:id — what happened to this card payment?
//
// The Order Entry waiting panel polls this. The payment result arrives at the
// backend as a webhook, not as a reply to the checkout request, so this is how
// the till finds out. Deliberately tiny: one indexed lookup, no Stripe call, so
// polling it every second or two costs nothing.
//
// Scoped to the device that started the checkout — a payment in progress at one
// till is not another till's business, and the device cookie is already proven
// by requireDevicePairing.
app.get("/api/orders/pending/:id", requireDevicePairing, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pc.id, pc.status, pc.total, pc.error_message, pc.order_id,
              o.order_number
         FROM pending_checkouts pc
    LEFT JOIN orders o ON o.id = pc.order_id
        WHERE pc.id = $1 AND pc.device_id = $2`,
      [req.params.id, req.deviceId]
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, "Unknown payment for this device");

    res.json({
      id: row.id,
      status: row.status, // awaiting_payment | succeeded | failed | cancelled | expired | orphaned
      total: parseFloat(row.total),
      orderId: row.order_id,
      orderNumber: row.order_number,
      errorMessage: row.error_message,
    });
  } catch (err) {
    sendHttpError(res, err, "Failed to check payment status");
  }
});

// POST /api/orders/pending/:id/cancel — cashier aborts a live card payment.
//
// Cancels the action on the reader FIRST (so the customer stops being prompted)
// and then the PaymentIntent, both with Idempotency-Keys.
//
// The race this has to survive: the customer may tap in the moment the cashier
// reaches for Cancel. So nothing here forces a cancelled outcome — the row is
// only moved to 'cancelled' while it is still 'awaiting_payment'. If the
// webhook has already materialized an order, that UPDATE matches nothing and
// the response reports the sale, which is the truth. Cancelling a payment that
// already succeeded would be inventing one.
app.post("/api/orders/pending/:id/cancel", requireDevicePairing, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pc.id, pc.status, pc.stripe_payment_intent_id, pc.stripe_reader_id, pc.order_id,
              o.order_number
         FROM pending_checkouts pc
    LEFT JOIN orders o ON o.id = pc.order_id
        WHERE pc.id = $1 AND pc.device_id = $2`,
      [req.params.id, req.deviceId]
    );
    const pending = rows[0];
    if (!pending) throw new HttpError(404, "Unknown payment for this device");

    // Already finished one way or the other — report it, change nothing.
    if (pending.status !== "awaiting_payment") {
      return res.json({
        status: pending.status,
        orderNumber: pending.order_number,
        alreadyResolved: true,
      });
    }
    if (!stripeClient) throw new HttpError(503, "Stripe is not configured on this server");

    const idemBase = `pc_${pending.id}`;

    // 1. Stop the reader prompting. "No action in progress" is a perfectly
    //    normal outcome here (the customer may have just finished), so a
    //    failure is logged and does not abort the cancel.
    if (pending.stripe_reader_id) {
      try {
        await stripeClient.terminal.readers.cancelAction(
          pending.stripe_reader_id,
          {},
          { idempotencyKey: `${idemBase}_cancel_action` }
        );
      } catch (err) {
        console.warn(`cancelAction on ${pending.stripe_reader_id} did not apply: ${err.message}`);
      }
    }

    // 2. Cancel the PaymentIntent so it cannot later be completed or linger.
    //    If Stripe refuses because it has already succeeded, that IS the answer
    //    — fall through and let the status re-read below report the sale.
    let alreadySucceeded = false;
    if (pending.stripe_payment_intent_id) {
      try {
        await stripeClient.paymentIntents.cancel(
          pending.stripe_payment_intent_id,
          {},
          { idempotencyKey: `${idemBase}_cancel_pi` }
        );
      } catch (err) {
        const msg = String(err.message || "").toLowerCase();
        if (msg.includes("succeeded") || msg.includes("cannot be canceled")) {
          alreadySucceeded = true;
        } else {
          console.warn(`Could not cancel ${pending.stripe_payment_intent_id}: ${err.message}`);
        }
      }
    }

    // 3. Record the cancellation ONLY if the payment is still open, and only if
    //    Stripe did not just tell us the money had already landed. Marking a
    //    completed payment 'cancelled' would be a lie the webhook then has to
    //    undo; leaving the row open lets the webhook resolve it to 'succeeded'
    //    a moment later, which is what actually happened.
    let rowCount = 0;
    if (!alreadySucceeded) {
      ({ rowCount } = await pool.query(
        `UPDATE pending_checkouts
            SET status = 'cancelled', error_message = $2, updated_at = now()
          WHERE id = $1 AND status = 'awaiting_payment'`,
        [pending.id, "Cancelled at the till"]
      ));
    }

    // Re-read: between step 1 and here the webhook may have materialized an
    // order. Whatever the row says now is the truth.
    const { rows: finalRows } = await pool.query(
      `SELECT pc.status, pc.error_message, o.order_number
         FROM pending_checkouts pc
    LEFT JOIN orders o ON o.id = pc.order_id
        WHERE pc.id = $1`,
      [pending.id]
    );
    const final = finalRows[0];

    return res.json({
      status: final.status,
      orderNumber: final.order_number,
      errorMessage: final.error_message,
      cancelled: rowCount === 1,
      // True when Stripe told us the money had already landed — the webhook
      // may still be moments away from writing the order.
      paymentAlreadyCompleted: alreadySucceeded,
    });
  } catch (err) {
    sendHttpError(res, err, "Failed to cancel the payment");
  }
});

app.get("/api/orders/pos-recall", requireDevicePairing, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10) || 20, 1), 50);
  const search = req.query.search ? req.query.search.toString().trim() : "";

  const client = await pool.connect();
  try {
    const { rows: locRows } = await client.query(
      "SELECT id FROM locations WHERE active = true ORDER BY created_at LIMIT 1"
    );
    if (locRows.length === 0) return res.status(500).json({ error: "No active location" });
    const locationId = locRows[0].id;

    let whereClause = "WHERE o.location_id = $1";
    const params = [locationId];

    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND (o.order_number::text ILIKE $${params.length} OR o.customer_name ILIKE $${params.length})`;
    }

    params.push(limit);
    const { rows: orders } = await client.query(
      `SELECT o.id, o.order_number, o.status, o.fulfillment_type, o.customer_name,
              o.staff_id, s.name AS staff_name,
              o.subtotal, o.tax, o.tip, o.discount, o.discount_percent, o.discount_reason, o.total,
              o.created_at, o.completed_at,
              COALESCE(p.method, 'other') AS payment_method
         FROM orders o
         JOIN staff s ON s.id = o.staff_id
    LEFT JOIN payments p ON p.order_id = o.id AND p.refund_id IS NULL
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${params.length}`,
      params
    );

    if (orders.length === 0) {
      return res.json({ orders: [] });
    }

    const orderIds = orders.map((o) => o.id);

    const { rows: itemsRows } = await client.query(
      `SELECT oi.id AS order_item_id, oi.order_id, oi.item_id, oi.variant_id, oi.quantity, oi.unit_price,
              mi.name AS item_name, iv.name AS variant_name
         FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.item_id
    LEFT JOIN item_variants iv ON iv.id = oi.variant_id
        WHERE oi.order_id = ANY($1::uuid[])
        ORDER BY oi.id`,
      [orderIds]
    );

    const { rows: refundsRows } = await client.query(
      `SELECT r.id, r.order_id, r.type, r.amount, r.tax_amount, r.reason, r.reason_note,
              r.status, r.created_at,
              req.name AS requested_by_name, app.name AS approved_by_name
         FROM order_refunds r
         JOIN staff req ON req.id = r.requested_by
         JOIN staff app ON app.id = r.approved_by
        WHERE r.order_id = ANY($1::uuid[]) AND r.status <> 'failed'
        ORDER BY r.created_at ASC`,
      [orderIds]
    );

    // Which lines a line-item refund covered, for the POS reversal log ("REFUND
    // $18.07 — Quesadilla"). Display-only: the money still comes from
    // order_refunds.amount, which the server priced at reversal time.
    const { rows: refundItemRows } = await client.query(
      `SELECT ori.refund_id, ori.quantity,
              COALESCE(mi.name, 'Unknown Item') AS item_name
         FROM order_refund_items ori
         JOIN order_items oi ON oi.id = ori.order_item_id
         LEFT JOIN menu_items mi ON mi.id = oi.item_id
        WHERE ori.refund_id = ANY($1::uuid[])
        ORDER BY ori.id`,
      [refundsRows.map((r) => r.id)]
    );
    const itemsByRefund = {};
    for (const ri of refundItemRows) {
      (itemsByRefund[ri.refund_id] ||= []).push({
        name: ri.item_name,
        quantity: parseInt(ri.quantity, 10),
      });
    }

    const itemsByOrder = {};
    for (const item of itemsRows) {
      (itemsByOrder[item.order_id] ||= []).push({
        order_item_id: item.order_item_id,
        item_id: item.item_id,
        variant_id: item.variant_id,
        name: item.item_name || "Unknown Item",
        variant_name: item.variant_name || null,
        quantity: item.quantity,
        unit_price: parseFloat(item.unit_price),
        line_total: round2(item.quantity * parseFloat(item.unit_price)),
      });
    }

    const refundsByOrder = {};
    for (const ref of refundsRows) {
      (refundsByOrder[ref.order_id] ||= []).push({
        id: ref.id,
        type: ref.type,
        amount: parseFloat(ref.amount),
        tax_amount: parseFloat(ref.tax_amount),
        reason: ref.reason,
        reason_note: ref.reason_note,
        status: ref.status,
        created_at: ref.created_at,
        requested_by_name: ref.requested_by_name,
        approved_by_name: ref.approved_by_name,
        items: itemsByRefund[ref.id] || [],
      });
    }

    const result = orders.map((o) => {
      const oTotal = parseFloat(o.total);
      const oTax = parseFloat(o.tax);
      const refs = refundsByOrder[o.id] || [];
      const totalRefunded = round2(refs.reduce((acc, r) => acc + r.amount, 0));
      const totalRefundedTax = round2(refs.reduce((acc, r) => acc + r.tax_amount, 0));
      const remainingRefundable = Math.max(0, round2(oTotal - totalRefunded));

      return {
        id: o.id,
        order_number: o.order_number,
        status: o.status,
        fulfillment_type: o.fulfillment_type,
        customer_name: o.customer_name,
        staff_id: o.staff_id,
        staff_name: o.staff_name,
        subtotal: parseFloat(o.subtotal),
        tax: oTax,
        tip: parseFloat(o.tip),
        discount: parseFloat(o.discount),
        discount_percent: o.discount_percent ? parseFloat(o.discount_percent) : null,
        discount_reason: o.discount_reason,
        total: oTotal,
        payment_method: o.payment_method,
        created_at: o.created_at,
        completed_at: o.completed_at,
        items: itemsByOrder[o.id] || [],
        refund_summary: {
          total_refunded: totalRefunded,
          total_refunded_tax: totalRefundedTax,
          remaining_refundable: remainingRefundable,
          is_fully_refunded: remainingRefundable === 0 && refs.length > 0,
        },
        refunds: refs,
      };
    });

    res.json({ orders: result });
  } catch (err) {
    console.error("POS recall failed:", err.message);
    res.status(500).json({ error: "Failed to fetch orders for recall" });
  } finally {
    client.release();
  }
});

// GET /api/staff/approvers   (POS — device-paired)
// Active staff members eligible for dual-control reversal approval (owner, admin, manager).
// Used by OrderRecallModal's name-picker approval flow.
app.get("/api/staff/approvers", requireDevicePairing, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, role FROM staff
        WHERE active = true AND role IN ('owner', 'admin', 'manager')
        ORDER BY array_position(ARRAY['owner','admin','manager'], role::text), name`
    );
    res.json({ approvers: rows });
  } catch (err) {
    console.error("Failed to fetch approvers:", err.message);
    res.status(500).json({ error: "Failed to fetch eligible approvers" });
  }
});

// POST /api/backoffice/orders/:id/refund   (Back Office — owner/admin session)
// Body: { type, reason, reasonNote, amount, items }. Owner/admin are the top of
// the trust hierarchy and self-approve (approved_by = requested_by = session staff).
app.post("/api/backoffice/orders/:id/refund", async (req, res) => {
  const { id } = req.params;
  const { type, reason, reasonNote, amount, items, refundMethod } = req.body || {};
  const client = await pool.connect();
  let committed = false;
  try {
    const staff = await requireBackofficeSession(req); // owner/admin only
    await client.query("BEGIN");
    const result = await applyRefund(client, {
      orderId: id,
      type,
      reason,
      reasonNote,
      amount,
      items,
      requestedBy: staff.id,
      approvedBy: staff.id,
      approverRole: staff.role,
      // Remote surface: nobody is holding a card, so an Interac reversal is
      // rejected here (D5). `refundMethod: 'cash'` is the deliberate way out.
      surface: "backoffice",
      refundMethod: refundMethod === "cash" ? "cash" : null,
    });
    await client.query("COMMIT");
    committed = true;

    if (result.pendingStripeRefund) {
      result.stripe = await settleStripeRefund(result.pendingStripeRefund);
      result.refund.status = result.stripe.status;
    }
    delete result.pendingStripeRefund;
    res.status(201).json(result);
  } catch (err) {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    sendHttpError(res, err, "Failed to process refund");
  } finally {
    client.release();
  }
});

// --------------- Back Office: authentication (email + password + TOTP) ---------------
// Replaces PIN login for Back Office ONLY, owner/admin exclusively. Order
// Entry/KDS PIN login (POST /api/auth/login, above) is a completely
// separate system and is untouched by any of this — every role, including
// owner/admin, keeps using their PIN there.
//
// Flow:
//   1. First-time (no email/password yet): the existing PIN proves identity
//      once (setup-start), then the owner/admin picks an email + password
//      (setup-complete), then confirms a TOTP app (setup-confirm).
//   2. Returning login: email + password (login-step1) -> 6-digit TOTP code
//      (login-step2) -> session cookie issued.
//   3. If login-step1 succeeds but TOTP was never confirmed (an interrupted
//      setup), it re-enters the SAME TOTP-setup branch setup-complete would
//      have used, so nobody gets stuck in a broken in-between state.
//
// Three short-lived, stateless JWTs (signed with SESSION_SECRET, never
// touch the DB) move the caller between these steps before a real session
// exists:
//   "account_setup" — proves a PIN-verified owner/admin, setup-start ->
//                      setup-complete, 10 min
//   "2fa_setup"      — proves password was just verified and a TOTP secret
//                      was just (re)generated; used by setup-confirm, 10 min
//   "2fa_pending"    — proves password was just verified and TOTP is
//                      already enabled; used by login-step2, 5 min
// Only a real "session" JWT (issued at the end of setup-confirm/login-
// step2) goes into the httpOnly cookie, and it's the only kind
// requireBackofficeSession (below) will ever accept.

const PASSWORD_MIN_LENGTH = 10;
const TOTP_ISSUER = "Narcos Tacos POS";

function signTempToken(payload, purpose, expiresIn) {
  return jwt.sign({ ...payload, purpose }, SESSION_SECRET, { expiresIn });
}

function verifyTempToken(token, purpose) {
  if (!token || typeof token !== "string") return null;
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    return payload.purpose === purpose ? payload : null;
  } catch {
    return null; // expired/invalid/tampered/wrong-purpose all treated the same
  }
}

function issueSession(req, res, staffId) {
  const token = jwt.sign({ staffId, purpose: "session" }, SESSION_SECRET, {
    expiresIn: Math.floor(SESSION_MAX_AGE_MS / 1000),
  });
  res.cookie(SESSION_COOKIE_NAME, token, { ...sessionCookieOpts(req), maxAge: SESSION_MAX_AGE_MS });
}

function validatePasswordStrength(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    throw new HttpError(400, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
}

function normalizeEmail(email) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new HttpError(400, "A valid email address is required");
  }
  return email.trim().toLowerCase();
}

async function verifyTotpCode(secret, token) {
  try {
    const result = await verifyTotpToken({ secret, token });
    return !!result?.valid;
  } catch {
    return false; // malformed token (wrong length/non-digit) — just "invalid"
  }
}

// Starts (or resumes an interrupted) TOTP setup for a staff row that
// already has email + password_hash: generates a fresh secret, stores it
// (totp_enabled stays false until setup-confirm verifies a real code
// against it), and returns everything the frontend needs to render the QR
// step. Safe to call repeatedly — each call simply issues a new secret,
// so an abandoned setup never leaves a stale/guessable one lying around.
async function beginTotpSetup(staff) {
  const secret = generateTotpSecret();
  await pool.query("UPDATE staff SET totp_secret = $1 WHERE id = $2", [secret, staff.id]);
  const otpauthUrl = generateTotpUri({ secret, label: staff.email, issuer: TOTP_ISSUER });
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
  const tempToken = signTempToken({ staffId: staff.id }, "2fa_setup", "10m");
  return { stage: "2fa_setup", tempToken, otpauthUrl, qrCodeDataUrl };
}

function hashResetToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

// Sends via Resend's REST API directly (no SDK — Node's built-in fetch is
// enough for one simple POST, avoiding an extra dependency for a single
// call site). Never throws: forgot-password must ALWAYS return its generic
// success response whether or not the send actually worked, so failures
// are logged (status code only — never the API key, never the recipient's
// reset link) and swallowed here.
async function sendResendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("RESEND_API_KEY is not set — skipping email send");
    return;
  }
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Narcos Tacos POS <noreply@narcostacos.ca>",
        to: [to],
        subject,
        html,
      }),
    });
    if (!resp.ok) {
      console.error(`Resend email send failed: HTTP ${resp.status}`);
    }
  } catch (err) {
    console.error("Resend email send failed:", err.message);
  }
}

// POST /api/backoffice/auth/setup-start — { pin }
// One-time bootstrap for an owner/admin who has no email/password yet
// (every existing owner/admin, until they do this once). Reuses their
// existing PIN purely to prove "this is really them" — same trust model
// PIN login already uses everywhere else in this app — then hands back a
// short-lived token for setup-complete. Rejects accounts that already
// have a password set (use email+password login, or Forgot Password).
app.post("/api/backoffice/auth/setup-start", async (req, res) => {
  const { pin } = req.body || {};
  if (typeof pin !== "string" || !pin) {
    return res.status(400).json({ error: "PIN is required" });
  }

  // Keyed by the PIN itself — same reasoning as Order Entry's PIN login.
  const rateCheck = checkRateLimit(pin, "bo-setup-pin");
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: formatLockoutMessage(rateCheck.retryAfter), retryAfter: rateCheck.retryAfter });
  }

  try {
    const { rows } = await pool.query(
      "SELECT id, name, role, pin_hash, password_hash FROM staff WHERE active = true AND role IN ('owner','admin')"
    );
    let matched = null;
    for (const row of rows) {
      if (await bcrypt.compare(pin, row.pin_hash)) {
        matched = row;
        break;
      }
    }
    if (!matched) {
      const attempt = recordFailedAttempt(pin, "bo-setup-pin");
      if (attempt.lockedOut) {
        return res.status(429).json({ error: formatLockoutMessage(attempt.retryAfter), retryAfter: attempt.retryAfter });
      }
      return res.status(401).json({ error: "PIN not recognized" });
    }
    clearAttempts(pin, "bo-setup-pin");

    if (matched.password_hash) {
      return res.status(409).json({
        error: "This account already has a Back Office login — use email + password, or Forgot Password to reset it.",
      });
    }

    const tempToken = signTempToken({ staffId: matched.id }, "account_setup", "10m");
    res.json({ tempToken, name: matched.name });
  } catch (err) {
    console.error("Back Office setup-start error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/backoffice/auth/setup-complete — { tempToken, email, password }
// Sets the email + password this account will log in with going forward,
// then immediately starts TOTP setup (same shape as login-step1's
// not-yet-enabled branch) so the frontend can go straight into the QR step.
app.post("/api/backoffice/auth/setup-complete", async (req, res) => {
  try {
    const { tempToken, email, password } = req.body || {};
    const payload = verifyTempToken(tempToken, "account_setup");
    if (!payload) throw new HttpError(401, "Setup session expired — please start again with your PIN");

    const { rows } = await pool.query(
      "SELECT id, name, role, password_hash FROM staff WHERE id = $1 AND active = true AND role IN ('owner','admin')",
      [payload.staffId]
    );
    const staff = rows[0];
    if (!staff) throw new HttpError(401, "Setup session expired — please start again with your PIN");
    if (staff.password_hash) throw new HttpError(409, "This account already has a Back Office login set up");

    const email_ = normalizeEmail(email);
    validatePasswordStrength(password);

    const { rows: existing } = await pool.query(
      "SELECT id FROM staff WHERE lower(email) = $1 AND id != $2",
      [email_, staff.id]
    );
    if (existing.length > 0) throw new HttpError(409, "That email is already in use");

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [
      email_,
      passwordHash,
      staff.id,
    ]);

    const setupInfo = await beginTotpSetup({ id: staff.id, email: email_ });
    res.json(setupInfo);
  } catch (err) {
    sendHttpError(res, err, "Failed to complete account setup");
  }
});

// POST /api/backoffice/auth/login-step1 — { email, password }
// Always the same generic error for "no such email", "not owner/admin",
// and "wrong password" — never reveals which one it was.
app.post("/api/backoffice/auth/login-step1", async (req, res) => {
  const GENERIC_FAIL = "Invalid email or password";
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return res.status(400).json({ error: GENERIC_FAIL });
  }
  const normalizedEmail = email.trim().toLowerCase();

  // Keyed by the email itself — same per-identity reasoning as PIN login.
  const rateCheck = checkRateLimit(normalizedEmail, "bo-password");
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: formatLockoutMessage(rateCheck.retryAfter), retryAfter: rateCheck.retryAfter });
  }

  try {
    const { rows } = await pool.query(
      "SELECT id, name, role, email, password_hash, totp_enabled FROM staff WHERE lower(email) = $1 AND active = true",
      [normalizedEmail]
    );
    const staff = rows[0];
    // Hard backstop: reject anything that isn't owner/admin even though
    // only owner/admin should ever have a password_hash set at all.
    if (!staff || !["owner", "admin"].includes(staff.role) || !staff.password_hash) {
      const attempt = recordFailedAttempt(normalizedEmail, "bo-password");
      if (attempt.lockedOut) {
        return res.status(429).json({ error: formatLockoutMessage(attempt.retryAfter), retryAfter: attempt.retryAfter });
      }
      return res.status(401).json({ error: GENERIC_FAIL });
    }
    const passwordOk = await bcrypt.compare(password, staff.password_hash);
    if (!passwordOk) {
      const attempt = recordFailedAttempt(normalizedEmail, "bo-password");
      if (attempt.lockedOut) {
        return res.status(429).json({ error: formatLockoutMessage(attempt.retryAfter), retryAfter: attempt.retryAfter });
      }
      return res.status(401).json({ error: GENERIC_FAIL });
    }
    clearAttempts(normalizedEmail, "bo-password");

    if (!staff.totp_enabled) {
      const setupInfo = await beginTotpSetup(staff);
      return res.json(setupInfo);
    }
    const tempToken = signTempToken({ staffId: staff.id }, "2fa_pending", "5m");
    res.json({ stage: "2fa", tempToken });
  } catch (err) {
    console.error("Back Office login-step1 error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/backoffice/auth/setup-confirm — { tempToken, totpCode }
// Completes a TOTP setup (first-time or resumed): one correct code flips
// totp_enabled true and issues the real session — same ending as login-step2.
app.post("/api/backoffice/auth/setup-confirm", async (req, res) => {
  try {
    const { tempToken, totpCode } = req.body || {};
    const payload = verifyTempToken(tempToken, "2fa_setup");
    if (!payload) throw new HttpError(401, "Setup session expired — please log in again");

    // Keyed by the account (staffId) the already-validated tempToken
    // belongs to — not IP. A garbage/expired tempToken never reaches here
    // (rejected above without touching the DB or the rate limiter), so
    // this only ever tracks guesses against one specific real account.
    const rateCheck = checkRateLimit(payload.staffId, "bo-totp");
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: formatLockoutMessage(rateCheck.retryAfter), retryAfter: rateCheck.retryAfter });
    }

    const { rows } = await pool.query(
      "SELECT id, name, role, totp_secret FROM staff WHERE id = $1 AND active = true AND role IN ('owner','admin')",
      [payload.staffId]
    );
    const staff = rows[0];
    if (!staff || !staff.totp_secret) throw new HttpError(401, "Setup session expired — please log in again");

    const codeOk = await verifyTotpCode(staff.totp_secret, totpCode);
    if (!codeOk) {
      const attempt = recordFailedAttempt(payload.staffId, "bo-totp");
      if (attempt.lockedOut) {
        return res.status(429).json({ error: formatLockoutMessage(attempt.retryAfter), retryAfter: attempt.retryAfter });
      }
      throw new HttpError(401, "Incorrect code — check your authenticator app and try again");
    }
    clearAttempts(payload.staffId, "bo-totp");

    await pool.query("UPDATE staff SET totp_enabled = true WHERE id = $1", [staff.id]);
    issueSession(req, res, staff.id);
    res.json({ id: staff.id, name: staff.name, role: staff.role });
  } catch (err) {
    sendHttpError(res, err, "Failed to confirm 2FA setup");
  }
});

// POST /api/backoffice/auth/login-step2 — { tempToken, totpCode }
app.post("/api/backoffice/auth/login-step2", async (req, res) => {
  try {
    const { tempToken, totpCode } = req.body || {};
    const payload = verifyTempToken(tempToken, "2fa_pending");
    if (!payload) throw new HttpError(401, "Login session expired — please log in again");

    // Keyed by the account (staffId), same as setup-confirm — and
    // deliberately the SAME "bo-totp" bucket, since both endpoints are
    // fundamentally "guess a 6-digit code for this account" — sharing the
    // counter means switching endpoints doesn't reset an attacker's budget.
    const rateCheck = checkRateLimit(payload.staffId, "bo-totp");
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: formatLockoutMessage(rateCheck.retryAfter), retryAfter: rateCheck.retryAfter });
    }

    const { rows } = await pool.query(
      "SELECT id, name, role, totp_secret, totp_enabled FROM staff WHERE id = $1 AND active = true AND role IN ('owner','admin')",
      [payload.staffId]
    );
    const staff = rows[0];
    if (!staff || !staff.totp_enabled || !staff.totp_secret) {
      throw new HttpError(401, "Login session expired — please log in again");
    }

    const codeOk = await verifyTotpCode(staff.totp_secret, totpCode);
    if (!codeOk) {
      const attempt = recordFailedAttempt(payload.staffId, "bo-totp");
      if (attempt.lockedOut) {
        return res.status(429).json({ error: formatLockoutMessage(attempt.retryAfter), retryAfter: attempt.retryAfter });
      }
      throw new HttpError(401, "Incorrect code");
    }
    clearAttempts(payload.staffId, "bo-totp");

    issueSession(req, res, staff.id);
    res.json({ id: staff.id, name: staff.name, role: staff.role });
  } catch (err) {
    sendHttpError(res, err, "Failed to verify code");
  }
});

// POST /api/backoffice/auth/forgot-password — { email }
// ALWAYS the same generic response, whether or not the email matches an
// account — never reveals which emails have Back Office access.
app.post("/api/backoffice/auth/forgot-password", async (req, res) => {
  const GENERIC = { message: "If that email has a Back Office account, a reset link has been sent." };
  const { email } = req.body || {};
  if (typeof email !== "string" || !email.trim()) {
    return res.json(GENERIC);
  }
  const normalizedEmail = email.trim().toLowerCase();

  // Keyed by the email itself, same as login-step1. The record is created
  // unconditionally below regardless of whether the email matches a real
  // account, so a nonexistent email gets rate-limited identically to a
  // real one — hitting the lock reveals nothing about whether the account
  // exists, only that this address has had 3 reset requests recently.
  const rateCheck = checkRateLimit(normalizedEmail, "bo-forgot");
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: formatLockoutMessage(rateCheck.retryAfter), retryAfter: rateCheck.retryAfter });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, name, email FROM staff
        WHERE lower(email) = $1 AND active = true
          AND role IN ('owner','admin') AND password_hash IS NOT NULL`,
      [normalizedEmail]
    );
    const staff = rows[0];
    if (staff) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await pool.query(
        "UPDATE staff SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3",
        [hashResetToken(rawToken), expiry, staff.id]
      );
      const resetUrl = `${FRONTEND_URL}/backoffice/reset-password?token=${rawToken}`;
      await sendResendEmail({
        to: staff.email,
        subject: "Reset your Narcos Tacos Back Office password",
        html: `<p>Hi ${staff.name},</p>
<p>Someone requested a password reset for your Narcos Tacos Back Office login. Click below to set a new password — this link expires in 1 hour.</p>
<p><a href="${resetUrl}">${resetUrl}</a></p>
<p>If you didn't request this, you can safely ignore this email — your password hasn't changed.</p>`,
      });
    }
    const attempt = recordFailedAttempt(normalizedEmail, "bo-forgot");
    if (attempt.lockedOut) {
      // Still fine to reveal: this only says "this email just hit 3 reset
      // requests," which is the requester's own action, not evidence the
      // account exists (nonexistent emails accumulate identically above).
      return res.status(429).json({ error: formatLockoutMessage(attempt.retryAfter), retryAfter: attempt.retryAfter });
    }
    res.json(GENERIC);
  } catch (err) {
    console.error("forgot-password error:", err.message);
    res.json(GENERIC); // never let a server error leak through as a different response
  }
});

// POST /api/backoffice/auth/reset-password — { token, newPassword }
app.post("/api/backoffice/auth/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (typeof token !== "string" || !token) {
      throw new HttpError(400, "Reset token is required");
    }
    validatePasswordStrength(newPassword);

    const { rows } = await pool.query(
      "SELECT id FROM staff WHERE reset_token = $1 AND reset_token_expiry > now() AND active = true",
      [hashResetToken(token)]
    );
    const staff = rows[0];
    if (!staff) {
      throw new HttpError(400, "This reset link is invalid or has expired — request a new one");
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      "UPDATE staff SET password_hash = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2",
      [passwordHash, staff.id]
    );
    res.json({ success: true });
  } catch (err) {
    sendHttpError(res, err, "Failed to reset password");
  }
});

// POST /api/backoffice/auth/logout
app.post("/api/backoffice/auth/logout", (req, res) => {
  // clearCookie must be called with matching attributes (path, secure,
  // sameSite) or some browsers won't actually delete the cookie.
  res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOpts(req));
  res.json({ success: true });
});

// GET /api/backoffice/auth/me — lets the frontend silently check for an
// existing valid session on page load/refresh instead of always forcing a
// fresh login.
app.get("/api/backoffice/auth/me", async (req, res) => {
  try {
    const staff = await requireBackofficeSession(req);
    res.json({ id: staff.id, name: staff.name, role: staff.role });
  } catch (err) {
    sendHttpError(res, err, "Not authenticated");
  }
});

// --------------- Back Office: menu management ---------------
// Every route here re-verifies ON THE SERVER that the caller is an active
// owner/admin (403 otherwise) — same principle as checkout's server-side
// price recomputation: never trust the frontend to have hidden the button.

// Resolve staffId → active staff row with one of `allowedRoles`, or throw
// 401/403. The requester's role is ALWAYS looked up in the DB — a role sent
// in the request body/headers is never trusted.
//
// NOT used by any /api/backoffice/* route anymore — those all require a
// real Back Office session cookie now (requireBackofficeSession, below).
// This older helper survives ONLY for POST /api/staff/quick-add, which is
// deliberately outside /api/backoffice and lives in the PIN-authenticated
// POS/Order Entry world (no session cookie exists there — Order Entry's
// PIN login is untouched by this task). Renamed from requireBackofficeStaff
// to make that boundary obvious at every call site.
async function requireStaffIdParam(staffId, allowedRoles = ["owner", "admin"]) {
  const denied = `Access restricted to ${allowedRoles.join("/")}`;
  if (!staffId || typeof staffId !== "string") {
    throw new HttpError(401, "staffId is required");
  }
  let rows;
  try {
    ({ rows } = await pool.query(
      "SELECT id, name, role FROM staff WHERE id = $1 AND active = true",
      [staffId]
    ));
  } catch {
    // Malformed UUID etc. — treat as unknown staff
    throw new HttpError(403, denied);
  }
  const staff = rows[0];
  if (!staff || !allowedRoles.includes(staff.role)) {
    throw new HttpError(403, denied);
  }
  return staff;
}

// Resolve the Back Office session cookie → active staff row with one of
// `allowedRoles`, or throw 401/403. This is what closes the gap the old
// staffId-trusting helper left open: every /api/backoffice/* route used to
// accept whatever staffId the client sent in the query string or body,
// meaning any browser devtools user could impersonate any staff member by
// changing that value. Now the ONLY source of identity is SESSION_SECRET-
// signed JWT in an httpOnly cookie, issued exclusively by a real
// email+password+TOTP login (see the auth routes above) — nothing in the
// request body/query is ever consulted for who the caller is.
function readSessionStaffId(req) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    if (payload.purpose !== "session" || !payload.staffId) return null;
    return payload.staffId;
  } catch {
    return null; // expired/invalid/tampered — treat exactly like "not logged in"
  }
}

async function requireBackofficeSession(req, allowedRoles = ["owner", "admin"]) {
  const staffId = readSessionStaffId(req);
  if (!staffId) {
    throw new HttpError(401, "Not authenticated — please log in to Back Office");
  }
  const { rows } = await pool.query(
    "SELECT id, name, role, email FROM staff WHERE id = $1 AND active = true",
    [staffId]
  );
  const staff = rows[0];
  const denied = `Access restricted to ${allowedRoles.join("/")}`;
  if (!staff || !allowedRoles.includes(staff.role)) {
    throw new HttpError(403, denied);
  }
  return staff;
}

const sendHttpError = (res, err, fallbackMsg) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(fallbackMsg, err);
  return res.status(500).json({ error: fallbackMsg });
};

// --------------- Back Office: Stripe diagnostics (plan Slice 0.3) ---------------
// GET /api/backoffice/stripe/diagnostics
// Owner/admin only. Read-only: it creates nothing, charges nothing, and changes
// no state — two GETs against Stripe plus one local lookup.
//
// This is the endpoint that proves the backend can actually reach Stripe and
// see the reader BEFORE any payment code exists, and it stays useful afterwards
// as the "is the reader online?" check.
//
// It answers with 200 and a structured report even when Stripe is unreachable
// or unconfigured, rather than surfacing an HTTP error. A diagnostic's job is to
// report state — including bad state — and "not configured" is a perfectly valid
// answer while PAYMENTS_PROVIDER is still 'mock'. Callers read `reachable`, not
// the status code. Auth failures are the exception and still 401/403.
//
// The secret key is NEVER returned; only the test/live mode derived from its
// prefix, and whether a webhook secret exists at all.
app.get("/api/backoffice/stripe/diagnostics", async (req, res) => {
  try {
    await requireBackofficeSession(req); // owner/admin only

    const report = {
      paymentsProvider: PAYMENTS_PROVIDER,
      stripeConfigured: Boolean(stripeClient),
      keyMode: stripeClient ? stripeKeyMode(STRIPE_SECRET_KEY) : null,
      apiVersion: stripeClient ? STRIPE_API_VERSION : null,
      apiVersionSource: process.env.STRIPE_API_VERSION ? "env" : "sdk-default",
      webhookSecretConfigured: Boolean(STRIPE_WEBHOOK_SECRET),
      reachable: false,
      account: null,
      location: null,
      readers: [],
      readerSummary: null,
      tipping: null,
      // Actionable, human-readable notes about anything that looks half-wired.
      // Empty means nothing needed explaining.
      hints: [],
      error: null,
      checkedAt: new Date().toISOString(),
    };

    // Local half: is a Stripe Location actually wired to this store's row? The
    // id lives on locations.stripe_location_id rather than an env var so a
    // second store is configuration, not a code change (plan section 11).
    const { rows: locRows } = await pool.query(
      "SELECT id, name, stripe_location_id FROM locations WHERE active = true ORDER BY created_at LIMIT 1"
    );
    if (locRows[0]) {
      report.location = {
        localId: locRows[0].id,
        name: locRows[0].name,
        stripeLocationId: locRows[0].stripe_location_id,
        configured: Boolean(locRows[0].stripe_location_id),
      };
    }

    if (!stripeClient) {
      report.error =
        "STRIPE_SECRET_KEY is not set, so no Stripe client was constructed. " +
        "This is expected while PAYMENTS_PROVIDER=mock and nothing is broken.";
      return res.json(report);
    }

    try {
      const account = await stripeClient.accounts.retrieve();
      report.account = {
        id: account.id,
        country: account.country,
        defaultCurrency: account.default_currency,
        chargesEnabled: account.charges_enabled,
      };

      // ALWAYS list every reader on the account — never filtered server-side by
      // location. An earlier version passed `location: <configured id>`, which
      // made a mismatch indistinguishable from "no readers exist": a reader
      // registered to a different Location, or a stripe_location_id carrying
      // stray whitespace from a copy-paste, both came back as an empty array
      // with nothing to explain why. Hiding the evidence is the one thing a
      // diagnostic must not do, so the match is computed here and REPORTED
      // instead of applied as a filter.
      const rawLocationId = report.location ? report.location.stripeLocationId : null;
      const configuredLocationId = rawLocationId ? String(rawLocationId).trim() : null;

      const readers = await stripeClient.terminal.readers.list({ limit: 100 });
      report.readers = readers.data.map((r) => ({
        id: r.id,
        label: r.label,
        status: r.status, // 'online' | 'offline'
        deviceType: r.device_type,
        serialNumber: r.serial_number,
        locationId: r.location,
        ipAddress: r.ip_address,
        // null = we have no configured Location to compare against yet.
        matchesConfiguredLocation: configuredLocationId ? r.location === configuredLocationId : null,
      }));
      report.readerSummary = {
        total: report.readers.length,
        matchingConfiguredLocation: configuredLocationId
          ? report.readers.filter((r) => r.matchesConfiguredLocation).length
          : null,
      };

      // Tipping (Slice 4). Reports what the readers will actually offer, so
      // "are the 15/18/20% options live?" is answerable from here instead of by
      // standing in front of the device. Best-effort: a failure to read the
      // configuration must not fail the whole diagnostic.
      try {
        const configs = await stripeClient.terminal.configurations.list({ limit: 10 });
        report.tipping = configs.data.map((c) => ({
          id: c.id,
          isAccountDefault: Boolean(c.is_account_default),
          // Percentages are per-currency; CAD is the one that matters here.
          percentages: c.tipping?.cad?.percentages || null,
          fixedAmounts: c.tipping?.cad?.fixed_amounts || null,
          smartTipThreshold: c.tipping?.cad?.smart_tip_threshold ?? null,
        }));
        if (report.tipping.length === 0) {
          report.hints.push(
            "No Terminal Configuration found, so readers will use Stripe's defaults. " +
              "Create one to control the 15/18/20% tip options."
          );
        } else if (!report.tipping.some((t) => t.percentages?.length)) {
          report.hints.push(
            "A Terminal Configuration exists but defines no CAD tip percentages — the reader " +
              "will not offer percentage tips."
          );
        }
      } catch (err) {
        console.error("Could not list Terminal configurations:", err.message);
      }

      // Turn the two silent-empty cases into an explicit, actionable answer.
      if (rawLocationId && rawLocationId !== configuredLocationId) {
        report.hints.push(
          `locations.stripe_location_id has leading/trailing whitespace ("${rawLocationId}"). ` +
            `Readers are matched on the trimmed value; fix the stored value to avoid surprises elsewhere.`
        );
      }
      if (report.readers.length === 0) {
        report.hints.push(
          "Stripe reports no registered readers on this account at all. If a reader is visible in the " +
            "Dashboard, check that this key belongs to the same account/sandbox the reader was registered in."
        );
      } else if (configuredLocationId && report.readerSummary.matchingConfiguredLocation === 0) {
        report.hints.push(
          `${report.readers.length} reader(s) exist, but none are assigned to the configured Location ` +
            `(${configuredLocationId}). Readers are on: ` +
            `${[...new Set(report.readers.map((r) => r.locationId || "no location"))].join(", ")}. ` +
            `Either re-register the reader to that Location, or point locations.stripe_location_id at the one it is on.`
        );
      }
      if (!configuredLocationId) {
        report.hints.push(
          "locations.stripe_location_id is not set, so readers cannot be matched to this store yet."
        );
      }

      report.reachable = true;
    } catch (stripeErr) {
      // A bad key, a network failure or a rejected API version all land here.
      // Report it plainly — that IS the diagnostic working.
      report.error = stripeErr.message;
      report.errorType = stripeErr.type || null;
      report.errorCode = stripeErr.code || null;
      console.error("Stripe diagnostics failed:", stripeErr.message);
    }

    res.json(report);
  } catch (err) {
    sendHttpError(res, err, "Failed to run Stripe diagnostics");
  }
});

// GET /api/backoffice/menu?staffId=...
// Full menu tree INCLUDING inactive items/variants/modifier groups/options
// (the public /api/menu/full keeps hiding inactive rows) — owners need to
// see and reactivate 86'd rows at every level, and the Manage Menu editor
// needs the full picture (including inactive) to actually edit it. This is
// now the ONE authoritative source for the editor — it used to also fetch
// modifier data read-only from the public route; that's gone now that
// modifier groups/options are editable here.
app.get("/api/backoffice/menu", async (req, res) => {
  try {
    await requireBackofficeSession(req);

    const { rows: categories } = await pool.query(
      "SELECT id, name, sort_order FROM menu_categories WHERE active = true ORDER BY sort_order"
    );
    const { rows: items } = await pool.query(
      `SELECT id, category_id, name, description, base_price, active, sort_order, is_upsell
         FROM menu_items ORDER BY sort_order, name`
    );
    const { rows: variants } = await pool.query(
      `SELECT id, item_id, name, price, active, sort_order
         FROM item_variants WHERE active = true ORDER BY sort_order`
    );
    // Modifier groups/options are filtered to active-only here, same as
    // variants/categories above — unlike menu items (which deliberately
    // stay visible-but-dimmed when 86'd, with a Reactivate path), groups/
    // options no longer expose an active/inactive distinction in the
    // editor at all: "Remove" always looks like a clean removal to the
    // owner, whether the server hard-deleted it or, because it's
    // referenced by real order history, soft-deleted it instead (see the
    // DELETE routes below). Filtering here is what actually makes a
    // soft-deleted option/group disappear from the editor.
    const { rows: itemGroups } = await pool.query(
      `SELECT img.item_id, mg.id, mg.name, mg.min_select, mg.max_select, mg.required, mg.active
         FROM item_modifier_groups img
         JOIN modifier_groups mg ON mg.id = img.modifier_group_id
        WHERE mg.active = true
        ORDER BY img.sort_order`
    );
    const { rows: options } = await pool.query(
      `SELECT id, group_id, name, price_delta, sort_order, max_quantity, default_selected, active
         FROM modifier_options WHERE active = true ORDER BY sort_order`
    );

    const optionsByGroup = {};
    for (const o of options) (optionsByGroup[o.group_id] ||= []).push(o);

    const groupsByItem = {};
    for (const g of itemGroups) {
      (groupsByItem[g.item_id] ||= []).push({
        id: g.id,
        name: g.name,
        min_select: g.min_select,
        max_select: g.max_select,
        required: g.required,
        active: g.active,
        options: optionsByGroup[g.id] || [],
      });
    }

    const variantsByItem = {};
    for (const v of variants) (variantsByItem[v.item_id] ||= []).push(v);

    const itemsByCat = {};
    for (const it of items) {
      (itemsByCat[it.category_id] ||= []).push({
        ...it,
        variants: variantsByItem[it.id] || [],
        modifier_groups: groupsByItem[it.id] || [],
      });
    }

    res.json(categories.map((c) => ({ ...c, items: itemsByCat[c.id] || [] })));
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch back office menu");
  }
});

// Shared field validation for menu item create/update
function validateItemFields({ name, base_price }) {
  if (typeof name !== "string" || !name.trim()) {
    throw new HttpError(400, "name is required");
  }
  const price = Number(base_price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new HttpError(400, "base_price must be a positive number");
  }
  return { name: name.trim(), price };
}

// PUT /api/backoffice/menu-items/:id
// Body: { staffId, name, description, base_price, active, is_upsell? }
// is_upsell is optional: callers that don't manage it (e.g. the 86 toggle)
// omit it, and COALESCE below preserves whatever is already stored.
app.put("/api/backoffice/menu-items/:id", async (req, res) => {
  try {
    const { description, active, is_upsell } = req.body || {};
    await requireBackofficeSession(req);
    const { name, price } = validateItemFields(req.body || {});
    if (typeof active !== "boolean") {
      throw new HttpError(400, "active must be a boolean");
    }
    if (is_upsell !== undefined && typeof is_upsell !== "boolean") {
      throw new HttpError(400, "is_upsell must be a boolean");
    }

    const { rows } = await pool.query(
      `UPDATE menu_items
          SET name = $1, description = $2, base_price = $3, active = $4,
              is_upsell = COALESCE($5, is_upsell)
        WHERE id = $6
        RETURNING id, category_id, name, description, base_price, active, sort_order, is_upsell`,
      [name, description || null, price, active, is_upsell ?? null, req.params.id]
    );
    if (rows.length === 0) throw new HttpError(404, "Menu item not found");
    res.json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to update menu item");
  }
});

// POST /api/backoffice/menu-items
// Body: { staffId, category_id, name, description, base_price }
app.post("/api/backoffice/menu-items", async (req, res) => {
  try {
    const { category_id, description } = req.body || {};
    await requireBackofficeSession(req);
    const { name, price } = validateItemFields(req.body || {});
    if (!category_id || typeof category_id !== "string") {
      throw new HttpError(400, "category_id is required");
    }

    const { rows: catRows } = await pool.query(
      "SELECT id FROM menu_categories WHERE id = $1 AND active = true",
      [category_id]
    );
    if (catRows.length === 0) throw new HttpError(400, "Unknown category");

    const isUpsell = typeof req.body?.is_upsell === "boolean" ? req.body.is_upsell : false;
    const { rows } = await pool.query(
      `INSERT INTO menu_items (category_id, name, description, base_price, active, is_upsell)
       VALUES ($1, $2, $3, $4, true, $5)
       RETURNING id, category_id, name, description, base_price, active, sort_order, is_upsell`,
      [category_id, name, description || null, price, isUpsell]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to create menu item");
  }
});

// Shared field validation for variant create/update
function validateVariantFields({ name, price }) {
  if (typeof name !== "string" || !name.trim()) {
    throw new HttpError(400, "name is required");
  }
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) {
    throw new HttpError(400, "price must be a positive number");
  }
  return { name: name.trim(), price: p };
}

// PUT /api/backoffice/item-variants/:id
// Body: { staffId, name, price }
app.put("/api/backoffice/item-variants/:id", async (req, res) => {
  try {
    await requireBackofficeSession(req);
    const { name, price } = validateVariantFields(req.body || {});

    const { rows } = await pool.query(
      `UPDATE item_variants SET name = $1, price = $2
        WHERE id = $3
        RETURNING id, item_id, name, price, active, sort_order`,
      [name, price, req.params.id]
    );
    if (rows.length === 0) throw new HttpError(404, "Variant not found");
    res.json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to update variant");
  }
});

// POST /api/backoffice/item-variants
// Body: { staffId, item_id, name, price }
app.post("/api/backoffice/item-variants", async (req, res) => {
  try {
    const { item_id } = req.body || {};
    await requireBackofficeSession(req);
    const { name, price } = validateVariantFields(req.body || {});
    if (!item_id || typeof item_id !== "string") {
      throw new HttpError(400, "item_id is required");
    }

    const { rows: itemRows } = await pool.query(
      "SELECT id FROM menu_items WHERE id = $1",
      [item_id]
    );
    if (itemRows.length === 0) throw new HttpError(400, "Unknown menu item");

    const { rows } = await pool.query(
      `INSERT INTO item_variants (item_id, name, price)
       VALUES ($1, $2, $3)
       RETURNING id, item_id, name, price, active, sort_order`,
      [item_id, name, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to create variant");
  }
});

// --------------- Back Office: modifier group / option management ---------------
// Same owner/admin-only pattern as every other backoffice route. Modifier
// groups can be shared across multiple items (e.g. a common "Ingredients"
// group), so "remove from this item" and "delete the group definition
// entirely" stay deliberately separate actions:
//   - DELETE /item-modifier-groups/:itemId/:groupId unlinks ONE item, always
//     safe (never touches order_item_modifiers, never affects other items)
//   - DELETE /modifier-groups/:id removes the group DEFINITION (cascading to
//     every item that uses it and all its options).
// Same for individual options (DELETE /modifier-options/:id).
//
// "Delete" and "deactivate" used to be two visible concepts (a hard
// delete blocked with a 409 if referenced by real order history, forcing
// the caller to deactivate instead). Per real usability feedback, the
// editor now exposes ONE "Remove" action for options/groups — these two
// DELETE routes make the hard-vs-soft decision themselves, invisibly:
// hard-delete if nothing references it, soft-delete (active=false) if
// order history does, either way returning the same success shape. GET
// /api/backoffice/menu only returns active groups/options, so a
// soft-deleted one simply disappears from the editor exactly like a
// hard-deleted one would — no special messaging needed for the normal
// case, matching how variants/categories already filter to active-only.

function validateGroupFields({ name, required, min_select, max_select }) {
  if (typeof name !== "string" || !name.trim()) {
    throw new HttpError(400, "name is required");
  }
  if (typeof required !== "boolean") {
    throw new HttpError(400, "required must be a boolean");
  }
  const min = Number(min_select);
  const max = Number(max_select);
  if (!Number.isInteger(min) || min < 0) {
    throw new HttpError(400, "min_select must be a non-negative integer");
  }
  if (!Number.isInteger(max) || max < 1) {
    throw new HttpError(400, "max_select must be a positive integer");
  }
  if (min > max) {
    throw new HttpError(400, "min_select cannot be greater than max_select");
  }
  return { name: name.trim(), min, max };
}

// max_quantity is deliberately NOT accepted here anymore — it's been
// removed from the owner-facing edit UI entirely (per usability
// feedback; the customer-facing quantity stepper on Order Entry is
// unaffected and keeps reading whatever value is already in the
// database). New options get DEFAULT_OPTION_MAX_QUANTITY below; existing
// options keep whatever value they already have — the PUT route simply
// never touches that column anymore.
const DEFAULT_OPTION_MAX_QUANTITY = 5; // matches the existing convention for every stepper-style add-on already in the data (Extra Taco, and each Dipping Sauce flavor all use 5 — see menu_ux_enhancements.sql)

// Plain-ingredient-style groups (Ingredients, Toppings) are always free —
// the price field is hidden from the owner-facing edit UI for options in
// these groups, and this is what makes that trustworthy: even if a client
// somehow sent a nonzero price_delta, it's forced back to 0 here rather
// than relying on the UI never showing the field (same never-trust-the-
// client principle used for discounts elsewhere in this file).
const PRICELESS_GROUP_NAMES = /^(ingredients|toppings)$/i;
const isPricelessGroupName = (name) => PRICELESS_GROUP_NAMES.test((name || "").trim());

function validateOptionFields({ name, price_delta, default_selected }) {
  if (typeof name !== "string" || !name.trim()) {
    throw new HttpError(400, "name is required");
  }
  const delta = Number(price_delta);
  if (!Number.isFinite(delta) || delta < 0) {
    throw new HttpError(400, "price_delta must be a non-negative number");
  }
  if (typeof default_selected !== "boolean") {
    throw new HttpError(400, "default_selected must be a boolean");
  }
  return { name: name.trim(), delta };
}

// POST /api/backoffice/modifier-groups
// Body: { staffId, item_id, name, required, min_select, max_select }
// Creates a new group AND links it to item_id in one step — this editor is
// always item-scoped (matches the detail-panel UX), so a brand-new group is
// always born attached to the item it was created from.
app.post("/api/backoffice/modifier-groups", async (req, res) => {
  const client = await pool.connect();
  try {
    const { item_id } = req.body || {};
    await requireBackofficeSession(req);
    const { name, min, max } = validateGroupFields(req.body || {});
    if (!item_id || typeof item_id !== "string") {
      throw new HttpError(400, "item_id is required");
    }

    await client.query("BEGIN");
    const { rows: itemRows } = await client.query("SELECT id FROM menu_items WHERE id = $1", [item_id]);
    if (itemRows.length === 0) throw new HttpError(400, "Unknown menu item");

    const { rows } = await client.query(
      `INSERT INTO modifier_groups (name, min_select, max_select, required, active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, name, min_select, max_select, required, active`,
      [name, min, max, req.body.required]
    );
    const group = rows[0];
    await client.query(
      `INSERT INTO item_modifier_groups (item_id, modifier_group_id) VALUES ($1, $2)`,
      [item_id, group.id]
    );
    await client.query("COMMIT");
    res.status(201).json({ ...group, item_id, options: [] });
  } catch (err) {
    await client.query("ROLLBACK");
    sendHttpError(res, err, "Failed to create modifier group");
  } finally {
    client.release();
  }
});

// PUT /api/backoffice/modifier-groups/:id
// Body: { staffId, name, required, min_select, max_select, active }
app.put("/api/backoffice/modifier-groups/:id", async (req, res) => {
  try {
    const { active } = req.body || {};
    await requireBackofficeSession(req);
    const { name, min, max } = validateGroupFields(req.body || {});
    if (typeof active !== "boolean") {
      throw new HttpError(400, "active must be a boolean");
    }

    const { rows } = await pool.query(
      `UPDATE modifier_groups SET name = $1, min_select = $2, max_select = $3, required = $4, active = $5
        WHERE id = $6
        RETURNING id, name, min_select, max_select, required, active`,
      [name, min, max, req.body.required, active, req.params.id]
    );
    if (rows.length === 0) throw new HttpError(404, "Modifier group not found");
    res.json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to update modifier group");
  }
});

// DELETE /api/backoffice/modifier-groups/:id?staffId=...
// The single "Remove" action for a group — hard-deletes the group
// DEFINITION (cascades to item_modifier_groups links and modifier_options)
// if nothing references it in real order history; if it IS referenced,
// soft-deletes (active=false) instead so historical orders stay intact.
// Both paths return the same success shape — the caller can't tell which
// happened, and doesn't need to: GET /api/backoffice/menu excludes
// inactive groups, so either way it just disappears from the editor.
app.delete("/api/backoffice/modifier-groups/:id", async (req, res) => {
  try {
    await requireBackofficeSession(req);

    const { rows: refRows } = await pool.query(
      `SELECT count(*)::int AS n FROM order_item_modifiers oim
         JOIN modifier_options mo ON mo.id = oim.modifier_option_id
        WHERE mo.group_id = $1`,
      [req.params.id]
    );

    // Same in-flight window as the option route above, and it matters more
    // here: deleting a group CASCADES to its options, so one menu edit could
    // remove several rows a committed, already-charging checkout still needs.
    const { rows: pendRows } = await pool.query(
      `SELECT count(*)::int AS n
         FROM pending_checkouts pc
        WHERE pc.status = 'awaiting_payment'
          AND EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(pc.payload->'lines') AS line,
                       jsonb_array_elements(line->'modifiers') AS m
                  JOIN modifier_options mo ON mo.id = (m->>'optionId')::uuid
                 WHERE mo.group_id = $1
              )`,
      [req.params.id]
    );

    if (refRows[0].n > 0 || pendRows[0].n > 0) {
      const { rows } = await pool.query(
        "UPDATE modifier_groups SET active = false WHERE id = $1 RETURNING id",
        [req.params.id]
      );
      if (rows.length === 0) throw new HttpError(404, "Modifier group not found");
      return res.json({ success: true, id: rows[0].id });
    }

    const { rows } = await pool.query(
      "DELETE FROM modifier_groups WHERE id = $1 RETURNING id",
      [req.params.id]
    );
    if (rows.length === 0) throw new HttpError(404, "Modifier group not found");
    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    sendHttpError(res, err, "Failed to remove modifier group");
  }
});

// DELETE /api/backoffice/item-modifier-groups/:itemId/:groupId?staffId=...
// Unlinks a group from ONE item only — always safe (doesn't touch
// modifier_options or order history), since the group may still be used by
// other items.
app.delete("/api/backoffice/item-modifier-groups/:itemId/:groupId", async (req, res) => {
  try {
    await requireBackofficeSession(req);
    const { rows } = await pool.query(
      `DELETE FROM item_modifier_groups WHERE item_id = $1 AND modifier_group_id = $2 RETURNING item_id`,
      [req.params.itemId, req.params.groupId]
    );
    if (rows.length === 0) throw new HttpError(404, "That group isn't linked to this item");
    res.json({ success: true });
  } catch (err) {
    sendHttpError(res, err, "Failed to remove modifier group from item");
  }
});

// POST /api/backoffice/modifier-options
// Body: { staffId, group_id, name, price_delta, default_selected }
// max_quantity is no longer client-supplied — every new option gets
// DEFAULT_OPTION_MAX_QUANTITY, invisibly. Order Entry's quantity stepper
// still reads this column exactly as before; only the owner-facing
// ability to see/set it during menu editing is gone.
app.post("/api/backoffice/modifier-options", async (req, res) => {
  try {
    const { group_id } = req.body || {};
    await requireBackofficeSession(req);
    const { name, delta } = validateOptionFields(req.body || {});
    if (!group_id || typeof group_id !== "string") {
      throw new HttpError(400, "group_id is required");
    }

    const { rows: groupRows } = await pool.query("SELECT id, name FROM modifier_groups WHERE id = $1", [group_id]);
    if (groupRows.length === 0) throw new HttpError(400, "Unknown modifier group");
    const isPlainIngredient = isPricelessGroupName(groupRows[0].name);
    const finalDelta = isPlainIngredient ? 0 : delta;
    // A plain-ingredient group is a checkbox list ("Included"/"Removed"), not a
    // quantity choice — nobody orders three lettuces. Giving these the stepper
    // default is what made owner-added toppings render as "− 1 +" while the
    // seeded ones stayed checkboxes. Same classifier that forces price to 0
    // above: a group that is always free is never a paid quantity choice.
    const finalMaxQty = isPlainIngredient ? 1 : DEFAULT_OPTION_MAX_QUANTITY;

    const { rows } = await pool.query(
      `INSERT INTO modifier_options (group_id, name, price_delta, max_quantity, default_selected, active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, group_id, name, price_delta, sort_order, max_quantity, default_selected, active`,
      [group_id, name, finalDelta, finalMaxQty, req.body.default_selected]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to create modifier option");
  }
});

// PUT /api/backoffice/modifier-options/:id
// Body: { staffId, name, price_delta, default_selected, active }
// max_quantity is deliberately excluded from the UPDATE — whatever value
// an option already has (the default for new ones, or a previously-set
// value for older ones) is left completely untouched by edits made
// through this route now that the field isn't editable anymore.
app.put("/api/backoffice/modifier-options/:id", async (req, res) => {
  try {
    const { active } = req.body || {};
    await requireBackofficeSession(req);
    const { name, delta } = validateOptionFields(req.body || {});
    if (typeof active !== "boolean") {
      throw new HttpError(400, "active must be a boolean");
    }

    const { rows: optionRows } = await pool.query(
      `SELECT mg.name AS group_name FROM modifier_options mo
         JOIN modifier_groups mg ON mg.id = mo.group_id
        WHERE mo.id = $1`,
      [req.params.id]
    );
    if (optionRows.length === 0) throw new HttpError(404, "Modifier option not found");
    const finalDelta = isPricelessGroupName(optionRows[0].group_name) ? 0 : delta;

    const { rows } = await pool.query(
      `UPDATE modifier_options
          SET name = $1, price_delta = $2, default_selected = $3, active = $4
        WHERE id = $5
        RETURNING id, group_id, name, price_delta, sort_order, max_quantity, default_selected, active`,
      [name, finalDelta, req.body.default_selected, active, req.params.id]
    );
    if (rows.length === 0) throw new HttpError(404, "Modifier option not found");
    res.json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to update modifier option");
  }
});

// DELETE /api/backoffice/modifier-options/:id?staffId=...
// The single "Remove" action — hard-deletes if never used in a real
// order; if it IS referenced, soft-deletes (active=false) instead so
// historical orders stay intact. Same success shape either way; GET
// /api/backoffice/menu excludes inactive options, so it just disappears
// from the editor regardless of which path was taken.
// Does an in-flight card checkout still need this modifier option?
//
// A pending checkout has been PRICED and may already be charging at the reader,
// but it has no order_items rows yet — those are written from the webhook. So
// the "is anything referencing this?" check that guards a hard delete looks
// straight through it, and an owner editing the menu mid-service could delete a
// row the deferred order insert still needs, failing it on a foreign key AFTER
// the customer has been charged. Explicitly called out in the Stripe Terminal
// plan as the one new hazard Option B introduces.
//
// Scoped to 'awaiting_payment' only: a settled, failed, cancelled or expired
// checkout is never inserted from, so it must not pin the menu forever.
async function pendingCheckoutsUsingModifierOption(optionId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM pending_checkouts pc
      WHERE pc.status = 'awaiting_payment'
        AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(pc.payload->'lines') AS line,
                     jsonb_array_elements(line->'modifiers') AS m
               WHERE m->>'optionId' = $1
            )`,
    [optionId]
  );
  return rows[0].n;
}

app.delete("/api/backoffice/modifier-options/:id", async (req, res) => {
  try {
    await requireBackofficeSession(req);

    const { rows: refRows } = await pool.query(
      "SELECT count(*)::int AS n FROM order_item_modifiers WHERE modifier_option_id = $1",
      [req.params.id]
    );
    const inFlight = await pendingCheckoutsUsingModifierOption(req.params.id);

    // Soft-delete when real history references it OR a card payment is in
    // flight against it. Deactivating is safe either way — it hides the option
    // from the editor and from Order Entry while leaving the row (and so the
    // foreign key the pending insert depends on) intact.
    if (refRows[0].n > 0 || inFlight > 0) {
      const { rows } = await pool.query(
        "UPDATE modifier_options SET active = false WHERE id = $1 RETURNING id",
        [req.params.id]
      );
      if (rows.length === 0) throw new HttpError(404, "Modifier option not found");
      return res.json({ success: true, id: rows[0].id });
    }

    const { rows } = await pool.query(
      "DELETE FROM modifier_options WHERE id = $1 RETURNING id",
      [req.params.id]
    );
    if (rows.length === 0) throw new HttpError(404, "Modifier option not found");
    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    sendHttpError(res, err, "Failed to remove modifier option");
  }
});

// --------------- Back Office: staff management ---------------
// Back Office access (this section) is owner/admin ONLY — Manager's Back
// Office access was fully revoked. List/edit/deactivate/PIN-reset all
// require the REQUESTER to be owner/admin server-side, then apply hierarchy
// protection based on the TARGET row's current role:
//   target owner → only an owner may act on it
//   target admin → only owner or admin
//   target manager/cashier/kitchen → owner or admin (manager can no longer
//     reach these routes at all, so its old "manager can act on
//     manager/cashier/kitchen" branch in canManageTarget below is now
//     unreachable via these routes — left as-is since it's still correct,
//     just moot here)
// Raw PINs are hashed server-side and never logged, echoed, or returned.
// Manager's ONE surviving staff capability is POST /api/staff/quick-add
// (add-only, outside /api/backoffice — see STAFF_MANAGER_ROLES below).

const STAFF_MANAGER_ROLES = ["owner", "admin", "manager"]; // used ONLY by POST /api/staff/quick-add
const STAFF_ROLES = ["owner", "admin", "manager", "cashier", "kitchen"];
// Columns safe to return — pin_hash is NEVER selected.
const STAFF_SAFE_COLS =
  "id, location_id, name, title, phone, email, role, hourly_rate, hire_date, active, created_at";

function canManageTarget(requesterRole, targetRole) {
  if (targetRole === "owner") return requesterRole === "owner";
  if (targetRole === "admin") return requesterRole === "owner" || requesterRole === "admin";
  return true; // manager/cashier/kitchen rows
}

// Only owners may hand out the owner or admin role (create OR promote) —
// prevents privilege escalation by admins/managers.
function assertRoleAssignable(requesterRole, newRole) {
  if ((newRole === "owner" || newRole === "admin") && requesterRole !== "owner") {
    throw new HttpError(403, "Only an owner can assign the owner or admin role");
  }
}

function validatePin(pin) {
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    throw new HttpError(400, "PIN must be exactly 4 digits");
  }
}

// PINs must be unique among ACTIVE staff (login matches the PIN against all
// active hashes, so a duplicate would log in as whoever matches first).
// Compares against every active hash; excludeId skips the row being updated.
async function assertPinAvailable(pin, excludeId = null) {
  const { rows } = await pool.query(
    "SELECT id, pin_hash FROM staff WHERE active = true"
  );
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    if (await bcrypt.compare(pin, row.pin_hash)) {
      throw new HttpError(409, "That PIN is already in use — choose another");
    }
  }
}

// Real history = orders they placed or applied a discount on, or shifts
// they clocked — anything that would leave a dangling reference (or lose
// real business history) if the staff row were hard-deleted. Used both
// to decide the smart-delete outcome (see smartDeleteStaff) AND surfaced
// ahead of time via has_history on staff list responses, so the client
// can word its confirmation dialog correctly before the user commits.
// Both uses share this exact SQL fragment so they can never drift apart.
const STAFF_HISTORY_EXISTS_SQL = `(
  EXISTS(SELECT 1 FROM shifts WHERE shifts.staff_id = staff.id)
  OR EXISTS(SELECT 1 FROM orders WHERE orders.staff_id = staff.id OR orders.discount_applied_by = staff.id)
)`;

async function staffHasHistory(staffId) {
  const { rows } = await pool.query(
    `SELECT ${STAFF_HISTORY_EXISTS_SQL} AS has_history FROM staff WHERE id = $1`,
    [staffId]
  );
  return rows[0]?.has_history || false;
}

// Shared "smart delete" outcome for both DELETE routes below. Hierarchy
// protection (who's ALLOWED to act on this target) must already have
// been checked by the caller via requireManagedTarget before this runs —
// this function only decides WHAT removal means once permission is
// already established, per the task's separation of those two concerns.
async function smartDeleteStaff(target) {
  const hasHistory = await staffHasHistory(target.id);
  if (hasHistory) {
    await pool.query("UPDATE staff SET active = false WHERE id = $1", [target.id]);
    return {
      success: true,
      action: "deactivated",
      id: target.id,
      message: `${target.name} has order/shift history and can't be deleted — deactivated instead`,
    };
  }
  await pool.query("DELETE FROM staff WHERE id = $1", [target.id]);
  return { success: true, action: "deleted", id: target.id };
}

// GET /api/backoffice/staff?staffId=...
// All staff, active AND inactive, without pin_hash. Full Back Office staff
// list — owner/admin only (Back Office access was fully revoked from
// Manager; their only remaining staff capability is the separate POS
// quick-add route below).
app.get("/api/backoffice/staff", async (req, res) => {
  try {
    await requireBackofficeSession(req);
    const { rows } = await pool.query(
      `SELECT ${STAFF_SAFE_COLS}, ${STAFF_HISTORY_EXISTS_SQL} AS has_history FROM staff
        ORDER BY active DESC, array_position(ARRAY['owner','admin','manager','cashier','kitchen'], role::text), name`
    );
    res.json(rows);
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch staff");
  }
});

// GET /api/backoffice/staff/live-status
// Owner/admin only — every staff member currently clocked in (open shift,
// any location), with their live status and the relevant since-timestamp
// (shift clock_in if working, break_start if on break). Powers Back Office
// Home's Live Status card. The clock-in/out actions themselves are Order
// Entry-only (cashier/kitchen have no Back Office access at all) — this is
// read-only visibility into that same state, not a duplicate of the
// actions.
app.get("/api/backoffice/staff/live-status", async (req, res) => {
  try {
    await requireBackofficeSession(req);

    const { rows } = await pool.query(
      `SELECT st.id AS staff_id, st.name, st.role, s.clock_in, b.break_start
         FROM shifts s
         JOIN staff st ON st.id = s.staff_id
         LEFT JOIN LATERAL (
           SELECT break_start FROM shift_breaks
            WHERE shift_id = s.id AND break_end IS NULL
            ORDER BY break_start DESC LIMIT 1
         ) b ON true
        WHERE s.clock_out IS NULL
        ORDER BY st.name`
    );

    res.json(
      rows.map((r) => ({
        staffId: r.staff_id,
        name: r.name,
        role: r.role,
        status: r.break_start ? "on_break" : "working",
        since: r.break_start || r.clock_in,
      }))
    );
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch live staff status");
  }
});

// Shared create-staff logic for the two routes below, which differ ONLY in
// who's allowed to call them and HOW that requester was authenticated:
//   POST /api/backoffice/staff  — full Back Office "+ Add Staff", owner/
//                                 admin only, authenticated via the Back
//                                 Office session cookie
//   POST /api/staff/quick-add   — POS account-dropdown quick-add modal,
//                                 owner/admin/manager (Manager's one
//                                 remaining staff capability post-
//                                 revocation), authenticated via the
//                                 PIN-login staffId the POS already holds
// Both still run assertRoleAssignable, so Manager can never hand out
// owner/admin through the quick-add route either. `requester` is resolved
// by the caller (different auth mechanism per route) and passed in.
async function createStaffMember(req, res, requester) {
  try {
    const { name, role, hourly_rate, pin, email } = req.body || {};

    if (typeof name !== "string" || !name.trim()) {
      throw new HttpError(400, "name is required");
    }
    if (!STAFF_ROLES.includes(role)) {
      throw new HttpError(400, "role must be one of owner/admin/manager/cashier/kitchen");
    }
    assertRoleAssignable(requester.role, role);
    const rate = Number(hourly_rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new HttpError(400, "hourly_rate must be a positive number");
    }
    validatePin(pin);
    await assertPinAvailable(pin);

    // Email only ever means anything for owner/admin (the only roles that
    // get Back Office login) — silently dropped for every other role even
    // if one somehow arrives in the body, matching the frontend never
    // showing the field outside those two roles. (In practice this branch
    // is unreachable for manager-initiated quick-add: assertRoleAssignable
    // above already blocks manager from creating an owner/admin at all.)
    let emailToStore = null;
    const isBackofficeRole = role === "owner" || role === "admin";
    if (isBackofficeRole && typeof email === "string" && email.trim()) {
      emailToStore = normalizeEmail(email);
      const { rows: existing } = await pool.query("SELECT id FROM staff WHERE lower(email) = $1", [emailToStore]);
      if (existing.length > 0) throw new HttpError(409, "That email is already in use");
    }

    // Owners span all locations (location_id NULL, per schema design);
    // everyone else is scoped to the single active location.
    let locationId = null;
    if (role !== "owner") {
      const { rows: locRows } = await pool.query(
        "SELECT id FROM locations WHERE active = true ORDER BY created_at LIMIT 1"
      );
      if (locRows.length === 0) throw new HttpError(500, "No active location");
      locationId = locRows[0].id;
    }

    const pinHash = await bcrypt.hash(pin, 10);
    const title = role.charAt(0).toUpperCase() + role.slice(1);
    const { rows } = await pool.query(
      `INSERT INTO staff (location_id, name, title, pin_hash, role, hourly_rate, email, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING ${STAFF_SAFE_COLS}`,
      [locationId, name.trim(), title, pinHash, role, rate, emailToStore]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to create staff member");
  }
}

// POST /api/backoffice/staff — Back Office "+ Add Staff", owner/admin only,
// session-cookie authenticated (closes the old staffId-trust gap).
app.post("/api/backoffice/staff", async (req, res) => {
  try {
    const requester = await requireBackofficeSession(req, ["owner", "admin"]);
    await createStaffMember(req, res, requester);
  } catch (err) {
    sendHttpError(res, err, "Failed to create staff member");
  }
});

// POST /api/staff/quick-add — POS account-dropdown "Staff Management"
// quick-add modal, owner/admin/manager. Deliberately NOT under /api/backoffice
// so it isn't swept up by the Back Office access revocation — this is
// Manager's one surviving staff action (add-only, no list/edit/PIN-reset).
// Stays staffId-body-authenticated on purpose: Order Entry is PIN-login
// only and has no Back Office session cookie to send.
app.post("/api/staff/quick-add", async (req, res) => {
  try {
    const requester = await requireStaffIdParam((req.body || {}).staffId, STAFF_MANAGER_ROLES);
    await createStaffMember(req, res, requester);
  } catch (err) {
    sendHttpError(res, err, "Failed to create staff member");
  }
});

// --------------- POS Staff Management popup (Order Entry, owner/admin) ---------------
// Same trusted-staffId pattern as POST /api/staff/quick-add above — no
// Back Office session cookie, and critically, no dependency on ever having
// logged into Back Office on this device at all (that was the bug in the
// previous version of this popup, which reused /api/backoffice/staff* and
// therefore silently required a separate email+password+TOTP login on the
// same browser). Deliberately NOT under /api/backoffice/* so it can never
// be swept into that cookie-only auth model. requireStaffIdParam's default
// allowedRoles is already exactly ["owner", "admin"], so every route below
// just omits the second argument.
//
// Scope is deliberately smaller than Back Office's StaffManager: view +
// add (reuses quick-add, not duplicated) + deactivate/reactivate + reset
// PIN only. No role/hourly-rate editing here — that stays Back-Office-
// only, unchanged, a deliberate split between "quick troubleshooting on
// the counter tablet" and "full HR editing," not an oversight.

// Same query shape as GET /api/backoffice/staff/live-status, kept as its
// own small helper rather than refactoring that already-shipped route —
// this is the only other caller, and duplicating one small query is lower
// risk than touching a route Back Office Home's Live Status card depends on.
async function getLiveStatusByStaffId() {
  const { rows } = await pool.query(
    `SELECT s.staff_id, s.clock_in, b.break_start
       FROM shifts s
       LEFT JOIN LATERAL (
         SELECT break_start FROM shift_breaks
          WHERE shift_id = s.id AND break_end IS NULL
          ORDER BY break_start DESC LIMIT 1
       ) b ON true
      WHERE s.clock_out IS NULL`
  );
  const byStaffId = {};
  for (const r of rows) {
    byStaffId[r.staff_id] = {
      status: r.break_start ? "on_break" : "working",
      since: r.break_start || r.clock_in,
    };
  }
  return byStaffId;
}

// GET /api/staff/roster?staffId=...
// Owner/admin only. Every staff member, active AND inactive, with live
// clock-in/break status per row (null if not currently clocked in) —
// never returns pin_hash.
app.get("/api/staff/roster", async (req, res) => {
  try {
    await requireStaffIdParam(req.query.staffId);

    const { rows } = await pool.query(
      `SELECT id, name, role, active, ${STAFF_HISTORY_EXISTS_SQL} AS has_history FROM staff
        ORDER BY active DESC, array_position(ARRAY['owner','admin','manager','cashier','kitchen'], role::text), name`
    );
    const liveByStaffId = await getLiveStatusByStaffId();

    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        active: r.active,
        has_history: r.has_history,
        live: liveByStaffId[r.id] || null,
      }))
    );
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch staff roster");
  }
});

// PATCH /api/staff/:id/status
// Body: { staffId, active }. Owner/admin only; hierarchy-protected via the
// SAME requireManagedTarget Back Office's staff routes use (defined below)
// — an admin still can't touch an owner row here either, unweakened.
app.patch("/api/staff/:id/status", async (req, res) => {
  try {
    const { staffId, active } = req.body || {};
    const requester = await requireStaffIdParam(staffId);
    const target = await requireManagedTarget(requester, req.params.id);

    if (typeof active !== "boolean") {
      throw new HttpError(400, "active must be a boolean");
    }

    const { rows } = await pool.query(
      `UPDATE staff SET active = $1 WHERE id = $2 RETURNING ${STAFF_SAFE_COLS}`,
      [active, target.id]
    );
    res.json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to update staff status");
  }
});

// POST /api/staff/:id/reset-pin
// Body: { staffId, pin }. Owner/admin only, same hierarchy protection as
// above. Mirrors PUT /api/backoffice/staff/:id/pin exactly (see below),
// minus the session-cookie auth.
app.post("/api/staff/:id/reset-pin", async (req, res) => {
  try {
    const { staffId, pin } = req.body || {};
    const requester = await requireStaffIdParam(staffId);
    const target = await requireManagedTarget(requester, req.params.id);

    validatePin(pin);
    await assertPinAvailable(pin, target.id);

    const pinHash = await bcrypt.hash(pin, 10);
    await pool.query("UPDATE staff SET pin_hash = $1 WHERE id = $2", [pinHash, target.id]);
    res.json({ success: true, id: target.id });
  } catch (err) {
    sendHttpError(res, err, "Failed to reset PIN");
  }
});

// DELETE /api/staff/:id?staffId=... — StaffManagementModal's Remove action.
// Same smart-delete/hierarchy rules as DELETE /api/backoffice/staff/:id
// (see smartDeleteStaff), staffId-query-param authenticated like the rest
// of this trusted-staffId POS route family.
app.delete("/api/staff/:id", async (req, res) => {
  try {
    const requester = await requireStaffIdParam(req.query.staffId);
    const target = await requireManagedTarget(requester, req.params.id);
    res.json(await smartDeleteStaff(target));
  } catch (err) {
    sendHttpError(res, err, "Failed to remove staff member");
  }
});

// --------------- Self-service "me" routes (Order Entry account dropdown) ---------------
// Every role, no session cookie (same reasoning as quick-add above: Order
// Entry is PIN-login only). staffId is trusted from the body/query exactly
// like every other Order Entry route — the actual protection for the PIN
// change below is proving you know the CURRENT pin (bcrypt.compare), so a
// spoofed staffId can't succeed without also knowing that exact account's
// existing PIN. Clock-in/out/hours are scoped by construction: every query
// filters on the resolved staffId, so there's no path that returns a
// DIFFERENT staff member's shifts than whichever staffId was supplied.

// PUT /api/staff/me/pin
// Body: { staffId, currentPin, newPin } — self-service PIN change. Distinct
// from PUT /api/backoffice/staff/:id/pin (manager+ resetting SOMEONE ELSE's
// PIN via a Back Office session) — this one is any valid logged-in staffId
// changing their OWN pin, no role restriction.
app.put("/api/staff/me/pin", async (req, res) => {
  try {
    const { staffId, currentPin, newPin } = req.body || {};
    const requester = await requireStaffIdParam(staffId, STAFF_ROLES);

    validatePin(currentPin);
    validatePin(newPin);

    const { rows } = await pool.query("SELECT pin_hash FROM staff WHERE id = $1", [requester.id]);
    const currentMatches = rows[0] && (await bcrypt.compare(currentPin, rows[0].pin_hash));
    if (!currentMatches) {
      // Generic — never reveals whether staffId itself was the problem vs.
      // a wrong PIN; requireStaffIdParam above already 403'd unknown ids.
      throw new HttpError(401, "Current PIN is incorrect");
    }
    if (newPin === currentPin) {
      throw new HttpError(400, "New PIN must be different from your current PIN");
    }
    await assertPinAvailable(newPin, requester.id);

    const pinHash = await bcrypt.hash(newPin, 10);
    await pool.query("UPDATE staff SET pin_hash = $1 WHERE id = $2", [pinHash, requester.id]);
    res.json({ success: true });
  } catch (err) {
    sendHttpError(res, err, "Failed to change PIN");
  }
});

// Verify a submitted PIN against the given (already-resolved) staffId's
// stored hash — shared by every clock action below that requires PIN
// confirmation (clock-in/out, break-start/end). Same bcrypt.compare shape
// as PUT /me/pin above, generic error either way so nothing leaks about
// staffId validity.
async function verifyStaffPin(staffId, pin) {
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    throw new HttpError(400, "PIN must be exactly 4 digits");
  }
  const { rows } = await pool.query("SELECT pin_hash FROM staff WHERE id = $1", [staffId]);
  const matches = rows[0] && (await bcrypt.compare(pin, rows[0].pin_hash));
  if (!matches) {
    throw new HttpError(401, "Incorrect PIN");
  }
}

// GET /api/staff/me/clock-status?staffId=...
// The logged-in staffId's current state — 'not_clocked_in' | 'working' |
// 'on_break' — plus whichever timestamp a running client-side timer needs
// (shift clock_in, or break_start when on break). Powers the account
// dropdown's contextual Start Shift/End Shift/Take Break/End Break card
// (and the dropdown entry's own label).
app.get("/api/staff/me/clock-status", async (req, res) => {
  try {
    const requester = await requireStaffIdParam(req.query.staffId, STAFF_ROLES);

    const { rows: shiftRows } = await pool.query(
      "SELECT id, clock_in FROM shifts WHERE staff_id = $1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1",
      [requester.id]
    );
    if (shiftRows.length === 0) {
      return res.json({ status: "not_clocked_in" });
    }
    const shift = shiftRows[0];

    // Total COMPLETED break time this shift, so the client can show worked
    // time (elapsed since clock-in minus breaks) instead of raw elapsed.
    const { rows: brkAgg } = await pool.query(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (break_end - break_start))), 0) AS break_seconds
         FROM shift_breaks WHERE shift_id = $1 AND break_end IS NOT NULL`,
      [shift.id]
    );
    const breakSeconds = parseFloat(brkAgg[0].break_seconds);

    const { rows: breakRows } = await pool.query(
      "SELECT break_start FROM shift_breaks WHERE shift_id = $1 AND break_end IS NULL ORDER BY break_start DESC LIMIT 1",
      [shift.id]
    );
    if (breakRows.length > 0) {
      return res.json({
        status: "on_break",
        clockIn: shift.clock_in,
        breakStart: breakRows[0].break_start,
        breakSeconds,
      });
    }
    return res.json({ status: "working", clockIn: shift.clock_in, breakSeconds });
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch clock status");
  }
});

// POST /api/staff/me/clock-in
// Body: { staffId, pin }. Rejects with 409 if this staffId already has an
// open (unclosed) shift — one active clock-in at a time per person.
app.post("/api/staff/me/clock-in", async (req, res) => {
  try {
    const { staffId, pin } = req.body || {};
    const requester = await requireStaffIdParam(staffId, STAFF_ROLES);
    await verifyStaffPin(requester.id, pin);

    const { rows: openRows } = await pool.query(
      "SELECT id FROM shifts WHERE staff_id = $1 AND clock_out IS NULL",
      [requester.id]
    );
    if (openRows.length > 0) {
      throw new HttpError(409, "You're already clocked in");
    }

    // Owners have location_id = NULL (span all locations, per schema
    // design) — shifts.location_id is NOT NULL, so fall back to the single
    // active location, same as createStaffMember does for new owner rows.
    const { rows: staffRows } = await pool.query(
      "SELECT location_id FROM staff WHERE id = $1",
      [requester.id]
    );
    let locationId = staffRows[0].location_id;
    if (!locationId) {
      const location = await getSingleActiveLocation(pool);
      locationId = location.id;
    }

    const { rows } = await pool.query(
      "INSERT INTO shifts (staff_id, location_id, clock_in) VALUES ($1, $2, now()) RETURNING id, clock_in",
      [requester.id, locationId]
    );
    res.status(201).json({ success: true, shift: rows[0] });
  } catch (err) {
    sendHttpError(res, err, "Failed to clock in");
  }
});

// POST /api/staff/me/clock-out
// Body: { staffId, pin }. Rejects with 409 if this staffId has no open
// shift. If there's an open break on that shift, it's closed automatically
// with the SAME clock-out timestamp before the shift itself closes — a
// shift must never end with a break still technically open, and this is
// what makes "End Shift" work correctly from the on_break state too (the
// emergency path: no separate break-end step required). Both updates run
// in one transaction so a crash between them can never leave the break
// open against an already-closed shift.
app.post("/api/staff/me/clock-out", async (req, res) => {
  try {
    const { staffId, pin } = req.body || {};
    const requester = await requireStaffIdParam(staffId, STAFF_ROLES);
    await verifyStaffPin(requester.id, pin);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: openRows } = await client.query(
        "SELECT id FROM shifts WHERE staff_id = $1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1 FOR UPDATE",
        [requester.id]
      );
      if (openRows.length === 0) {
        await client.query("ROLLBACK");
        throw new HttpError(409, "You're not clocked in");
      }
      const shiftId = openRows[0].id;

      await client.query(
        "UPDATE shift_breaks SET break_end = now() WHERE shift_id = $1 AND break_end IS NULL",
        [shiftId]
      );

      const { rows } = await client.query(
        "UPDATE shifts SET clock_out = now() WHERE id = $1 RETURNING id, clock_in, clock_out",
        [shiftId]
      );

      // Break total for the just-ended shift (all breaks are now closed) so
      // the card can show a "Hours worked · Break time" summary.
      const { rows: brk } = await client.query(
        `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (break_end - break_start))), 0) AS break_seconds
           FROM shift_breaks WHERE shift_id = $1`,
        [shiftId]
      );

      await client.query("COMMIT");

      const s = rows[0];
      const breakSeconds = parseFloat(brk[0].break_seconds);
      const grossSeconds = (new Date(s.clock_out).getTime() - new Date(s.clock_in).getTime()) / 1000;
      res.json({
        success: true,
        shift: {
          id: s.id,
          clockIn: s.clock_in,
          clockOut: s.clock_out,
          workedSeconds: Math.round(Math.max(0, grossSeconds - breakSeconds)),
          breakSeconds: Math.round(breakSeconds),
        },
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    sendHttpError(res, err, "Failed to clock out");
  }
});

// POST /api/staff/me/break-start
// Body: { staffId, pin }. Rejects with 409 if this staffId has no open
// shift, or is already on an open break.
app.post("/api/staff/me/break-start", async (req, res) => {
  try {
    const { staffId, pin } = req.body || {};
    const requester = await requireStaffIdParam(staffId, STAFF_ROLES);
    await verifyStaffPin(requester.id, pin);

    const { rows: shiftRows } = await pool.query(
      "SELECT id FROM shifts WHERE staff_id = $1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1",
      [requester.id]
    );
    if (shiftRows.length === 0) {
      throw new HttpError(409, "You're not clocked in");
    }
    const shiftId = shiftRows[0].id;

    const { rows: openBreakRows } = await pool.query(
      "SELECT id FROM shift_breaks WHERE shift_id = $1 AND break_end IS NULL",
      [shiftId]
    );
    if (openBreakRows.length > 0) {
      throw new HttpError(409, "You're already on a break");
    }

    const { rows } = await pool.query(
      "INSERT INTO shift_breaks (shift_id, break_start) VALUES ($1, now()) RETURNING id, break_start",
      [shiftId]
    );
    res.status(201).json({ success: true, break: rows[0] });
  } catch (err) {
    sendHttpError(res, err, "Failed to start break");
  }
});

// POST /api/staff/me/break-end
// Body: { staffId, pin }. Rejects with 409 if this staffId has no open
// break (whether because they're not clocked in, or clocked in but not on
// a break).
app.post("/api/staff/me/break-end", async (req, res) => {
  try {
    const { staffId, pin } = req.body || {};
    const requester = await requireStaffIdParam(staffId, STAFF_ROLES);
    await verifyStaffPin(requester.id, pin);

    const { rows: openBreakRows } = await pool.query(
      `SELECT b.id
         FROM shift_breaks b
         JOIN shifts s ON s.id = b.shift_id
        WHERE s.staff_id = $1 AND s.clock_out IS NULL AND b.break_end IS NULL
        ORDER BY b.break_start DESC LIMIT 1`,
      [requester.id]
    );
    if (openBreakRows.length === 0) {
      throw new HttpError(409, "You're not on a break");
    }

    const { rows } = await pool.query(
      "UPDATE shift_breaks SET break_end = now() WHERE id = $1 RETURNING id, break_start, break_end",
      [openBreakRows[0].id]
    );
    res.json({ success: true, break: rows[0] });
  } catch (err) {
    sendHttpError(res, err, "Failed to end break");
  }
});

// GET /api/staff/me/hours?staffId=...&range=today|week|month
// Own shift history + total WORKED hours in range (clocked time minus every
// break within it), plus whether there's a currently open shift (drives the
// account dropdown's clock-status label — the frontend calls this same
// clock-status logic via /clock-status now, but openShift stays here too
// for anything still reading it off /hours). Always scoped to the resolved
// staffId; there is no parameter that broadens this to any other staff
// member's shifts.
app.get("/api/staff/me/hours", async (req, res) => {
  try {
    const requester = await requireStaffIdParam(req.query.staffId, STAFF_ROLES);
    const { range, trunc } = resolveStatsRange(req.query.range);
    const location = await getSingleActiveLocation(pool);

    // Range window [rangeStart, rangeEnd) in the location tz.
    const { rows: boundsRows } = await pool.query(
      `SELECT (date_trunc($1, now() AT TIME ZONE $2) AT TIME ZONE $2) AS range_start,
              ((date_trunc($1, now() AT TIME ZONE $2) + ('1 ' || $1)::interval) AT TIME ZONE $2) AS range_end`,
      [trunc, location.timezone]
    );
    // Shifts that OVERLAP the window (not just those that started in it), with
    // worked/break time clipped to it — so an open shift begun before the
    // window (e.g. still clocked in from late last night) shows up in Today
    // with its "hours so far today". Overlap + clipping come from the shared
    // canonical worked-time expressions, so this matches Dashboard labor and
    // Payroll exactly.
    const { rows: shiftRows } = await pool.query(
      `SELECT s.id, s.clock_in, s.clock_out,
              ${workedSecondsSql("$2", "$3")} AS worked_seconds,
              ${clippedBreakSecondsSql("$2", "$3")} AS break_seconds
         FROM shifts s
        WHERE s.staff_id = $1 AND ${shiftOverlapsWindowSql("$2", "$3")}
        ORDER BY s.clock_in DESC`,
      [requester.id, boundsRows[0].range_start, boundsRows[0].range_end]
    );

    let totalSeconds = 0;
    const shifts = shiftRows.map((s) => {
      const seconds = parseFloat(s.worked_seconds);
      totalSeconds += seconds;
      return {
        id: s.id,
        clockIn: s.clock_in,
        clockOut: s.clock_out,
        seconds: Math.round(seconds),
        breakSeconds: Math.round(parseFloat(s.break_seconds)),
      };
    });

    // Open-shift check is deliberately NOT scoped to the range boundary —
    // it always reflects real-time truth (a shift that started yesterday
    // but is still open must still show as open today).
    const { rows: openRows } = await pool.query(
      "SELECT id, clock_in FROM shifts WHERE staff_id = $1 AND clock_out IS NULL",
      [requester.id]
    );

    res.json({
      range,
      totalHours: totalSeconds / 3600,
      shifts,
      openShift: openRows[0] ? { id: openRows[0].id, clockIn: openRows[0].clock_in } : null,
    });
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch hours");
  }
});

// Fetch the target row + enforce hierarchy, shared by the two PUT routes.
async function requireManagedTarget(requester, targetId) {
  let rows;
  try {
    ({ rows } = await pool.query(
      "SELECT id, name, role, active FROM staff WHERE id = $1",
      [targetId]
    ));
  } catch {
    throw new HttpError(404, "Staff member not found");
  }
  const target = rows[0];
  if (!target) throw new HttpError(404, "Staff member not found");
  if (!canManageTarget(requester.role, target.role)) {
    throw new HttpError(
      403,
      `Your role (${requester.role}) cannot manage a staff member with role '${target.role}'`
    );
  }
  return target;
}

// PUT /api/backoffice/staff/:id
// Body: { staffId, name?, role?, hourly_rate?, active? } — partial update.
// Owner/admin only (Back Office is revoked from Manager). Hierarchy
// protection still applies to EVERY field, not just `active`.
// Deactivation = active:false; staff rows are never hard-deleted (historical
// orders reference them).
app.put("/api/backoffice/staff/:id", async (req, res) => {
  try {
    const body = req.body || {};
    const requester = await requireBackofficeSession(req);
    const target = await requireManagedTarget(requester, req.params.id);

    const sets = [];
    const vals = [];
    let i = 1;

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        throw new HttpError(400, "name must be a non-empty string");
      }
      sets.push(`name = $${i++}`);
      vals.push(body.name.trim());
    }
    if (body.role !== undefined) {
      if (!STAFF_ROLES.includes(body.role)) {
        throw new HttpError(400, "role must be one of owner/admin/manager/cashier/kitchen");
      }
      assertRoleAssignable(requester.role, body.role);
      sets.push(`role = $${i++}`);
      vals.push(body.role);
    }
    if (body.hourly_rate !== undefined) {
      const rate = Number(body.hourly_rate);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new HttpError(400, "hourly_rate must be a positive number");
      }
      sets.push(`hourly_rate = $${i++}`);
      vals.push(rate);
    }
    if (body.active !== undefined) {
      if (typeof body.active !== "boolean") {
        throw new HttpError(400, "active must be a boolean");
      }
      sets.push(`active = $${i++}`);
      vals.push(body.active);
    }
    if (body.email !== undefined) {
      // The role this row will have AFTER this update — accounts for a
      // role change happening in the same request. Email only ever means
      // anything for owner/admin (the only roles with Back Office login);
      // rejected outright for manager/cashier/kitchen rather than silently
      // dropped, since this is an explicit edit action.
      const effectiveRole = body.role !== undefined ? body.role : target.role;
      if (effectiveRole !== "owner" && effectiveRole !== "admin") {
        throw new HttpError(400, "email can only be set for owner/admin roles");
      }
      if (body.email === null || body.email === "") {
        sets.push(`email = $${i++}`);
        vals.push(null);
      } else {
        const normalized = normalizeEmail(body.email);
        const { rows: existing } = await pool.query(
          "SELECT id FROM staff WHERE lower(email) = $1 AND id != $2",
          [normalized, target.id]
        );
        if (existing.length > 0) throw new HttpError(409, "That email is already in use");
        sets.push(`email = $${i++}`);
        vals.push(normalized);
      }
    }
    if (sets.length === 0) {
      throw new HttpError(400, "No updatable fields provided");
    }

    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE staff SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${STAFF_SAFE_COLS}`,
      vals
    );
    res.json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to update staff member");
  }
});

// PUT /api/backoffice/staff/:id/pin
// Body: { staffId, pin } — validate, hash server-side, never echo the pin.
// Owner/admin only (Back Office is revoked from Manager).
app.put("/api/backoffice/staff/:id/pin", async (req, res) => {
  try {
    const { pin } = req.body || {};
    const requester = await requireBackofficeSession(req);
    const target = await requireManagedTarget(requester, req.params.id);

    validatePin(pin);
    await assertPinAvailable(pin, target.id);

    const pinHash = await bcrypt.hash(pin, 10);
    await pool.query("UPDATE staff SET pin_hash = $1 WHERE id = $2", [
      pinHash,
      target.id,
    ]);
    res.json({ success: true, id: target.id });
  } catch (err) {
    sendHttpError(res, err, "Failed to reset PIN");
  }
});

// DELETE /api/backoffice/staff/:id
// Owner/admin only, session-cookie auth, hierarchy-protected exactly like
// the PUT routes above. Smart delete (see smartDeleteStaff): hard-deletes
// the row if it has zero order/shift history, otherwise force-deactivates
// it instead — same outcome as the old PUT active:false toggle, just
// reached through this route now too. The client may already know which
// outcome to expect (has_history on the GET /api/backoffice/staff row,
// used to word its confirmation dialog before this is even called), but
// the decision is always re-verified here, never trusted from the request.
app.delete("/api/backoffice/staff/:id", async (req, res) => {
  try {
    const requester = await requireBackofficeSession(req);
    const target = await requireManagedTarget(requester, req.params.id);
    res.json(await smartDeleteStaff(target));
  } catch (err) {
    sendHttpError(res, err, "Failed to remove staff member");
  }
});

// --------------- Back Office: read-only stats ---------------
// Owner/admin only — requireBackofficeSession's default allowedRoles is
// exactly ["owner", "admin"], so managers correctly get 403 on all three.
// All figures are based on completed (status='ready') orders, using
// completed_at exactly as KDS's history/prep-time endpoint already does.

const STATS_RANGE_TRUNC = { today: "day", week: "week", month: "month" };

function resolveStatsRange(range) {
  const r = range === undefined ? "today" : range;
  const trunc = STATS_RANGE_TRUNC[r];
  if (!trunc) {
    throw new HttpError(400, "range must be one of today, week, month");
  }
  return { range: r, trunc };
}

async function getSingleActiveLocation(client) {
  const { rows } = await client.query(
    "SELECT id, timezone FROM locations WHERE active = true ORDER BY created_at LIMIT 1"
  );
  if (rows.length === 0) throw new HttpError(500, "No active location");
  return rows[0];
}

// --------------- Canonical worked-time calculation ---------------
// ONE implementation behind every "hours worked" number in the app —
// Dashboard labor (stats/labor), Payroll, and My Hours — so the same figure
// can never drift between surfaces. See docs/architecture/reports-plan.md
// ("Shared calculation logic"); the acceptance cases that lock the behavior
// live in tests/worked_time_acceptance.sql.
//
// Semantics, applied identically everywhere:
//   - a shift COUNTS if it OVERLAPS the window [start, end)
//   - its time is CLIPPED to that window, so a shift that began before the
//     window contributes only its in-window portion, and one still running
//     past the end is capped there instead of growing to now()
//   - breaks are clipped the same way and subtracted
//   - an open shift / open break runs to now()
//
// These return SQL expressions rather than whole queries, so each caller
// passes its own bounds — placeholders ($1/$2) or CTE columns (b.start_ts) —
// while sharing the arithmetic.

function shiftOverlapsWindowSql(startExpr, endExpr, s = "s") {
  return `${s}.clock_in < ${endExpr} AND (${s}.clock_out IS NULL OR ${s}.clock_out > ${startExpr})`;
}

function clippedShiftSecondsSql(startExpr, endExpr, s = "s") {
  return `GREATEST(0, EXTRACT(EPOCH FROM (
            LEAST(COALESCE(${s}.clock_out, now()), ${endExpr})
            - GREATEST(${s}.clock_in, ${startExpr}))))`;
}

function clippedBreakSecondsSql(startExpr, endExpr, s = "s") {
  return `COALESCE((
            SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                     LEAST(COALESCE(bk.break_end, now()), ${endExpr})
                     - GREATEST(bk.break_start, ${startExpr})))))
              FROM shift_breaks bk WHERE bk.shift_id = ${s}.id), 0)`;
}

// Worked seconds for one shift row inside the window: clipped clocked time
// minus clipped break time, floored at 0.
function workedSecondsSql(startExpr, endExpr, s = "s") {
  return `GREATEST(0, ${clippedShiftSecondsSql(startExpr, endExpr, s)}
                      - ${clippedBreakSecondsSql(startExpr, endExpr, s)})`;
}

function isYmd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Resolves the stats window as timestamptz bounds [startTs, endTs) — the
// single source every stats endpoint filters on — from either a preset
// ?range=today|week|month or a custom ?start=&end= (YYYY-MM-DD, interpreted
// in the location's timezone; end is inclusive, so the upper bound is the
// day after). For presets it also returns the previous period-to-date
// bounds (for the comparison deltas); a custom range has no well-defined
// "previous", so prev is null there. Preset bounds are identical to the
// old date_trunc filter (start = date_trunc(range), end = now), so this
// changes nothing for the existing preset behavior.
async function getStatsBounds(client, req) {
  const location = await getSingleActiveLocation(client);
  const tz = location.timezone;
  const { range, start, end } = req.query;
  const custom = range === "custom" || start !== undefined || end !== undefined;

  if (custom) {
    if (!isYmd(start) || !isYmd(end)) {
      throw new HttpError(400, "Custom range needs start and end as YYYY-MM-DD");
    }
    if (start > end) throw new HttpError(400, "start must be on or before end");
    const { rows } = await client.query(
      `SELECT ($1::date)::timestamp AT TIME ZONE $3 AS start_ts,
              (($2::date + 1)::timestamp) AT TIME ZONE $3 AS end_ts`,
      [start, end, tz]
    );
    return { location, tz, startTs: rows[0].start_ts, endTs: rows[0].end_ts, prev: null, isCustom: true };
  }

  const { trunc } = resolveStatsRange(range);
  const { rows } = await client.query(
    `SELECT (date_trunc($1, now() AT TIME ZONE $2) AT TIME ZONE $2) AS start_ts,
            now() AS end_ts,
            ((date_trunc($1, now() AT TIME ZONE $2) - ('1 ' || $1)::interval) AT TIME ZONE $2) AS prev_start_ts,
            ((date_trunc($1, now() AT TIME ZONE $2) - ('1 ' || $1)::interval
              + (now() AT TIME ZONE $2 - date_trunc($1, now() AT TIME ZONE $2))) AT TIME ZONE $2) AS prev_end_ts`,
    [trunc, tz]
  );
  return {
    location,
    tz,
    trunc,
    startTs: rows[0].start_ts,
    endTs: rows[0].end_ts,
    prev: { startTs: rows[0].prev_start_ts, endTs: rows[0].prev_end_ts },
    isCustom: false,
  };
}

// GET /api/backoffice/stats/summary?staffId=...&range=today|week|month
//   or ...&start=YYYY-MM-DD&end=YYYY-MM-DD (custom)
app.get("/api/backoffice/stats/summary", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const b = await getStatsBounds(client, req);

    // One aggregate over a [start, end) window. Run once for the current
    // window, and again for the previous period-to-date (presets only —
    // a custom range has no well-defined "previous", so no deltas there).
    const agg = async (startTs, endTs) => {
      const { rows } = await client.query(
        `SELECT COALESCE(SUM(total), 0) AS total, COALESCE(SUM(subtotal), 0) AS gross,
                COALESCE(SUM(discount), 0) AS disc, COALESCE(SUM(tip), 0) AS tips,
                COUNT(*) AS orders
           FROM orders
          WHERE location_id = $1 AND status = 'ready'
            AND completed_at >= $2 AND completed_at < $3`,
        [b.location.id, startTs, endTs]
      );
      const r = rows[0];
      const total = parseFloat(r.total);
      const gross = parseFloat(r.gross);
      const orders = parseInt(r.orders, 10);
      return {
        totalSales: total,
        grossSales: gross,
        netSales: gross - parseFloat(r.disc),
        discountTotal: parseFloat(r.disc),
        orderCount: orders,
        avgOrderValue: orders > 0 ? total / orders : 0,
        totalTips: parseFloat(r.tips),
      };
    };

    const cur = await agg(b.startTs, b.endTs);
    const prev = b.prev ? await agg(b.prev.startTs, b.prev.endTs) : null;

    res.json({
      range: b.isCustom ? "custom" : req.query.range || "today",
      // Gross = pre-discount subtotal; Net = gross minus discounts (both
      // pre-tax). totalSales = SUM(total), the revenue collected (incl.
      // tax/tip). Tips are $0 until Stripe Terminal tip capture lands.
      ...cur,
      // Previous period-to-date, for the "vs Last Period" deltas (omitted
      // for custom ranges).
      previous: prev
        ? {
            grossSales: prev.grossSales,
            netSales: prev.netSales,
            orderCount: prev.orderCount,
            avgOrderValue: prev.avgOrderValue,
            totalTips: prev.totalTips,
          }
        : null,
    });
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch sales summary");
  } finally {
    client.release();
  }
});

// GET /api/backoffice/stats/top-items?staffId=...&range=...&limit=5
// Top items by quantity sold — grouped by item + variant (same distinct-line
// concept as KDS Fast Mode; modifiers are NOT part of this grouping since
// the goal here is "what sells", not "exact make-spec").
app.get("/api/backoffice/stats/top-items", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const b = await getStatsBounds(client, req);

    const limit = req.query.limit === undefined ? 5 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new HttpError(400, "limit must be an integer between 1 and 50");
    }

    const { rows } = await client.query(
      `SELECT mi.id AS item_id, mi.name AS item_name,
              iv.id AS variant_id, iv.name AS variant_name,
              SUM(oi.quantity) AS quantity,
              COALESCE(SUM(
                oi.quantity * oi.unit_price
                + COALESCE(m.mod_total, 0)
                + COALESCE(a.addon_total, 0)
              ), 0) AS revenue
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN menu_items mi ON mi.id = oi.item_id
         LEFT JOIN item_variants iv ON iv.id = oi.variant_id
         LEFT JOIN LATERAL (
           SELECT SUM(price_delta * quantity) AS mod_total
             FROM order_item_modifiers WHERE order_item_id = oi.id
         ) m ON true
         LEFT JOIN LATERAL (
           SELECT SUM(unit_price * quantity) AS addon_total
             FROM order_item_addons WHERE order_item_id = oi.id
         ) a ON true
        WHERE o.location_id = $1
          AND o.status = 'ready'
          AND o.completed_at >= $2 AND o.completed_at < $3
        GROUP BY mi.id, mi.name, iv.id, iv.name
        ORDER BY quantity DESC
        LIMIT $4`,
      [b.location.id, b.startTs, b.endTs, limit]
    );
    res.json(
      rows.map((r) => ({
        item_id: r.item_id,
        name: r.item_name,
        variant: r.variant_name,
        quantity: parseInt(r.quantity, 10),
        revenue: parseFloat(r.revenue),
      }))
    );
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch top items");
  } finally {
    client.release();
  }
});

// GET /api/backoffice/stats/staff-performance?staffId=...&range=...
// Orders handled per staff member, attributed via orders.staff_id (set at
// checkout to the logged-in staff member who rang the order in).
app.get("/api/backoffice/stats/staff-performance", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const b = await getStatsBounds(client, req);

    const { rows } = await client.query(
      `SELECT s.id AS staff_id, s.name AS staff_name, s.role,
              COUNT(*) AS order_count,
              COALESCE(SUM(o.total), 0) AS total_sales
         FROM orders o
         JOIN staff s ON s.id = o.staff_id
        WHERE o.location_id = $1
          AND o.status = 'ready'
          AND o.completed_at >= $2 AND o.completed_at < $3
        GROUP BY s.id, s.name, s.role
        ORDER BY order_count DESC`,
      [b.location.id, b.startTs, b.endTs]
    );
    res.json(
      rows.map((r) => ({
        staff_id: r.staff_id,
        name: r.staff_name,
        role: r.role,
        orderCount: parseInt(r.order_count, 10),
        totalSales: parseFloat(r.total_sales),
      }))
    );
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch staff performance");
  } finally {
    client.release();
  }
});

// GET /api/backoffice/stats/hourly?staffId=...&range=...
// Hour-of-day distribution across the range (0–23), gap-filled so every
// hour is present. Feeds the Hourly Breakdown card (bar chart + table):
// "which hours are busiest." Averaged across all days in the range.
app.get("/api/backoffice/stats/hourly", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const b = await getStatsBounds(client, req);

    const { rows } = await client.query(
      `WITH agg AS (
         SELECT EXTRACT(HOUR FROM (completed_at AT TIME ZONE $4))::int AS hour,
                COUNT(*) AS orders, COALESCE(SUM(total), 0) AS sales
           FROM orders
          WHERE location_id = $1 AND status = 'ready'
            AND completed_at >= $2 AND completed_at < $3
          GROUP BY 1
       )
       SELECT h AS hour, COALESCE(a.orders, 0) AS orders, COALESCE(a.sales, 0) AS sales
         FROM generate_series(0, 23) h
         LEFT JOIN agg a ON a.hour = h
        ORDER BY h`,
      [b.location.id, b.startTs, b.endTs, b.tz]
    );
    res.json(
      rows.map((r) => {
        const orders = parseInt(r.orders, 10);
        const sales = parseFloat(r.sales);
        return { hour: r.hour, orders, sales, avg: orders > 0 ? sales / orders : 0 };
      })
    );
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch hourly breakdown");
  } finally {
    client.release();
  }
});

// GET /api/backoffice/stats/trend?staffId=...&range=...&granularity=hour|day
// Chronological sales time series, gap-filled bucket-by-bucket across the
// range (so a zero hour/day shows as 0, not a skipped point). Feeds the
// Sales Trend line chart; granularity is the card's Hourly/Daily toggle.
app.get("/api/backoffice/stats/trend", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const b = await getStatsBounds(client, req);
    // Whitelisted — interpolated into date_trunc / the '1 <unit>' interval;
    // never take the raw query value into SQL text.
    const granularity = req.query.granularity === "day" ? "day" : "hour";
    const labelFmt = granularity === "day" ? "Dy DD" : "FMHH12 AM";

    const { rows } = await client.query(
      `WITH bounds AS (
         SELECT $2::timestamptz AS start_ts, $3::timestamptz AS end_ts
       ),
       buckets AS (
         -- end_ts is the exclusive upper bound, so bucket the last INCLUDED
         -- instant (end_ts - 1µs); otherwise a custom end date would render
         -- an extra empty trailing bucket.
         SELECT generate_series(
                  date_trunc($4, (SELECT start_ts FROM bounds) AT TIME ZONE $5),
                  date_trunc($4, ((SELECT end_ts FROM bounds) - interval '1 microsecond') AT TIME ZONE $5),
                  ('1 ' || $4)::interval
                ) AS bucket
       ),
       agg AS (
         SELECT date_trunc($4, (completed_at AT TIME ZONE $5)) AS bucket,
                COUNT(*) AS orders, COALESCE(SUM(total), 0) AS sales
           FROM orders
          WHERE location_id = $1 AND status = 'ready'
            AND completed_at >= (SELECT start_ts FROM bounds)
            AND completed_at <  (SELECT end_ts FROM bounds)
          GROUP BY 1
       )
       SELECT b.bucket, to_char(b.bucket, $6) AS label,
              COALESCE(a.orders, 0) AS orders, COALESCE(a.sales, 0) AS sales
         FROM buckets b
         LEFT JOIN agg a ON a.bucket = b.bucket
        ORDER BY b.bucket`,
      [b.location.id, b.startTs, b.endTs, granularity, b.tz, labelFmt]
    );
    res.json(
      rows.map((r) => ({
        bucket: r.bucket,
        label: (r.label || "").trim(),
        orders: parseInt(r.orders, 10),
        sales: parseFloat(r.sales),
      }))
    );
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch sales trend");
  } finally {
    client.release();
  }
});

// GET /api/backoffice/stats/by-category?staffId=...&range=...
// Sales per menu category, sorted high→low. Line revenue = base
// (quantity × unit_price) + modifier price deltas + addon revenue, all
// attributed to the item's category — so the categories sum to gross
// sales. Feeds the Category Sales horizontal-bar chart.
app.get("/api/backoffice/stats/by-category", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const b = await getStatsBounds(client, req);

    const { rows } = await client.query(
      `SELECT mc.id, mc.name,
              COALESCE(SUM(
                oi.quantity * oi.unit_price
                + COALESCE(m.mod_total, 0)
                + COALESCE(a.addon_total, 0)
              ), 0) AS sales,
              COALESCE(SUM(oi.quantity), 0) AS qty
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN menu_items mi ON mi.id = oi.item_id
         JOIN menu_categories mc ON mc.id = mi.category_id
         LEFT JOIN LATERAL (
           SELECT SUM(price_delta * quantity) AS mod_total
             FROM order_item_modifiers WHERE order_item_id = oi.id
         ) m ON true
         LEFT JOIN LATERAL (
           SELECT SUM(unit_price * quantity) AS addon_total
             FROM order_item_addons WHERE order_item_id = oi.id
         ) a ON true
        WHERE o.location_id = $1 AND o.status = 'ready'
          AND o.completed_at >= $2 AND o.completed_at < $3
        GROUP BY mc.id, mc.name
        HAVING SUM(oi.quantity) > 0
        ORDER BY sales DESC`,
      [b.location.id, b.startTs, b.endTs]
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        sales: parseFloat(r.sales),
        qty: parseInt(r.qty, 10),
      }))
    );
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch category sales");
  } finally {
    client.release();
  }
});

// GET /api/backoffice/stats/labor?staffId=...&range=...
// Labor cost from shifts started in the range: worked time (clock_in →
// clock_out, or now() for an open shift) minus break time (break_start →
// break_end, or now() for an open break), × the staff member's hourly_rate.
// Returns per-staff hours/cost, plus totals and labor % of gross sales.
// Feeds the Labor Cost % KPI, the Labor card meter, and the Staff
// Performance Hours column.
app.get("/api/backoffice/stats/labor", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const b = await getStatsBounds(client, req);

    const { rows: perStaffRows } = await client.query(
      `WITH shift_work AS (
         SELECT s.staff_id, COALESCE(st.hourly_rate, 0) AS hourly_rate,
                ${workedSecondsSql("$1", "$2")} AS worked_seconds
           FROM shifts s
           JOIN staff st ON st.id = s.staff_id
          WHERE ${shiftOverlapsWindowSql("$1", "$2")}
       ),
       per_staff AS (
         SELECT staff_id, hourly_rate, SUM(worked_seconds) AS worked_seconds
           FROM shift_work GROUP BY staff_id, hourly_rate
       )
       SELECT ps.staff_id, st.name,
              ps.worked_seconds / 3600.0 AS hours,
              (ps.worked_seconds / 3600.0) * ps.hourly_rate AS labor_cost
         FROM per_staff ps
         JOIN staff st ON st.id = ps.staff_id
        ORDER BY labor_cost DESC`,
      [b.startTs, b.endTs]
    );

    const { rows: salesRows } = await client.query(
      `SELECT COALESCE(SUM(subtotal), 0) AS gross_sales
         FROM orders
        WHERE location_id = $1 AND status = 'ready'
          AND completed_at >= $2 AND completed_at < $3`,
      [b.location.id, b.startTs, b.endTs]
    );

    // Previous period-to-date labor % (presets only — custom has no prev).
    let prevLaborPct = null;
    if (b.prev) {
      const { rows: prevRows } = await client.query(
        `WITH sw AS (
           SELECT COALESCE(st.hourly_rate, 0) AS rate,
                  ${workedSecondsSql("$2", "$3")} AS worked
             FROM shifts s JOIN staff st ON st.id = s.staff_id
            WHERE ${shiftOverlapsWindowSql("$2", "$3")}
         )
         SELECT
           (SELECT COALESCE(SUM((worked / 3600.0) * rate), 0) FROM sw) AS prev_labor,
           (SELECT COALESCE(SUM(subtotal), 0) FROM orders
             WHERE location_id = $1 AND status = 'ready'
               AND completed_at >= $2 AND completed_at < $3) AS prev_gross`,
        [b.location.id, b.prev.startTs, b.prev.endTs]
      );
      const prevLabor = parseFloat(prevRows[0].prev_labor);
      const prevGross = parseFloat(prevRows[0].prev_gross);
      prevLaborPct = prevGross > 0 ? (prevLabor / prevGross) * 100 : 0;
    }

    const perStaff = perStaffRows.map((r) => ({
      staff_id: r.staff_id,
      name: r.name,
      hours: parseFloat(r.hours),
      laborCost: parseFloat(r.labor_cost),
    }));
    const laborCost = perStaff.reduce((sum, s) => sum + s.laborCost, 0);
    const hours = perStaff.reduce((sum, s) => sum + s.hours, 0);
    const grossSales = parseFloat(salesRows[0].gross_sales);

    res.json({
      laborCost,
      hours,
      grossSales,
      laborPct: grossSales > 0 ? (laborCost / grossSales) * 100 : 0,
      perStaff,
      previous: prevLaborPct == null ? null : { laborPct: prevLaborPct },
    });
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch labor stats");
  } finally {
    client.release();
  }
});

// GET /api/backoffice/stats/discounts?staffId=...&range=...
// Discounts broken down by reason (family/friend/employee/neighbouring_
// store), sorted high→low. Feeds the Discount Report table; the frontend
// computes each reason's % of gross from the summary it already has.
app.get("/api/backoffice/stats/discounts", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const b = await getStatsBounds(client, req);

    const { rows } = await client.query(
      `SELECT discount_reason AS reason,
              COALESCE(SUM(discount), 0) AS amount,
              COUNT(*) AS orders
         FROM orders
        WHERE location_id = $1 AND status = 'ready'
          AND discount > 0 AND discount_reason IS NOT NULL
          AND completed_at >= $2 AND completed_at < $3
        GROUP BY discount_reason
        ORDER BY amount DESC`,
      [b.location.id, b.startTs, b.endTs]
    );
    res.json(
      rows.map((r) => ({
        reason: r.reason,
        amount: parseFloat(r.amount),
        orders: parseInt(r.orders, 10),
      }))
    );
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch discount report");
  } finally {
    client.release();
  }
});

// --------------- Back Office: Reports ---------------
// Owner/admin only. Portable, exportable records for record-keeping/filing/
// audit — distinct from the Dashboard (live/visual). Every report reuses the
// same getStatsBounds window resolution as the stats endpoints, so a Reports
// custom start/end (YYYY-MM-DD, location tz) needs no new date logic. See
// docs/architecture/reports-plan.md.

// The SINGLE source of truth for which payment rows count as collected revenue
// in EVERY report rollup (Sales Summary payment mix, Transaction Log
// reconciliation + method list, and future reports). Two settled kinds now:
// positive 'captured' rows from checkout, and negative 'refunded' rows written
// by the refund/void flow (see applyRefund). Because refunds are negative,
// SUM(payments.amount) over this set is NET collected — captures minus refunds
// — by construction, so every report nets refunds together through this one
// predicate. The reconciliation invariant evolves to:
//   SUM(orders.total) [ready] − SUM(refunds on those orders) == SUM(payments) [settled]
// A future 'failed'/'pending' Stripe row stays excluded until it settles.
function settledPaymentsWhere(alias = "p") {
  return `${alias}.status IN ('captured', 'refunded')`;
}

// GET /api/backoffice/reports/sales-summary?start=YYYY-MM-DD&end=YYYY-MM-DD
//   (also accepts range=today|week|month, but Reports drives it with custom
//   start/end). A P&L-style single-period snapshot:
//     Gross → Discounts → Refunds → Net → Tax → Tips → Total collected
//   plus order count, AOV, a payment-method mix, and a voids memo (a footnote,
//   not a P&L line — voided orders are 'cancelled' and already excluded).
//   Builds on the stats/summary money math (gross = SUM(subtotal), total =
//   SUM(total)), with the explicit Tax line (SUM(orders.tax)) and the
//   payment-method rollup (SUM(payments.amount) GROUP BY method) added here.
//   Since Refunds shipped, net = gross − discounts − refunds(pre-tax) and the
//   tax line is net of refunded tax, so Total collected == SUM(settled
//   payments) still holds.
app.get("/api/backoffice/reports/sales-summary", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const b = await getStatsBounds(client, req);

    // One aggregate over the [start, end) window of completed (ready) orders.
    // total = subtotal − discount + tax + tip, so net + tax + tips == total
    // (the line items reconcile by construction).
    const { rows: sumRows } = await client.query(
      `SELECT COALESCE(SUM(subtotal), 0) AS gross,
              COALESCE(SUM(discount), 0) AS discount,
              COALESCE(SUM(tax), 0)      AS tax,
              COALESCE(SUM(tip), 0)      AS tips,
              COALESCE(SUM(total), 0)    AS total,
              COUNT(*)                   AS orders
         FROM orders
        WHERE location_id = $1 AND status = 'ready'
          AND completed_at >= $2 AND completed_at < $3`,
      [b.location.id, b.startTs, b.endTs]
    );
    const s = sumRows[0];
    const gross = parseFloat(s.gross);
    const discount = parseFloat(s.discount);
    const tax = parseFloat(s.tax);
    const tips = parseFloat(s.tips);
    const total = parseFloat(s.total);
    const orderCount = parseInt(s.orders, 10);

    // Refunds on these (ready) orders — scoped by the ORDER's completed_at, the
    // same window the settled-payments sum uses, so the two stay reconciled even
    // if the refund itself happened in a later period. amount is tax-inclusive;
    // tax_amount is its tax portion. (Voids aren't here — a voided order is
    // 'cancelled', not 'ready', so it's already excluded from every line above.)
    const { rows: refRows } = await client.query(
      `SELECT COALESCE(SUM(r.amount), 0) AS refund_total,
              COALESCE(SUM(r.tax_amount), 0) AS refund_tax,
              COUNT(*) AS refund_count
         FROM order_refunds r
         JOIN orders o ON o.id = r.order_id
        WHERE o.location_id = $1 AND o.status = 'ready'
          AND o.completed_at >= $2 AND o.completed_at < $3
          AND r.status <> 'failed'`,
      [b.location.id, b.startTs, b.endTs]
    );
    const refundTotal = parseFloat(refRows[0].refund_total);
    const refundTax = parseFloat(refRows[0].refund_tax);
    const refundsPreTax = round2(refundTotal - refundTax);
    const refundCount = parseInt(refRows[0].refund_count, 10);

    // Voids memo (footnote only) — voided orders are excluded from the P&L
    // entirely, but shown for audit so reversal activity is never invisible.
    // Scoped by the void event time (when it happened this period).
    const { rows: voidRows } = await client.query(
      `SELECT COUNT(*) AS void_count, COALESCE(SUM(r.amount), 0) AS void_total
         FROM order_refunds r
         JOIN orders o ON o.id = r.order_id
        WHERE o.location_id = $1 AND r.type = 'void' AND r.status <> 'failed'
          AND r.created_at >= $2 AND r.created_at < $3`,
      [b.location.id, b.startTs, b.endTs]
    );

    // Line items (accounting-correct): the pre-tax column is
    //   Gross − Discounts − Refunds(pre-tax) = Net sales
    // and the tax line is net of refunded tax, so
    //   Total collected = Net + Tax + Tips = SUM(orders.total) − refundTotal
    // which equals SUM(settled payments) by construction.
    const netSales = round2(gross - discount - refundsPreTax);
    const taxCollected = round2(tax - refundTax);
    const totalCollected = round2(total - refundTotal);

    // Payment-method mix — net SUM(amount) GROUP BY method over the settled set
    // (captures + negative refunds), so a method's bucket is what it NET
    // collected. Summed across methods this equals totalCollected (the
    // reconciliation anchor). `count` counts only captures (amount > 0) so it
    // still reads as "orders paid by this method", not payment rows. Payments
    // are still mocked, so the method reflects what the cashier SELECTED at
    // checkout, not verified settlement.
    const { rows: mixRows } = await client.query(
      `SELECT p.method, COALESCE(SUM(p.amount), 0) AS amount,
              COUNT(*) FILTER (WHERE p.amount > 0) AS count
         FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE o.location_id = $1 AND o.status = 'ready'
          AND o.completed_at >= $2 AND o.completed_at < $3
          AND ${settledPaymentsWhere("p")}
        GROUP BY p.method
        ORDER BY amount DESC`,
      [b.location.id, b.startTs, b.endTs]
    );

    res.json({
      range: b.isCustom ? "custom" : req.query.range || "today",
      grossSales: gross,
      discountTotal: discount,
      refundsPreTax,
      refundTax,
      refundTotal,
      refundCount,
      netSales,
      taxCollected,
      totalTips: tips,
      totalCollected,
      orderCount,
      avgOrderValue: orderCount > 0 ? total / orderCount : 0,
      voidCount: parseInt(voidRows[0].void_count, 10),
      voidTotal: parseFloat(voidRows[0].void_total),
      paymentMix: mixRows.map((r) => ({
        method: r.method,
        amount: parseFloat(r.amount),
        count: parseInt(r.count, 10),
      })),
    });
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch sales summary report");
  } finally {
    client.release();
  }
});

// GET /api/backoffice/reports/transactions?start=YYYY-MM-DD&end=YYYY-MM-DD
//   &prevStart=YYYY-MM-DD&prevEnd=YYYY-MM-DD (optional comparison window)
// The audit backbone: one row per completed (ready) order — number, time,
// staff, the full money breakdown, discount reason, and payment method(s).
// NET-NEW query (orders + payments + staff); no current equivalent.
//
// Reconciliation invariant & payment states (as built): Reports count only
// status='ready' orders. Checkout writes one or more 'captured', positive
// payments per order that sum exactly to orders.total (see the payments
// INSERT above). Since the Refunds feature shipped, a reversal also writes a
// NEGATIVE payments row at status='refunded' linked to its order_refunds audit
// record, and a void additionally moves the order to 'cancelled' — dropping it
// out of every 'ready'-filtered rollup while its capture and its reversal net
// to zero. 'pending'/'failed' remain unreachable until Stripe lands.
//
// Every money rollup routes through settledPaymentsWhere() — now
// status IN ('captured','refunded') — so SUM(payments.amount) over that set is
// NET collected by construction, and the invariant is:
//   SUM(orders.total) [ready] − SUM(refunds on those orders)
//     == SUM(payments.amount) [settled]
//     == Transaction Log net == Sales Summary "Total collected".
// Proven against seeded refund/void data (partial, full, and a void) in
// tests/refund_reconciliation_acceptance.mjs. Voided orders appear here as
// flagged rows contributing nothing to the totals, which also closes the
// "cancelled orders are invisible" gap docs/architecture/reports-plan.md
// raised. A future 'failed'/'pending' Stripe row stays excluded until it
// settles, so an in-flight refund can never corrupt a total.
//
// The per-order row query is the row-grain source a future end-of-day report
// aggregates; the totals query is the same summary grain as Sales Summary.
// Both key off getStatsBounds so windows never diverge.
app.get("/api/backoffice/reports/transactions", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const b = await getStatsBounds(client, req);

    // One row per order. Includes VOIDED (cancelled) orders so a reversal is
    // clearly marked, not just missing (voids sort by their own date, which may
    // be created_at when the order was voided before completing). Per-row
    // `refunded` is the sum of non-failed refunds on that order.
    const { rows } = await client.query(
      `SELECT o.order_number, o.completed_at, o.created_at, st.name AS staff_name,
              o.subtotal, o.discount, o.discount_reason, o.tax, o.tip, o.total,
              o.status,
              COALESCE((SELECT SUM(r.amount) FROM order_refunds r
                          WHERE r.order_id = o.id AND r.status <> 'failed'), 0) AS refunded,
              COALESCE(
                (SELECT array_agg(DISTINCT p.method::text ORDER BY p.method::text)
                   FROM payments p
                  WHERE p.order_id = o.id AND ${settledPaymentsWhere("p")}),
                '{}'
              ) AS methods
         FROM orders o
         JOIN staff st ON st.id = o.staff_id
        WHERE o.location_id = $1
          AND ( (o.status = 'ready'     AND o.completed_at >= $2 AND o.completed_at < $3)
             OR (o.status = 'cancelled' AND COALESCE(o.completed_at, o.created_at) >= $2
                                        AND COALESCE(o.completed_at, o.created_at) < $3) )
        ORDER BY COALESCE(o.completed_at, o.created_at) DESC, o.order_number DESC`,
      [b.location.id, b.startTs, b.endTs]
    );

    // Order-side totals (READY only — voids contribute nothing) + refunds +
    // payments-side total (reconciliation). Net = total − refunds must equal
    // the settled payments sum (captures + negative refunds).
    const { rows: totRows } = await client.query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(subtotal),0) AS subtotal,
              COALESCE(SUM(discount),0) AS discount, COALESCE(SUM(tax),0) AS tax,
              COALESCE(SUM(tip),0) AS tip, COALESCE(SUM(total),0) AS total,
              COALESCE((SELECT SUM(r.amount) FROM order_refunds r
                          JOIN orders o3 ON o3.id = r.order_id
                         WHERE o3.location_id = $1 AND o3.status = 'ready'
                           AND o3.completed_at >= $2 AND o3.completed_at < $3
                           AND r.status <> 'failed'), 0) AS refunded_total,
              COALESCE((SELECT SUM(p.amount) FROM payments p
                          JOIN orders o2 ON o2.id = p.order_id
                         WHERE o2.location_id = $1 AND o2.status = 'ready'
                           AND o2.completed_at >= $2 AND o2.completed_at < $3
                           AND ${settledPaymentsWhere("p")}), 0)
                AS payments_total
         FROM orders o
        WHERE o.location_id = $1 AND o.status = 'ready'
          AND o.completed_at >= $2 AND o.completed_at < $3`,
      [b.location.id, b.startTs, b.endTs]
    );
    const t = totRows[0];
    const grossTotal = parseFloat(t.total);
    const refundedTotal = parseFloat(t.refunded_total);
    const netTotal = round2(grossTotal - refundedTotal);
    const payTotal = parseFloat(t.payments_total);

    // Optional comparison vs a prior window supplied by the caller (the
    // frontend computes "prior equivalent period" — prior calendar month/
    // quarter/year, else an equal-length preceding window). Generic on
    // purpose so every aggregate report reuses this same prev-window layer.
    let comparison = null;
    const { prevStart, prevEnd } = req.query;
    if (isYmd(prevStart) && isYmd(prevEnd)) {
      const { rows: cmp } = await client.query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total
           FROM orders
          WHERE location_id = $1 AND status = 'ready'
            AND completed_at >= ($2::date)::timestamp AT TIME ZONE $4
            AND completed_at <  (($3::date + 1)::timestamp) AT TIME ZONE $4`,
        [b.location.id, prevStart, prevEnd, b.tz]
      );
      comparison = {
        count: parseInt(cmp[0].count, 10),
        total: parseFloat(cmp[0].total),
      };
    }

    res.json({
      range: b.isCustom ? "custom" : req.query.range || "today",
      rows: rows.map((r) => ({
        orderNumber: r.order_number,
        completedAt: r.completed_at || r.created_at,
        staffName: r.staff_name,
        subtotal: parseFloat(r.subtotal),
        discount: parseFloat(r.discount),
        discountReason: r.discount_reason,
        tax: parseFloat(r.tax),
        tip: parseFloat(r.tip),
        total: parseFloat(r.total),
        refunded: parseFloat(r.refunded),
        status: r.status, // 'ready' | 'cancelled' (voided)
        methods: r.methods,
      })),
      totals: {
        count: parseInt(t.count, 10), // ready orders only (voids excluded)
        subtotal: parseFloat(t.subtotal),
        discount: parseFloat(t.discount),
        tax: parseFloat(t.tax),
        tip: parseFloat(t.tip),
        total: grossTotal,
        refunded: refundedTotal,
        net: netTotal,
        paymentsTotal: payTotal,
      },
      // Three surfaces, one number — now on the NET total (gross − refunds),
      // which equals the settled payments sum. Rounded to cents before comparing.
      reconciliation: {
        transactionTotal: grossTotal,
        refundedTotal,
        netTotal,
        paymentsTotal: payTotal,
        balanced: Math.round(netTotal * 100) === Math.round(payTotal * 100),
      },
      comparison,
    });
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch transaction log report");
  } finally {
    client.release();
  }
});

// GET /api/backoffice/reports/discounts?start=YYYY-MM-DD&end=YYYY-MM-DD
// The comp/discount audit report — two grains over the SAME [start, end)
// window of completed (ready) orders that carry a discount:
//   1. per-reason rollup — reason, order count, total discount, % of gross
//      sales (reuses the stats/discounts rollup shape).
//   2. per-order detail — order #, time, subtotal, discount $, the applied %,
//      reason, and WHO applied it (discount_applied_by → staff). This is the
//      audit line that justifies every family/friend/employee/neighbouring-
//      store comp; it's NET-NEW (the by-reason rollup exists, the line-level
//      who/when/how-much did not).
// Both grains share one WHERE (discount > 0 AND discount_reason IS NOT NULL),
// so SUM(rollup.amount) == SUM(detail.discount) by construction. The %-of-
// sales base is gross = SUM(subtotal) over ALL ready orders in the window (the
// same gross the Sales Summary reports). This report is order-side only — a
// discount is not a payment — so settledPaymentsWhere() is deliberately not
// involved.
app.get("/api/backoffice/reports/discounts", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const b = await getStatsBounds(client, req);

    // Gross-sales base for the % — ALL ready orders in the window, not just
    // discounted ones (a comp's weight is measured against total sales).
    const { rows: grossRows } = await client.query(
      `SELECT COALESCE(SUM(subtotal), 0) AS gross
         FROM orders
        WHERE location_id = $1 AND status = 'ready'
          AND completed_at >= $2 AND completed_at < $3`,
      [b.location.id, b.startTs, b.endTs]
    );
    const gross = parseFloat(grossRows[0].gross);
    const pctOf = (amount) => (gross > 0 ? (amount / gross) * 100 : 0);

    // Per-reason rollup (same filter/shape as stats/discounts).
    const { rows: reasonRows } = await client.query(
      `SELECT discount_reason AS reason,
              COALESCE(SUM(discount), 0) AS amount,
              COUNT(*) AS orders
         FROM orders
        WHERE location_id = $1 AND status = 'ready'
          AND discount > 0 AND discount_reason IS NOT NULL
          AND completed_at >= $2 AND completed_at < $3
        GROUP BY discount_reason
        ORDER BY amount DESC`,
      [b.location.id, b.startTs, b.endTs]
    );

    // Per-order detail — the audit line. LEFT JOIN so a comp whose applier
    // was since removed still shows (applied_by = null → "—" in the UI).
    const { rows: detailRows } = await client.query(
      `SELECT o.order_number, o.completed_at, o.subtotal, o.discount,
              o.discount_percent, o.discount_reason, st.name AS applied_by
         FROM orders o
         LEFT JOIN staff st ON st.id = o.discount_applied_by
        WHERE o.location_id = $1 AND o.status = 'ready'
          AND o.discount > 0 AND o.discount_reason IS NOT NULL
          AND o.completed_at >= $2 AND o.completed_at < $3
        ORDER BY o.completed_at DESC, o.order_number DESC`,
      [b.location.id, b.startTs, b.endTs]
    );

    const byReason = reasonRows.map((r) => {
      const amount = parseFloat(r.amount);
      return {
        reason: r.reason,
        amount,
        orders: parseInt(r.orders, 10),
        pctOfSales: pctOf(amount),
      };
    });
    const discountTotal = byReason.reduce((a, r) => a + r.amount, 0);
    const discountedOrders = byReason.reduce((a, r) => a + r.orders, 0);

    res.json({
      range: b.isCustom ? "custom" : req.query.range || "today",
      grossSales: gross,
      discountTotal,
      discountedOrders,
      pctOfSales: pctOf(discountTotal),
      byReason,
      orders: detailRows.map((r) => ({
        orderNumber: r.order_number,
        completedAt: r.completed_at,
        subtotal: parseFloat(r.subtotal),
        discount: parseFloat(r.discount),
        discountPercent: r.discount_percent == null ? null : parseFloat(r.discount_percent),
        discountReason: r.discount_reason,
        appliedBy: r.applied_by, // null if the applier row was removed
      })),
    });
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch discount report");
  } finally {
    client.release();
  }
});

// GET /api/backoffice/reports/refunds?start=YYYY-MM-DD&end=YYYY-MM-DD
// The reversal audit — every void + refund in the period, two grains like the
// Discount Report:
//   1. per-reason rollup — reason, count, total reversed, % of gross sales.
//   2. per-reversal detail — when, order #, type (void/refund), amount, tax,
//      reason, WHO requested + WHO approved (dual-control), method, and the
//      forward-looking Stripe refund id.
// Scoped by WHEN the reversal happened (order_refunds.created_at) — the
// "activity this period" view, deliberately distinct from Sales Summary /
// Transaction Log, which attribute a refund back to the ORIGINAL sale's period
// so their money reconciles with settled payments. The rollup + headline are
// computed from the SAME detail rows, so the rollup total equals the sum of the
// detail lines by construction.
app.get("/api/backoffice/reports/refunds", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const b = await getStatsBounds(client, req);

    // Gross-sales base for the % (ready orders in the window).
    const { rows: grossRows } = await client.query(
      `SELECT COALESCE(SUM(subtotal), 0) AS gross
         FROM orders
        WHERE location_id = $1 AND status = 'ready'
          AND completed_at >= $2 AND completed_at < $3`,
      [b.location.id, b.startTs, b.endTs]
    );
    const gross = parseFloat(grossRows[0].gross);
    const pctOf = (amount) => (gross > 0 ? (amount / gross) * 100 : 0);

    // Every reversal in the window. LEFT JOIN staff so a reversal whose
    // requester/approver was since removed still shows. Method comes from the
    // negative payments row linked by refund_id.
    const { rows } = await client.query(
      `SELECT r.id, r.created_at, o.order_number, r.type, r.amount, r.tax_amount,
              r.reason, r.reason_note, r.stripe_refund_id,
              rq.name AS requested_by, ap.name AS approved_by,
              (SELECT p.method FROM payments p
                 WHERE p.refund_id = r.id ORDER BY p.created_at LIMIT 1) AS method
         FROM order_refunds r
         JOIN orders o ON o.id = r.order_id
         LEFT JOIN staff rq ON rq.id = r.requested_by
         LEFT JOIN staff ap ON ap.id = r.approved_by
        WHERE o.location_id = $1 AND r.status <> 'failed'
          AND r.created_at >= $2 AND r.created_at < $3
        ORDER BY r.created_at DESC`,
      [b.location.id, b.startTs, b.endTs]
    );

    // Rollup + headline from the SAME rows → rollup total == sum of detail.
    const byReasonMap = new Map();
    let refundTotal = 0, refundCount = 0, voidTotal = 0, voidCount = 0;
    for (const r of rows) {
      const amount = parseFloat(r.amount);
      const agg = byReasonMap.get(r.reason) || { reason: r.reason, amount: 0, count: 0 };
      agg.amount = round2(agg.amount + amount);
      agg.count += 1;
      byReasonMap.set(r.reason, agg);
      if (r.type === "void") {
        voidTotal = round2(voidTotal + amount);
        voidCount += 1;
      } else {
        refundTotal = round2(refundTotal + amount);
        refundCount += 1;
      }
    }
    const byReason = [...byReasonMap.values()]
      .map((a) => ({ ...a, pctOfSales: pctOf(a.amount) }))
      .sort((x, y) => y.amount - x.amount);
    const reversedTotal = round2(refundTotal + voidTotal);
    const reversedCount = refundCount + voidCount;

    res.json({
      range: b.isCustom ? "custom" : req.query.range || "today",
      grossSales: gross,
      refundTotal,
      refundCount,
      voidTotal,
      voidCount,
      reversedTotal,
      reversedCount,
      pctOfSales: pctOf(reversedTotal),
      byReason,
      refunds: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        orderNumber: r.order_number,
        type: r.type,
        amount: parseFloat(r.amount),
        taxAmount: parseFloat(r.tax_amount),
        reason: r.reason,
        reasonNote: r.reason_note,
        requestedBy: r.requested_by,
        approvedBy: r.approved_by,
        method: r.method,
        stripeRefundId: r.stripe_refund_id,
      })),
    });
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch refunds report");
  } finally {
    client.release();
  }
});

// GET /api/backoffice/reports/labor?start=YYYY-MM-DD&end=YYYY-MM-DD
// Labor expense + output per staff over the period: hours worked, labor cost,
// and — folded in from Staff Performance — orders handled and sales rung, plus
// report-level total labor cost and labor % of sales.
//
// Same-source invariant: hours/cost come from the SAME canonical worked-time
// helpers (shiftOverlapsWindowSql / workedSecondsSql) as stats/labor, Payroll,
// and My Hours, over the SAME getStatsBounds window — so for a given staffer
// and window this report's worked-time is identical to those surfaces by
// construction (no second formula). Rows are shift-driven (exactly stats/labor's
// population: everyone with a shift overlapping the window, owners included —
// unlike Payroll, which is a Mon–Sun payroll workflow that excludes owners);
// orders/sales are LEFT JOINed on, so a worker who rang nothing (e.g. kitchen)
// still shows their hours/cost with 0 orders. NULL hourly_rate costs $0 (matches
// stats/labor) and is surfaced as a null rate so the UI can flag "rate not set".
app.get("/api/backoffice/reports/labor", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const b = await getStatsBounds(client, req);

    // Per-staff worked seconds (canonical) + orders/sales (staff-performance
    // grain). $1=startTs, $2=endTs, $3=location.id.
    const { rows: perStaffRows } = await client.query(
      `WITH shift_work AS (
         SELECT s.staff_id,
                ${workedSecondsSql("$1", "$2")} AS worked_seconds
           FROM shifts s
          WHERE ${shiftOverlapsWindowSql("$1", "$2")}
       ),
       per_staff AS (
         SELECT staff_id, SUM(worked_seconds) AS worked_seconds
           FROM shift_work GROUP BY staff_id
       ),
       perf AS (
         SELECT o.staff_id, COUNT(*) AS order_count,
                COALESCE(SUM(o.total), 0) AS total_sales
           FROM orders o
          WHERE o.location_id = $3 AND o.status = 'ready'
            AND o.completed_at >= $1 AND o.completed_at < $2
          GROUP BY o.staff_id
       )
       SELECT ps.staff_id, st.name, st.role, st.hourly_rate,
              ps.worked_seconds / 3600.0 AS hours,
              (ps.worked_seconds / 3600.0) * COALESCE(st.hourly_rate, 0) AS labor_cost,
              COALESCE(pf.order_count, 0) AS order_count,
              COALESCE(pf.total_sales, 0) AS total_sales
         FROM per_staff ps
         JOIN staff st ON st.id = ps.staff_id
         LEFT JOIN perf pf ON pf.staff_id = ps.staff_id
        ORDER BY labor_cost DESC, hours DESC, st.name`,
      [b.startTs, b.endTs, b.location.id]
    );

    // Gross-sales base for labor % — SUM(subtotal) over ALL ready orders in the
    // window, identical to stats/labor's grossSales (so the % matches too).
    const { rows: salesRows } = await client.query(
      `SELECT COALESCE(SUM(subtotal), 0) AS gross_sales
         FROM orders
        WHERE location_id = $1 AND status = 'ready'
          AND completed_at >= $2 AND completed_at < $3`,
      [b.location.id, b.startTs, b.endTs]
    );

    const perStaff = perStaffRows.map((r) => ({
      staffId: r.staff_id,
      name: r.name,
      role: r.role,
      hourlyRate: r.hourly_rate == null ? null : parseFloat(r.hourly_rate),
      hours: parseFloat(r.hours),
      laborCost: parseFloat(r.labor_cost),
      orderCount: parseInt(r.order_count, 10),
      totalSales: parseFloat(r.total_sales),
    }));

    // Totals summed the SAME way as stats/labor (JS reduce of parsed floats),
    // so total labor cost / hours are byte-identical to that endpoint.
    const totalLaborCost = perStaff.reduce((a, s) => a + s.laborCost, 0);
    const totalHours = perStaff.reduce((a, s) => a + s.hours, 0);
    const totalOrders = perStaff.reduce((a, s) => a + s.orderCount, 0);
    const totalSales = perStaff.reduce((a, s) => a + s.totalSales, 0);
    const grossSales = parseFloat(salesRows[0].gross_sales);

    res.json({
      range: b.isCustom ? "custom" : req.query.range || "today",
      grossSales,
      totalLaborCost,
      totalHours,
      totalOrders,
      totalSales,
      laborPct: grossSales > 0 ? (totalLaborCost / grossSales) * 100 : 0,
      perStaff,
    });
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch labor report");
  } finally {
    client.release();
  }
});

// --------------- Back Office: Payroll ---------------
// Owner/admin only. Weekly (Mon–Sun, location tz) hours + gross pay per
// staff, plus a persisted Paid/Unpaid marker (payroll_status). Hours reuse
// the same worked = elapsed − breaks math as stats/labor, windowed to the
// week; owners are excluded and NULL hourly_rate surfaces as "rate not set"
// (null pay) rather than $0. See database/payroll_status.sql.

// GET /api/backoffice/payroll?staffId=...&weekStart=YYYY-MM-DD
// weekStart is optional and normalized to that week's Monday; omit for the
// current week.
app.get("/api/backoffice/payroll", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const location = await getSingleActiveLocation(client);
    const tz = location.timezone;

    const weekStartParam = req.query.weekStart;
    if (weekStartParam !== undefined && !isYmd(weekStartParam)) {
      throw new HttpError(400, "weekStart must be YYYY-MM-DD");
    }

    // Normalize to the Monday of the week (in the location tz); default to
    // the current week. Also return the Sunday for display/filenames.
    const { rows: wk } = await client.query(
      `SELECT to_char(ws, 'YYYY-MM-DD') AS week_start, to_char(ws + 6, 'YYYY-MM-DD') AS week_end
         FROM (SELECT date_trunc('week', COALESCE($1::date, (now() AT TIME ZONE $2)::date))::date AS ws) t`,
      [weekStartParam ?? null, tz]
    );
    const weekStart = wk[0].week_start; // "YYYY-MM-DD" (Monday)

    // Per non-owner staffer with a shift starting this week: worked seconds
    // capped at the week's end (LEAST(..., end_ts)) so a forgotten open
    // shift in a PAST week doesn't grow forever; for the current week end_ts
    // is in the future so now() wins. Breaks handled the same way.
    const { rows } = await client.query(
      `WITH b AS (
         SELECT $2::date AS week_start,
                ($2::date::timestamp AT TIME ZONE $3) AS start_ts,
                (($2::date + 7)::timestamp AT TIME ZONE $3) AS end_ts
       ),
       shift_work AS (
         SELECT s.staff_id,
                ${workedSecondsSql("b.start_ts", "b.end_ts")} AS worked_seconds
           FROM shifts s CROSS JOIN b
          WHERE s.location_id = $1
            AND ${shiftOverlapsWindowSql("b.start_ts", "b.end_ts")}
       ),
       per_staff AS (
         SELECT staff_id, SUM(worked_seconds) AS worked_seconds
           FROM shift_work GROUP BY staff_id
       )
       SELECT st.id AS staff_id, st.name, st.role, st.hourly_rate,
              ps.worked_seconds, COALESCE(pst.paid, false) AS paid
         FROM per_staff ps
         JOIN staff st ON st.id = ps.staff_id
         LEFT JOIN payroll_status pst ON pst.staff_id = st.id AND pst.week_start = $2::date
        WHERE st.role <> 'owner'
        ORDER BY st.name`,
      [location.id, weekStart, tz]
    );

    const round2 = (n) => Math.round(n * 100) / 100;
    res.json({
      weekStart,
      weekEnd: wk[0].week_end,
      rows: rows.map((r) => {
        const hours = round2(parseFloat(r.worked_seconds) / 3600);
        const rate = r.hourly_rate == null ? null : parseFloat(r.hourly_rate);
        return {
          staff_id: r.staff_id,
          name: r.name,
          role: r.role,
          hours,
          hourlyRate: rate,
          grossPay: rate == null ? null : round2(hours * rate),
          paid: r.paid,
        };
      }),
    });
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch payroll");
  } finally {
    client.release();
  }
});

// PUT /api/backoffice/payroll/status
// Body: { staffId (session), weekStart, entries: [{ staffId, paid }] }.
// Upserts the Paid/Unpaid marker for each staffer for the given week.
app.put("/api/backoffice/payroll/status", async (req, res) => {
  const client = await pool.connect();
  try {
    const requester = await requireBackofficeSession(req);
    const location = await getSingleActiveLocation(client);
    const { weekStart, entries } = req.body || {};
    if (!isYmd(weekStart)) throw new HttpError(400, "weekStart must be YYYY-MM-DD");
    if (!Array.isArray(entries)) throw new HttpError(400, "entries must be an array");
    for (const e of entries) {
      if (!e || typeof e.staffId !== "string" || typeof e.paid !== "boolean") {
        throw new HttpError(400, "each entry needs a staffId and a boolean paid");
      }
    }

    await client.query("BEGIN");
    for (const e of entries) {
      await client.query(
        `INSERT INTO payroll_status (location_id, staff_id, week_start, paid, paid_at, paid_by, updated_at)
         VALUES ($1, $2, date_trunc('week', $3::date)::date, $4,
                 CASE WHEN $4 THEN now() ELSE NULL END, $5, now())
         ON CONFLICT (staff_id, week_start) DO UPDATE
           SET paid = EXCLUDED.paid,
               paid_at = CASE WHEN EXCLUDED.paid THEN now() ELSE NULL END,
               paid_by = $5,
               updated_at = now()`,
        [location.id, e.staffId, weekStart, e.paid, requester.id]
      );
    }
    await client.query("COMMIT");
    res.json({ success: true, count: entries.length });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    sendHttpError(res, err, "Failed to save payroll status");
  } finally {
    client.release();
  }
});

// --------------- Device pairing (Order Entry / KDS access) ---------------
// Adds a device-trust layer UNDERNEATH staffId/PIN identity
// (docs/architecture/device-pairing.md, "Why") — orthogonal to who's logged
// in, this is about whether the physical tablet itself was ever authorized
// by an owner/admin. See database/device_pairing.sql for the full schema
// rationale (single-use hashed codes, DB-driven revocation, etc.).
//
// This section defines generate/pair/list/revoke plus the
// requireDevicePairing middleware. That middleware is now attached (in
// the same pass as the frontend pairing guards, so the cutover is atomic)
// to POST /api/auth/login and the KDS/Order-Entry order routes:
// POST /api/orders, GET /api/orders, GET /api/orders/history, and the two
// PATCH /api/orders/:id/status[/revert] routes. Those are exactly the
// server-side surface of the two device-gated screens; Back Office's own
// routes have their own session gate and are intentionally NOT device-
// gated (an owner manages devices from any browser, not a paired tablet).

const DEVICE_COOKIE_NAME = "device_token";
// Deliberately long — physical possession of the tablet is the real
// security boundary here, not the token's clock. Immediate revocation is
// handled by requireDevicePairing re-checking the database on every
// check-in (see below), not by letting this expire quickly.
const DEVICE_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 min — typed once, immediately, by someone standing at the device
const PAIRING_CODE_LENGTH = 8;
// Excludes 0/O, 1/I/L — ambiguous when handwritten, read aloud, or shown
// in a font that doesn't distinguish them. 32 characters exactly so
// `byte % 32` below is perfectly uniform (256 / 32 = 8, no modulo bias).
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generatePairingCode() {
  const bytes = crypto.randomBytes(PAIRING_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
  }
  return code;
}

// Same principle as hashResetToken — the raw code only ever exists in the
// generate-code HTTP response and the pair request body, never at rest.
function hashPairingCode(rawCode) {
  return crypto.createHash("sha256").update(rawCode).digest("hex");
}

// Cross-domain cookie flags (httpOnly/secure/sameSite/domain) are
// identical to the Back Office session cookie's — same frontend/backend
// split, same Safari cross-site quirks — so this reuses sessionCookieOpts
// directly rather than duplicating that logic under a new name.
function issueDeviceCookie(req, res, deviceId) {
  const token = jwt.sign({ deviceId, purpose: "device" }, DEVICE_SECRET, {
    expiresIn: Math.floor(DEVICE_COOKIE_MAX_AGE_MS / 1000),
  });
  res.cookie(DEVICE_COOKIE_NAME, token, { ...sessionCookieOpts(req), maxAge: DEVICE_COOKIE_MAX_AGE_MS });
}

function readDeviceIdFromCookie(req) {
  const token = req.cookies?.[DEVICE_COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, DEVICE_SECRET);
    return payload.purpose === "device" && payload.deviceId ? payload.deviceId : null;
  } catch {
    return null; // expired/invalid/tampered — treat exactly like "not paired"
  }
}

// Resolves the device cookie -> a still-valid, paired, non-revoked
// device_id, or null. This (not just JWT verification) is what makes
// revocation immediate rather than bounded by the cookie's 1-year clock.
async function resolveDeviceId(req) {
  const deviceId = readDeviceIdFromCookie(req);
  if (!deviceId) return null;
  const { rows } = await pool.query(
    `SELECT device_id FROM device_pairings
      WHERE device_id = $1 AND paired_at IS NOT NULL AND revoked_at IS NULL`,
    [deviceId]
  );
  return rows[0] ? deviceId : null;
}

// Which POS surface a gated request belongs to, so Back Office can show
// what a device is connected to. Order Entry = PIN login, checkout, and the
// order-recall/reversal flow; everything else gated (board poll, history,
// status advance/revert, void acknowledgement) is KDS. Returns the
// device_pairings column to stamp — a fixed internal set, never user input,
// so it's safe to interpolate into the UPDATE below.
//
// Method matters on /api/orders: POST is checkout (Order Entry) but GET is
// the KDS board poll, so that one can't be matched on path alone.
function surfaceColumnForRequest(req) {
  const { method, path } = req;
  if (path === "/api/auth/login") return "last_order_entry_at";
  if (method === "POST" && path === "/api/orders") return "last_order_entry_at";
  // Order recall + reversal — all three are driven from the Order Entry
  // screen, not the KDS. The refund route carries an :id, so it needs a
  // pattern; it deliberately does NOT match /acknowledge-void, which is the
  // KDS dismissing a voided ticket.
  if (path === "/api/orders/pos-recall") return "last_order_entry_at";
  if (path === "/api/staff/approvers") return "last_order_entry_at";
  // Card-payment status polling and cancel — both driven from the Order Entry
  // checkout screen, never the KDS.
  if (/^\/api\/orders\/pending\/[^/]+/.test(path)) return "last_order_entry_at";
  if (method === "POST" && /^\/api\/orders\/[^/]+\/refund$/.test(path)) {
    return "last_order_entry_at";
  }
  return "last_kds_at";
}

// Express middleware for the routes that require a paired device (PIN
// login and the order routes — see the note at the top of this section
// for the exact list). Updates last_seen_at plus the matching per-surface
// timestamp on every pass, so Back Office's device list reflects real
// activity and a revoked device is caught on its very next check-in.
async function requireDevicePairing(req, res, next) {
  try {
    const deviceId = await resolveDeviceId(req);
    if (!deviceId) {
      throw new HttpError(401, "This device isn't paired — enter a pairing code to continue");
    }
    const surfaceCol = surfaceColumnForRequest(req);
    pool
      .query(
        `UPDATE device_pairings SET last_seen_at = now(), ${surfaceCol} = now() WHERE device_id = $1`,
        [deviceId]
      )
      .catch((err) => console.error("Failed to update device activity:", err.message));
    req.deviceId = deviceId;
    next();
  } catch (err) {
    sendHttpError(res, err, "Device pairing required");
  }
}

// GET /api/devices/me — public (a device isn't authenticated as staff or
// as itself yet when this is called). Lets the frontend's route guard
// check pairing status on load without needing to provoke a 401 from
// requireDevicePairing just to find out.
app.get("/api/devices/me", async (req, res) => {
  try {
    const deviceId = await resolveDeviceId(req);
    if (!deviceId) return res.json({ paired: false });
    const { rows } = await pool.query("SELECT device_name FROM device_pairings WHERE device_id = $1", [deviceId]);
    res.json({ paired: true, deviceName: rows[0]?.device_name || null });
  } catch (err) {
    sendHttpError(res, err, "Failed to check device pairing status");
  }
});

// POST /api/backoffice/devices/generate-code
// Owner/admin, session-cookie authenticated. Creates a pending
// device_pairings row (device_name/paired_at still NULL — see migration
// comments) and returns the RAW code exactly once; only its hash is ever
// stored. Rate-limited per requester using the same sliding-window
// counter PIN/TOTP login already use — recordFailedAttempt is reused
// here purely as the generic throttle it actually is (a counter with a
// lockout), not because generating a code is a "failure."
app.post("/api/backoffice/devices/generate-code", async (req, res) => {
  try {
    const requester = await requireBackofficeSession(req);

    const rateCheck = checkRateLimit(requester.id, "device-pair-gen");
    if (!rateCheck.allowed) {
      throw new HttpError(429, formatLockoutMessage(rateCheck.retryAfter));
    }

    const rawCode = generatePairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
    const { rows } = await pool.query(
      `INSERT INTO device_pairings (pairing_code_hash, code_expires_at, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, code_expires_at`,
      [hashPairingCode(rawCode), expiresAt, requester.id]
    );

    recordFailedAttempt(requester.id, "device-pair-gen");

    res.status(201).json({ pairingId: rows[0].id, code: rawCode, expiresAt: rows[0].code_expires_at });
  } catch (err) {
    sendHttpError(res, err, "Failed to generate pairing code");
  }
});

// POST /api/devices/pair — { code, deviceName }
// Public (the whole point — a device isn't authenticated as anything
// yet). Rate-limited by the submitted code VALUE, same pattern PIN login
// uses (key by the identity being guessed, not IP — see the rate
// limiter's own comments above for why IP isn't trustworthy here either).
// Generic error message on any failure reason (unknown/expired/already-
// used/revoked code all look identical to the caller), same principle as
// forgot-password never revealing which part was wrong.
app.post("/api/devices/pair", async (req, res) => {
  try {
    const { code, deviceName } = req.body || {};
    if (typeof code !== "string" || !code.trim()) {
      throw new HttpError(400, "Pairing code is required");
    }
    if (typeof deviceName !== "string" || !deviceName.trim()) {
      throw new HttpError(400, "Device name is required");
    }
    const rawCode = code.trim().toUpperCase();

    const rateCheck = checkRateLimit(rawCode, "device-pair-validate");
    if (!rateCheck.allowed) {
      throw new HttpError(429, formatLockoutMessage(rateCheck.retryAfter));
    }

    const { rows } = await pool.query(
      `SELECT id, device_id FROM device_pairings
        WHERE pairing_code_hash = $1 AND code_expires_at > now()
          AND paired_at IS NULL AND revoked_at IS NULL`,
      [hashPairingCode(rawCode)]
    );
    const pending = rows[0];
    if (!pending) {
      const attempt = recordFailedAttempt(rawCode, "device-pair-validate");
      if (attempt.lockedOut) {
        throw new HttpError(429, formatLockoutMessage(attempt.retryAfter));
      }
      throw new HttpError(400, "This code is invalid or has expired — request a new one");
    }

    await pool.query(
      `UPDATE device_pairings SET device_name = $1, paired_at = now(), last_seen_at = now() WHERE id = $2`,
      [deviceName.trim(), pending.id]
    );
    clearAttempts(rawCode, "device-pair-validate");

    issueDeviceCookie(req, res, pending.device_id);
    res.json({ success: true });
  } catch (err) {
    sendHttpError(res, err, "Failed to pair device");
  }
});

// GET /api/backoffice/devices — owner/admin. Every device that completed
// pairing at some point (active AND revoked — revoked rows stay visible
// as audit history, same "never hard-delete" spirit as the rest of this
// schema). Pending, never-redeemed codes are excluded; they're not a
// "device" yet.
app.get("/api/backoffice/devices", async (req, res) => {
  try {
    await requireBackofficeSession(req);
    const { rows } = await pool.query(
      `SELECT dp.id, dp.device_id, dp.device_name, dp.paired_at, dp.last_seen_at, dp.revoked_at,
              dp.last_order_entry_at, dp.last_kds_at,
              creator.name AS created_by_name, revoker.name AS revoked_by_name
         FROM device_pairings dp
         JOIN staff creator ON creator.id = dp.created_by
         LEFT JOIN staff revoker ON revoker.id = dp.revoked_by
        WHERE dp.paired_at IS NOT NULL
        ORDER BY dp.paired_at DESC`
    );
    res.json(rows);
  } catch (err) {
    sendHttpError(res, err, "Failed to fetch paired devices");
  }
});

// PUT /api/backoffice/devices/:id — owner/admin. Rename only (device_name);
// added for the Back Office Devices section's editable-name requirement —
// there was no write route for this until now, everything else in this
// section predates it. Works on revoked rows too (renaming a device
// doesn't touch its trust status either way, and revoked rows staying
// identifiable is part of why they're kept instead of hard-deleted).
app.put("/api/backoffice/devices/:id", async (req, res) => {
  try {
    await requireBackofficeSession(req);
    const { device_name } = req.body || {};
    if (typeof device_name !== "string" || !device_name.trim()) {
      throw new HttpError(400, "device_name is required");
    }
    const { rows } = await pool.query(
      `UPDATE device_pairings SET device_name = $1
        WHERE id = $2 AND paired_at IS NOT NULL
        RETURNING id, device_id, device_name, paired_at, last_seen_at, revoked_at`,
      [device_name.trim().slice(0, 60), req.params.id]
    );
    if (rows.length === 0) {
      throw new HttpError(404, "Paired device not found");
    }
    res.json(rows[0]);
  } catch (err) {
    sendHttpError(res, err, "Failed to rename device");
  }
});

// POST /api/backoffice/devices/:id/revoke — owner/admin. :id is the
// device_pairings row id (not device_id) — same convention as
// /api/backoffice/staff/:id using staff.id. Idempotency guard (WHERE
// revoked_at IS NULL) means re-revoking an already-revoked row 404s
// instead of silently overwriting who/when it was originally revoked.
app.post("/api/backoffice/devices/:id/revoke", async (req, res) => {
  try {
    const requester = await requireBackofficeSession(req);
    const { rows } = await pool.query(
      `UPDATE device_pairings
          SET revoked_at = now(), revoked_by = $1
        WHERE id = $2 AND paired_at IS NOT NULL AND revoked_at IS NULL
        RETURNING id, device_name`,
      [requester.id, req.params.id]
    );
    if (rows.length === 0) {
      throw new HttpError(404, "Paired device not found (or already revoked)");
    }
    res.json({ success: true, id: rows[0].id, deviceName: rows[0].device_name });
  } catch (err) {
    sendHttpError(res, err, "Failed to revoke device");
  }
});

// --------------- Start server ---------------
// Guarded so tests can `require('./server.js')` to exercise helpers/handlers
// directly without opening the port. `node server.js` / `npm run dev` still
// start listening exactly as before.
// Boot-time schema guard. Deploying code that references a not-yet-created
// column 500s every query against that table — it has taken prod down twice
// (is_upsell, then the Refunds/KDS void migrations). Refusing to start makes
// Render's health check fail, so the deploy rolls back and the previous
// working version keeps serving instead of a half-broken new one.
//
// Fail CLOSED on confirmed drift, OPEN on connectivity: if we can't reach the
// database we log loudly and start anyway, because turning a transient
// connection blip into a crash-loop would be an outage we caused ourselves.
async function assertSchemaCurrent() {
  const { findMissingSchema, formatFailure } = require("./scripts/check-schema");
  try {
    const result = await findMissingSchema(pool);
    if (result.missingTables.length || result.missingColumns.length) {
      console.error(formatFailure(result));
      process.exit(1);
    }
  } catch (err) {
    console.error(
      `WARNING: could not verify database schema at boot (${err.message}). ` +
        `Starting anyway — run \`npm run check:schema\` once the database is reachable.`
    );
  }
}

// Opt-in background reconciliation. Off unless RECONCILE_INTERVAL_MINUTES is
// set, so nothing runs unattended until someone decides it should. Only starts
// when this file IS the entry point — a test or tooling that requires server.js
// must not silently acquire a timer that mutates payment state.
function startReconciliationSchedule() {
  if (!(RECONCILE_INTERVAL_MINUTES > 0)) return;
  if (!stripeClient) {
    console.log("Reconciliation schedule not started: Stripe is not configured");
    return;
  }
  const everyMs = RECONCILE_INTERVAL_MINUTES * 60 * 1000;
  console.log(
    `Reconciliation scheduled every ${RECONCILE_INTERVAL_MINUTES}m ` +
      `(sweeping payments older than ${RECONCILE_STALE_MINUTES}m)`
  );
  const timer = setInterval(() => {
    reconcilePendingCheckouts().catch((err) =>
      console.error("Scheduled reconciliation failed:", err.message)
    );
  }, everyMs);
  // Don't hold the process open on shutdown.
  if (typeof timer.unref === "function") timer.unref();
}

if (require.main === module) {
  assertSchemaCurrent().then(() => {
    app.listen(PORT, () => {
      console.log(`Narcos Tacos POS API running on http://localhost:${PORT}`);
      startReconciliationSchedule();
    });
  });
}

module.exports = {
  app,
  pool,
  applyRefund,
  requireStaffIdParam,
  verifyStaffPin,
  reconcilePendingCheckouts,
};
