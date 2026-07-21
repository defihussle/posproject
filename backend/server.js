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
      "SELECT id, category_id, name, description, base_price, image_url, sort_order FROM menu_items WHERE active = true ORDER BY sort_order, name"
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

// PIN login
app.post("/api/auth/login", async (req, res) => {
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

app.post("/api/orders", async (req, res) => {
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
  try {
    await client.query("BEGIN");

    // ---- Resolve staff + location (source of the tax rate) ----
    const { rows: staffRows } = await client.query(
      "SELECT id, location_id FROM staff WHERE id = $1 AND active = true",
      [staffId]
    );
    if (staffRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Unknown or inactive staff member" });
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
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No location available for this order" });
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
    const tip = 0;
    const total = round2(discountedSubtotal + tax + tip);

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
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Order creation failed:", err);
    return res.status(500).json({ error: "Failed to create order" });
  } finally {
    client.release();
  }
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
    `SELECT id, order_number, status, fulfillment_type, created_at, completed_at
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
      items: itemsByOrder[o.id] || [],
    };
  }
  return orderIds.map((id) => byId[id]).filter(Boolean);
}

const KDS_ALLOWED_STATUSES = ["open", "preparing", "ready", "completed", "cancelled"];

// GET /api/orders?status=open,preparing  (defaults to open,preparing)
app.get("/api/orders", async (req, res) => {
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

    const { rows: idRows } = await client.query(
      `SELECT id FROM orders
        WHERE location_id = $1 AND status::text = ANY($2::text[])
        ORDER BY created_at ASC`, // FIFO oldest-first
      [locationId, statuses]
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
app.get("/api/orders/history", async (req, res) => {
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

    const { rows: idRows } = await client.query(
      `SELECT id FROM orders
        WHERE location_id = $1
          AND status = 'ready'
          AND completed_at >= now() - ($2::numeric * interval '1 hour')
        ORDER BY completed_at DESC`, // most-recent-first
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

// PATCH /api/orders/:id/status   body: { status: "preparing" | "ready" }
// Advances the whole order one step and keeps order_items.status in lockstep,
// all inside one transaction so the two can never drift out of sync.
app.patch("/api/orders/:id/status", async (req, res) => {
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
app.patch("/api/orders/:id/status/revert", async (req, res) => {
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
      `SELECT id, category_id, name, description, base_price, active, sort_order
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
// Body: { staffId, name, description, base_price, active }
app.put("/api/backoffice/menu-items/:id", async (req, res) => {
  try {
    const { description, active } = req.body || {};
    await requireBackofficeSession(req);
    const { name, price } = validateItemFields(req.body || {});
    if (typeof active !== "boolean") {
      throw new HttpError(400, "active must be a boolean");
    }

    const { rows } = await pool.query(
      `UPDATE menu_items
          SET name = $1, description = $2, base_price = $3, active = $4
        WHERE id = $5
        RETURNING id, category_id, name, description, base_price, active, sort_order`,
      [name, description || null, price, active, req.params.id]
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

    const { rows } = await pool.query(
      `INSERT INTO menu_items (category_id, name, description, base_price, active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, category_id, name, description, base_price, active, sort_order`,
      [category_id, name, description || null, price]
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

    if (refRows[0].n > 0) {
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
    const finalDelta = isPricelessGroupName(groupRows[0].name) ? 0 : delta;

    const { rows } = await pool.query(
      `INSERT INTO modifier_options (group_id, name, price_delta, max_quantity, default_selected, active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, group_id, name, price_delta, sort_order, max_quantity, default_selected, active`,
      [group_id, name, finalDelta, DEFAULT_OPTION_MAX_QUANTITY, req.body.default_selected]
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
app.delete("/api/backoffice/modifier-options/:id", async (req, res) => {
  try {
    await requireBackofficeSession(req);

    const { rows: refRows } = await pool.query(
      "SELECT count(*)::int AS n FROM order_item_modifiers WHERE modifier_option_id = $1",
      [req.params.id]
    );

    if (refRows[0].n > 0) {
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

    const { rows: breakRows } = await pool.query(
      "SELECT break_start FROM shift_breaks WHERE shift_id = $1 AND break_end IS NULL ORDER BY break_start DESC LIMIT 1",
      [shift.id]
    );
    if (breakRows.length > 0) {
      return res.json({ status: "on_break", clockIn: shift.clock_in, breakStart: breakRows[0].break_start });
    }
    return res.json({ status: "working", clockIn: shift.clock_in });
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

      await client.query("COMMIT");
      res.json({ success: true, shift: rows[0] });
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

    const { rows: shiftRows } = await pool.query(
      `SELECT id, clock_in, clock_out
         FROM shifts
        WHERE staff_id = $1
          AND clock_in >= (date_trunc($2, now() AT TIME ZONE $3) AT TIME ZONE $3)
        ORDER BY clock_in DESC`,
      [requester.id, trunc, location.timezone]
    );

    // Break seconds per shift. A closed break uses its real duration; an
    // open break (only possible on the currently-open shift, since
    // clock-out always closes any open break first) counts up to now(),
    // the same "still running" treatment the open shift itself gets below.
    const shiftIds = shiftRows.map((s) => s.id);
    const breakSecondsByShift = {};
    if (shiftIds.length > 0) {
      const { rows: breakRows } = await pool.query(
        "SELECT shift_id, break_start, break_end FROM shift_breaks WHERE shift_id = ANY($1)",
        [shiftIds]
      );
      for (const b of breakRows) {
        const endMs = b.break_end ? new Date(b.break_end).getTime() : Date.now();
        const seconds = Math.max(0, (endMs - new Date(b.break_start).getTime()) / 1000);
        breakSecondsByShift[b.shift_id] = (breakSecondsByShift[b.shift_id] || 0) + seconds;
      }
    }

    let totalSeconds = 0;
    const shifts = shiftRows.map((s) => {
      const clockOutMs = s.clock_out ? new Date(s.clock_out).getTime() : Date.now();
      const grossSeconds = Math.max(0, (clockOutMs - new Date(s.clock_in).getTime()) / 1000);
      const breakSeconds = breakSecondsByShift[s.id] || 0;
      // Worked time = clocked time minus every break within it — floored at
      // 0 so it can never go negative.
      const seconds = Math.max(0, grossSeconds - breakSeconds);
      totalSeconds += seconds;
      return {
        id: s.id,
        clockIn: s.clock_in,
        clockOut: s.clock_out,
        seconds: Math.round(seconds),
        breakSeconds: Math.round(breakSeconds),
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

// GET /api/backoffice/stats/summary?staffId=...&range=today|week|month
app.get("/api/backoffice/stats/summary", async (req, res) => {
  const client = await pool.connect();
  try {
    await requireBackofficeSession(req);
    const { range, trunc } = resolveStatsRange(req.query.range);
    const location = await getSingleActiveLocation(client);

    const { rows } = await client.query(
      `SELECT COALESCE(SUM(total), 0) AS total_sales, COUNT(*) AS order_count,
              COALESCE(SUM(tip), 0) AS total_tips
         FROM orders
        WHERE location_id = $1
          AND status = 'ready'
          AND completed_at >= (date_trunc($2, now() AT TIME ZONE $3) AT TIME ZONE $3)`,
      [location.id, trunc, location.timezone]
    );
    const totalSales = parseFloat(rows[0].total_sales);
    const orderCount = parseInt(rows[0].order_count, 10);
    res.json({
      range,
      totalSales,
      orderCount,
      avgOrderValue: orderCount > 0 ? totalSales / orderCount : 0,
      // Always $0 today — checkout doesn't collect tips yet (orders.tip is
      // hardcoded to 0 until Stripe Terminal integration lands). This is
      // display-readiness only: the stat and its plumbing are correct now,
      // so tips will show up automatically the moment real tip capture is
      // wired into checkout — no dashboard change needed then.
      totalTips: parseFloat(rows[0].total_tips),
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
    const { trunc } = resolveStatsRange(req.query.range);
    const location = await getSingleActiveLocation(client);

    const limit = req.query.limit === undefined ? 5 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new HttpError(400, "limit must be an integer between 1 and 50");
    }

    const { rows } = await client.query(
      `SELECT mi.id AS item_id, mi.name AS item_name,
              iv.id AS variant_id, iv.name AS variant_name,
              SUM(oi.quantity) AS quantity
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN menu_items mi ON mi.id = oi.item_id
         LEFT JOIN item_variants iv ON iv.id = oi.variant_id
        WHERE o.location_id = $1
          AND o.status = 'ready'
          AND o.completed_at >= (date_trunc($2, now() AT TIME ZONE $3) AT TIME ZONE $3)
        GROUP BY mi.id, mi.name, iv.id, iv.name
        ORDER BY quantity DESC
        LIMIT $4`,
      [location.id, trunc, location.timezone, limit]
    );
    res.json(
      rows.map((r) => ({
        item_id: r.item_id,
        name: r.item_name,
        variant: r.variant_name,
        quantity: parseInt(r.quantity, 10),
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
    const { trunc } = resolveStatsRange(req.query.range);
    const location = await getSingleActiveLocation(client);

    const { rows } = await client.query(
      `SELECT s.id AS staff_id, s.name AS staff_name, s.role,
              COUNT(*) AS order_count,
              COALESCE(SUM(o.total), 0) AS total_sales
         FROM orders o
         JOIN staff s ON s.id = o.staff_id
        WHERE o.location_id = $1
          AND o.status = 'ready'
          AND o.completed_at >= (date_trunc($2, now() AT TIME ZONE $3) AT TIME ZONE $3)
        GROUP BY s.id, s.name, s.role
        ORDER BY order_count DESC`,
      [location.id, trunc, location.timezone]
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

// --------------- Start server ---------------
app.listen(PORT, () => {
  console.log(`Narcos Tacos POS API running on http://localhost:${PORT}`);
});
