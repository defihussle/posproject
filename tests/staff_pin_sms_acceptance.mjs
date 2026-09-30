// Staff SMS auth P3 Slice 2 — Order Entry PIN setup / Forgot PIN acceptance.
//
// Runs the real Express app in-process against the LOCAL Docker database
// (DATABASE_URL forced below) and deletes every row it creates. Twilio is
// never reached: global fetch is stubbed, and the stub records each Twilio
// request so the test can read the code out of the message body.
//
// ONLINE_SMS_ENABLED / TWILIO_FROM_NUMBER are set to sentinels to prove the
// staff path never uses them.
//
// Needs database/staff_sms_auth.sql applied locally.
// Run from the repo root: node tests/staff_pin_sms_acceptance.mjs

process.env.DATABASE_URL = "postgresql://narcos:narcos_dev@localhost:5432/narcos_tacos";
process.env.SESSION_SECRET = "test-session-secret";
process.env.DEVICE_SECRET = "test-device-secret";
process.env.STAFF_SMS_ENABLED = "";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_STAFF_FROM_NUMBER = "+15550000002";
process.env.TWILIO_FROM_NUMBER = "+15550000001"; // customer sender — must never be used here
process.env.ONLINE_SMS_ENABLED = "true"; // must not turn staff sends on

import { createRequire } from "module";

const requireBackend = createRequire(new URL("../backend/package.json", import.meta.url));
const jwt = requireBackend("jsonwebtoken");
const bcrypt = requireBackend("bcryptjs");

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
let deviceRowId = null;

async function freePin() {
  const { rows } = await pool.query("SELECT pin_hash FROM staff WHERE active = true AND pin_hash IS NOT NULL");
  for (;;) {
    const pin = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    let taken = false;
    for (const r of rows) if (await bcrypt.compare(pin, r.pin_hash)) { taken = true; break; }
    if (!taken) return pin;
  }
}

async function addStaff(name, role, phone, { pin = null, active = true } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO staff (name, title, role, hourly_rate, phone, pin_hash, active)
     VALUES ($1, $2, $3, 18, $4, $5, $6) RETURNING id`,
    [name, role, role, phone, pin ? await bcrypt.hash(pin, 10) : null, active]
  );
  created.push(rows[0].id);
  return rows[0].id;
}

// 555-01xx is reserved for fiction; bail if any are already on staff.
const P = (n) => `+1416555${String(n).padStart(4, "0")}`;
const phones = [P(111), P(112), P(113), P(114), P(115), P(116), P(117)];
const { rows: clash } = await pool.query("SELECT 1 FROM staff WHERE phone = ANY($1)", [phones]);
if (clash.length) {
  console.error("Test phones already exist in staff — aborting.");
  process.exit(2);
}

const oldPinB = await freePin();
const idA = await addStaff("Slice2 NoPin", "cashier", P(111));
const idB = await addStaff("Slice2 HasPin", "cashier", P(112), { pin: oldPinB });
const idK = await addStaff("Slice2 Kitchen", "kitchen", P(113));
const idL = await addStaff("Slice2 Line", "line", P(114));
const idI = await addStaff("Slice2 Inactive", "cashier", P(115), { active: false });
const idO = await addStaff("Slice2 Owner", "owner", P(117), { pin: await freePin() });
// P(116) belongs to nobody.

const { rows: devRows } = await pool.query(
  `INSERT INTO device_pairings (device_name, pairing_code_hash, code_expires_at, paired_at, created_by)
   VALUES ('slice2-test', 'x', now(), now(), $1) RETURNING id, device_id`,
  [idB]
);
deviceRowId = devRows[0].id;
const device = `device_token=${jwt.sign({ deviceId: devRows[0].device_id, purpose: "device" }, process.env.DEVICE_SECRET)}`;

async function call(path, body, cookie = device) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const codes = (staffId) =>
  pool.query("SELECT * FROM staff_auth_codes WHERE staff_id = $1 ORDER BY created_at", [staffId]).then((r) => r.rows);
// The send happens after the reply; wait for it to land.
async function settle(check) {
  for (let i = 0; i < 40; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
// Lift the 60s resend gap for a phone without waiting a minute.
const backdate = (staffId) =>
  pool.query("UPDATE staff_auth_codes SET created_at = created_at - interval '2 minutes' WHERE staff_id = $1", [staffId]);
async function sendAndGetCode(staffId, phone) {
  const before = twilioCalls.length;
  const r = await call("/api/auth/pin-code/send", { phone });
  await settle(() => twilioCalls.length > before);
  const msg = twilioCalls[twilioCalls.length - 1];
  return { r, code: twilioCalls.length > before ? /(\d{6})/.exec(msg.Body)[1] : null };
}

try {
  console.log("Device gate:");
  const noDevice = await call("/api/auth/pin-code/send", { phone: P(111) }, "");
  ok("send without paired device -> 401", noDevice.status === 401);

  console.log("Flag off:");
  const off = await call("/api/auth/pin-code/send", { phone: "(416) 555-0111" });
  ok("generic 200", off.status === 200 && /If that number is on file/.test(off.data.message), JSON.stringify(off.data));
  let rowsA = await codes(idA);
  ok("pin_setup row written", rowsA.length === 1 && rowsA[0].purpose === "pin_setup");
  ok("code stored hashed, not raw", rowsA[0] && /^[0-9a-f]{64}$/.test(rowsA[0].code_hash));
  ok("unsent code retired (skipped)", await settle(async () => (await codes(idA))[0].consumed_at !== null));
  ok("no Twilio call", twilioCalls.length === 0);

  process.env.STAFF_SMS_ENABLED = "true";
  await backdate(idA);

  console.log("Flag on, no PIN -> setup:");
  let { r, code } = await sendAndGetCode(idA, "416-555-0111");
  ok("generic 200", r.status === 200 && JSON.stringify(r.data) === JSON.stringify(off.data));
  const sms = twilioCalls[0] || {};
  ok("sent from TWILIO_STAFF_FROM_NUMBER", sms.From === "+15550000002", sms.From);
  ok("sent to the saved phone", sms.To === P(111));
  ok("copy", /^Narcos staff code: \d{6}\. Expires in 10 min\.$/.test(sms.Body || ""), sms.Body);
  rowsA = await codes(idA);
  const liveA = rowsA.filter((c) => !c.consumed_at);
  ok("one live pin_setup row, 5 attempts, ~10 min", liveA.length === 1 && liveA[0].purpose === "pin_setup" &&
    liveA[0].max_attempts === 5 && Math.abs(new Date(liveA[0].expires_at) - new Date(liveA[0].created_at) - 600000) < 5000);

  console.log("Resend throttle:");
  const callsBefore = twilioCalls.length;
  const again = await call("/api/auth/pin-code/send", { phone: P(111) });
  await new Promise((res) => setTimeout(res, 300));
  ok("second send inside 60s: same reply, no row, no SMS",
    again.status === 200 && (await codes(idA)).length === rowsA.length && twilioCalls.length === callsBefore);

  console.log("No-op numbers get the same reply and nothing is sent:");
  for (const [label, phone, id] of [["kitchen", P(113), idK], ["line", P(114), idL], ["inactive", P(115), idI], ["unknown", P(116), null]]) {
    const n = twilioCalls.length;
    const x = await call("/api/auth/pin-code/send", { phone });
    await new Promise((res) => setTimeout(res, 150));
    const rows = id ? await codes(id) : [];
    ok(`${label}: identical reply, no row, no SMS`,
      x.status === 200 && JSON.stringify(x.data) === JSON.stringify(off.data) && rows.length === 0 && twilioCalls.length === n);
  }
  const bad = await call("/api/auth/pin-code/send", { phone: "123" });
  ok("malformed phone -> 400", bad.status === 400);

  console.log("Wrong codes lock the code:");
  const wrong = code === "000000" ? "111111" : "000000";
  const w1 = await call("/api/auth/pin-code/verify", { phone: P(111), code: wrong });
  ok("wrong -> 401, 4 attempts left", w1.status === 401 && /4 attempts left/.test(w1.data.error), w1.data.error);
  ok("attempts = 1 in table", (await codes(idA)).find((c) => !c.consumed_at).attempts === 1);
  let last;
  for (let i = 0; i < 4; i++) last = await call("/api/auth/pin-code/verify", { phone: P(111), code: wrong });
  ok("5th wrong -> locked", last.status === 401 && /Too many attempts/.test(last.data.error), last.data.error);
  const afterLock = await call("/api/auth/pin-code/verify", { phone: P(111), code });
  ok("right code after lock still refused", afterLock.status === 401 && !afterLock.data.token);
  ok("attempts capped at 5", (await codes(idA)).find((c) => !c.consumed_at).attempts === 5);

  console.log("Decoy for a number with no code looks the same:");
  const decoy = await call("/api/auth/pin-code/verify", { phone: P(116), code: "123456" });
  ok("unknown number -> 401, 4 attempts left", decoy.status === 401 && /4 attempts left/.test(decoy.data.error), decoy.data.error);

  console.log("Setup completes:");
  await backdate(idA);
  ({ code } = await sendAndGetCode(idA, P(111)));
  const v = await call("/api/auth/pin-code/verify", { phone: P(111), code });
  ok("right code -> token, purpose pin_setup", v.status === 200 && v.data.token && v.data.purpose === "pin_setup", JSON.stringify(v.data));
  const newPinA = await freePin();
  const mismatch = await call("/api/auth/pin-code/complete", { token: v.data.token, pin: "12" });
  ok("bad PIN -> 400, code not burned", mismatch.status === 400);
  const done = await call("/api/auth/pin-code/complete", { token: v.data.token, pin: newPinA });
  ok("complete -> 200", done.status === 200 && done.data.success, JSON.stringify(done.data));
  const { rows: a } = await pool.query("SELECT pin_hash FROM staff WHERE id = $1", [idA]);
  ok("pin_hash set", a[0].pin_hash && (await bcrypt.compare(newPinA, a[0].pin_hash)));
  ok("code consumed", (await codes(idA)).every((c) => c.consumed_at));
  const loginA = await call("/api/auth/login", { pin: newPinA });
  ok("new PIN logs in", loginA.status === 200 && loginA.data.staff?.id === idA);
  const replay = await call("/api/auth/pin-code/complete", { token: v.data.token, pin: await freePin() });
  ok("token replay -> 401", replay.status === 401);

  console.log("Expired code:");
  ({ code } = await sendAndGetCode(idB, P(112)));
  ok("existing PIN -> pin_reset row", (await codes(idB)).at(-1).purpose === "pin_reset");
  await pool.query("UPDATE staff_auth_codes SET expires_at = now() - interval '1 second' WHERE staff_id = $1", [idB]);
  const exp = await call("/api/auth/pin-code/verify", { phone: P(112), code });
  ok("expired -> 401, no token", exp.status === 401 && !exp.data.token);

  console.log("Reset completes:");
  await backdate(idB);
  ({ code } = await sendAndGetCode(idB, P(112)));
  const vb = await call("/api/auth/pin-code/verify", { phone: P(112), code });
  ok("purpose pin_reset", vb.status === 200 && vb.data.purpose === "pin_reset");
  const newPinB = await freePin();
  const db = await call("/api/auth/pin-code/complete", { token: vb.data.token, pin: newPinB });
  ok("complete -> 200", db.status === 200);
  ok("old PIN fails", (await call("/api/auth/login", { pin: oldPinB })).status === 401);
  ok("new PIN logs in", (await call("/api/auth/login", { pin: newPinB })).data.staff?.id === idB);
  ok("code consumed", (await codes(idB)).every((c) => c.consumed_at));

  console.log("Owner can reset too:");
  ({ code } = await sendAndGetCode(idO, P(117)));
  const vo = await call("/api/auth/pin-code/verify", { phone: P(117), code });
  ok("owner -> pin_reset token", vo.status === 200 && vo.data.purpose === "pin_reset");

  ok("Twilio only ever stubbed; no other network", otherExternal === 0);
  ok("never sent from the customer number", twilioCalls.every((c) => c.From === "+15550000002"));
} finally {
  if (deviceRowId) await pool.query("DELETE FROM device_pairings WHERE id = $1", [deviceRowId]);
  await pool.query("DELETE FROM staff WHERE id = ANY($1::uuid[])", [created]); // cascades staff_auth_codes
  server.close();
  await pool.end();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
