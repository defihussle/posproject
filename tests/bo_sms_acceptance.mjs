// Staff SMS auth P3 Slice 3 — Back Office SMS second factor + SMS password
// reset acceptance tests.
//
// Runs the real Express app in-process against the LOCAL Docker database
// (DATABASE_URL forced below) and deletes every row it creates. Twilio is
// never reached: global fetch is stubbed and records each request, so the
// test reads codes out of the message body. Super-owner env is blanked so
// backend/.env can't change who counts as the primary owner.
//
// Run from the repo root: node tests/bo_sms_acceptance.mjs

process.env.DATABASE_URL = "postgresql://narcos:narcos_dev@localhost:5432/narcos_tacos";
process.env.SESSION_SECRET = "test-session-secret";
process.env.DEVICE_SECRET = "test-device-secret";
process.env.SUPER_OWNER_EMAIL = "";
process.env.SUPER_OWNER_STAFF_ID = "";
process.env.STAFF_SMS_ENABLED = "";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_STAFF_FROM_NUMBER = "+15550000002";
process.env.TWILIO_FROM_NUMBER = "+15550000001"; // customer sender — must never be used
process.env.ONLINE_SMS_ENABLED = "true"; // must not turn staff sends on
process.env.RESEND_API_KEY = ""; // no email goes anywhere either

import { createRequire } from "module";

const requireBackend = createRequire(new URL("../backend/package.json", import.meta.url));
const jwt = requireBackend("jsonwebtoken");
const bcrypt = requireBackend("bcryptjs");
const otplib = requireBackend("otplib");

const realFetch = globalThis.fetch;
const twilioCalls = [];
let otherExternal = 0;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, opts);
  if (u.startsWith("https://api.twilio.com/")) {
    twilioCalls.push(Object.fromEntries(new URLSearchParams(opts.body)));
    return new Response(JSON.stringify({ sid: `SMtest${twilioCalls.length}` }), { status: 201 });
  }
  otherExternal += 1;
  throw new Error(`unexpected external fetch: ${u}`);
};

const { app, pool } = await import("../backend/server.js");

let failures = 0;
function ok(label, condition, detail = "") {
  console.log(`  ${condition ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const created = [];

async function freePin() {
  const { rows } = await pool.query("SELECT pin_hash FROM staff WHERE active = true AND pin_hash IS NOT NULL");
  for (;;) {
    const pin = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    let taken = false;
    for (const r of rows) if (await bcrypt.compare(pin, r.pin_hash)) { taken = true; break; }
    if (!taken) return pin;
  }
}

const P = (n) => `+1416555${String(n).padStart(4, "0")}`;
const phones = [P(121), P(122), P(123), P(124), P(125)];
const emails = ["s3owner@test.invalid", "s3nophone@test.invalid", "s3setup@test.invalid", "s3cashier@test.invalid", "s3admin2@test.invalid"];
const { rows: clash } = await pool.query(
  "SELECT 1 FROM staff WHERE phone = ANY($1) OR lower(email) = ANY($2)", [phones, emails]
);
if (clash.length) {
  console.error("Test phones/emails already exist in staff — aborting.");
  process.exit(2);
}

const PASSWORD = "correct horse battery";
const pwHash = await bcrypt.hash(PASSWORD, 10);
async function addStaff({ name, role, phone = null, email = null, password = false, totpSecret = null, pin = null }) {
  const { rows } = await pool.query(
    `INSERT INTO staff (name, title, role, hourly_rate, phone, email, password_hash, totp_secret, totp_enabled, pin_hash, active)
     VALUES ($1, $2, $3, 20, $4, $5, $6, $7, $8, $9, true) RETURNING id`,
    [name, role, role, phone, email, password ? pwHash : null, totpSecret, !!totpSecret, pin ? await bcrypt.hash(pin, 10) : null]
  );
  created.push(rows[0].id);
  return rows[0].id;
}

const ownerSecret = otplib.generateSecret();
const idOwner = await addStaff({ name: "S3 Owner", role: "owner", phone: P(121), email: emails[0], password: true, totpSecret: ownerSecret });
const idNoPhone = await addStaff({ name: "S3 NoPhone", role: "admin", email: emails[1], password: true, totpSecret: otplib.generateSecret() });
const setupPin = await freePin();
const idSetup = await addStaff({ name: "S3 Setup", role: "admin", phone: P(123), pin: setupPin });
const idCashier = await addStaff({ name: "S3 Cashier", role: "cashier", phone: P(124), email: emails[3], password: true, totpSecret: otplib.generateSecret() });
const idAdmin2 = await addStaff({ name: "S3 Admin2", role: "admin", phone: P(125), email: emails[4], password: true, totpSecret: otplib.generateSecret() });

async function call(path, body, { method = "POST", cookie = "" } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})), setCookie: res.headers.get("set-cookie") || "" };
}
const codes = (staffId, purpose) =>
  pool.query("SELECT * FROM staff_auth_codes WHERE staff_id = $1 AND purpose = $2 ORDER BY created_at", [staffId, purpose]).then((r) => r.rows);
async function settle(check) {
  for (let i = 0; i < 40; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
const lastCode = () => /(\d{6})/.exec(twilioCalls.at(-1).Body)[1];
const backdate = (staffId) =>
  pool.query("UPDATE staff_auth_codes SET created_at = created_at - interval '2 minutes' WHERE staff_id = $1", [staffId]);
const step1 = (email, password = PASSWORD) => call("/api/backoffice/auth/login-step1", { email, password });

try {
  console.log("Login step 1:");
  const s1 = await step1(emails[0]);
  ok("owner with phone -> 2fa_choice", s1.status === 200 && s1.data.stage === "2fa_choice", JSON.stringify(s1.data));
  ok("phone only as a hint", s1.data.phoneHint?.endsWith("0121") && !JSON.stringify(s1.data).includes(P(121)));
  ok("TOTP already enabled -> totp: verify", s1.data.totp === "verify");
  const np = await step1(emails[1]);
  ok("admin with no phone -> straight to TOTP (unchanged)", np.status === 200 && np.data.stage === "2fa");
  const cs = await step1(emails[3]);
  ok("cashier -> generic 401 at step 1 (no BO login at all)", cs.status === 401);

  console.log("Cashier cannot use SMS even with a forged choice token:");
  const forged = jwt.sign({ staffId: idCashier, purpose: "2fa_choice" }, process.env.SESSION_SECRET);
  const fc = await call("/api/backoffice/auth/2fa/choose", { tempToken: forged, method: "sms" });
  ok("choose -> 401, no code", fc.status === 401 && (await codes(idCashier, "bo_login")).length === 0);

  console.log("Flag off:");
  const offSms = await call("/api/backoffice/auth/2fa/choose", { tempToken: s1.data.tempToken, method: "sms" });
  ok("same 2fa_sms reply", offSms.status === 200 && offSms.data.stage === "2fa_sms", JSON.stringify(offSms.data));
  ok("no Twilio call, code retired", await settle(async () => (await codes(idOwner, "bo_login")).every((c) => c.consumed_at)) && twilioCalls.length === 0);

  process.env.STAFF_SMS_ENABLED = "true";
  await backdate(idOwner);

  console.log("SMS login:");
  const sms = await call("/api/backoffice/auth/2fa/choose", { tempToken: s1.data.tempToken, method: "sms" });
  await settle(() => twilioCalls.length > 0);
  ok("texted from staff sender to staff.phone", twilioCalls[0]?.From === "+15550000002" && twilioCalls[0]?.To === P(121));
  ok("copy", /^Narcos staff code: \d{6}\. Expires in 10 min\.$/.test(twilioCalls[0]?.Body || ""), twilioCalls[0]?.Body);
  const code = lastCode();
  const bad = await call("/api/backoffice/auth/2fa/sms/verify", { tempToken: sms.data.tempToken, code: code === "000000" ? "111111" : "000000" });
  ok("wrong code -> 401, 4 attempts left", bad.status === 401 && /4 attempts left/.test(bad.data.error), bad.data.error);
  const good = await call("/api/backoffice/auth/2fa/sms/verify", { tempToken: sms.data.tempToken, code });
  ok("right code -> session cookie", good.status === 200 && good.data.id === idOwner && /bo_session=/.test(good.setCookie));
  ok("code consumed", (await codes(idOwner, "bo_login")).every((c) => c.consumed_at));
  const again = await call("/api/backoffice/auth/2fa/sms/verify", { tempToken: sms.data.tempToken, code });
  ok("same code again -> 401", again.status === 401);
  const { rows: ot } = await pool.query("SELECT totp_enabled, totp_secret FROM staff WHERE id = $1", [idOwner]);
  ok("TOTP untouched by SMS login", ot[0].totp_enabled === true && ot[0].totp_secret === ownerSecret);

  console.log("Authenticator still works for the same owner:");
  const s1b = await step1(emails[0]);
  const t = await call("/api/backoffice/auth/2fa/choose", { tempToken: s1b.data.tempToken, method: "totp" });
  ok("choose totp -> 2fa", t.status === 200 && t.data.stage === "2fa");
  const t2 = await call("/api/backoffice/auth/login-step2", { tempToken: t.data.tempToken, totpCode: await otplib.generate({ secret: ownerSecret }) });
  ok("login-step2 with authenticator -> session", t2.status === 200 && /bo_session=/.test(t2.setCookie), JSON.stringify(t2.data));

  console.log("First-time setup can finish by SMS:");
  const ss = await call("/api/backoffice/auth/setup-start", { pin: setupPin });
  ok("setup-start", ss.status === 200 && ss.data.tempToken);
  const sc = await call("/api/backoffice/auth/setup-complete", { tempToken: ss.data.tempToken, email: emails[2], password: PASSWORD });
  ok("setup-complete -> 2fa_choice, totp: setup", sc.status === 200 && sc.data.stage === "2fa_choice" && sc.data.totp === "setup", JSON.stringify(sc.data));
  const n = twilioCalls.length;
  const scs = await call("/api/backoffice/auth/2fa/choose", { tempToken: sc.data.tempToken, method: "sms" });
  await settle(() => twilioCalls.length > n);
  const sv = await call("/api/backoffice/auth/2fa/sms/verify", { tempToken: scs.data.tempToken, code: lastCode() });
  ok("SMS finishes setup -> session", sv.status === 200 && /bo_session=/.test(sv.setCookie));
  const { rows: st } = await pool.query("SELECT totp_enabled, password_hash IS NOT NULL AS has_pw FROM staff WHERE id = $1", [idSetup]);
  ok("password saved, authenticator not forced", st[0].has_pw && st[0].totp_enabled === false);
  const s1c = await step1(emails[2]);
  ok("next login offers the choice again", s1c.data.stage === "2fa_choice" && s1c.data.totp === "setup");
  const ts = await call("/api/backoffice/auth/2fa/choose", { tempToken: s1c.data.tempToken, method: "totp" });
  ok("can still pick authenticator -> QR setup", ts.status === 200 && ts.data.stage === "2fa_setup" && ts.data.qrCodeDataUrl);

  console.log("Forgot password by SMS:");
  const generic = await call("/api/backoffice/auth/forgot-password-sms", { email: "nobody@test.invalid" });
  for (const [label, email, id] of [["cashier", emails[3], idCashier], ["no phone", emails[1], idNoPhone]]) {
    const before = twilioCalls.length;
    const r = await call("/api/backoffice/auth/forgot-password-sms", { email });
    await new Promise((res) => setTimeout(res, 150));
    ok(`${label}: identical reply, no row, no SMS`,
      r.status === 200 && JSON.stringify(r.data) === JSON.stringify(generic.data) &&
      (await codes(id, "bo_reset")).length === 0 && twilioCalls.length === before);
  }
  const cashierReset = await call("/api/backoffice/auth/reset-password-sms", { email: emails[3], code: "123456", newPassword: "another long password" });
  ok("cashier reset attempt -> 401 decoy, password unchanged",
    cashierReset.status === 401 && /attempts left/.test(cashierReset.data.error) &&
    (await pool.query("SELECT password_hash FROM staff WHERE id = $1", [idCashier])).rows[0].password_hash === pwHash);

  const before = twilioCalls.length;
  const fr = await call("/api/backoffice/auth/forgot-password-sms", { email: emails[0].toUpperCase() });
  await settle(() => twilioCalls.length > before);
  ok("owner: same reply, bo_reset code texted", JSON.stringify(fr.data) === JSON.stringify(generic.data) &&
    twilioCalls.length === before + 1 && (await codes(idOwner, "bo_reset")).length === 1);
  const rcode = lastCode();
  const weak = await call("/api/backoffice/auth/reset-password-sms", { email: emails[0], code: rcode, newPassword: "short" });
  ok("weak password -> 400, code not burned", weak.status === 400 && (await codes(idOwner, "bo_reset"))[0].attempts === 0);
  const NEWPW = "a brand new password";
  const rr = await call("/api/backoffice/auth/reset-password-sms", { email: emails[0], code: rcode, newPassword: NEWPW });
  ok("reset -> 200", rr.status === 200, JSON.stringify(rr.data));
  ok("old password fails", (await step1(emails[0])).status === 401);
  ok("new password works, still asks for a second factor", (await step1(emails[0], NEWPW)).data.stage === "2fa_choice");
  ok("reset code consumed", (await codes(idOwner, "bo_reset")).every((c) => c.consumed_at));

  console.log("Phone on a Back Office account is protected:");
  const admin2Cookie = `bo_session=${jwt.sign({ staffId: idAdmin2, purpose: "session" }, process.env.SESSION_SECRET)}`;
  const hijack = await call(`/api/backoffice/staff/${idSetup}`, { phone: "416-555-0199" }, { method: "PUT", cookie: admin2Cookie });
  ok("another admin can't change it -> 403", hijack.status === 403, JSON.stringify(hijack.data));
  const self = await call(`/api/backoffice/staff/${idAdmin2}`, { phone: "416-555-0198" }, { method: "PUT", cookie: admin2Cookie });
  ok("own phone -> 200", self.status === 200 && self.data.phone === "+14165550198", JSON.stringify(self.data));

  ok("Twilio only ever stubbed; no other network", otherExternal === 0);
  ok("never sent from the customer number", twilioCalls.every((c) => c.From === "+15550000002"));
} finally {
  await pool.query("DELETE FROM staff WHERE id = ANY($1::uuid[])", [created]); // cascades staff_auth_codes
  server.close();
  await pool.end();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
