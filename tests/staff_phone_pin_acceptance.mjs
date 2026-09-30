// Staff SMS auth P3 Slice 1 — phone + optional PIN acceptance tests.
//
// Covers database/staff_sms_auth.sql plus the Back Office staff routes:
//   1. create without a PIN (pin_hash NULL, has_pin false)
//   2. create with a PIN still works, and that PIN logs in
//   3. phone stored E.164, unique across formats, blank -> NULL (no collision)
//   4. PIN login / setup-start / PIN uniqueness ignore NULL pin_hash rows
//   5. PUT sets/changes phone and PIN
//   6. POST /api/staff/quick-add never writes a phone and still needs a PIN
//
// Runs the real Express app in-process against the LOCAL Docker database
// (DATABASE_URL is forced below, so backend/.env can't point it anywhere else)
// and cleans up every row it creates. Needs database/staff_sms_auth.sql applied
// locally. Never calls Twilio: global fetch is stubbed to fail loudly if
// anything tries to reach the network.
//
// Run from the repo root: node tests/staff_phone_pin_acceptance.mjs

process.env.DATABASE_URL = "postgresql://narcos:narcos_dev@localhost:5432/narcos_tacos";
process.env.SESSION_SECRET = "test-session-secret";
process.env.DEVICE_SECRET = "test-device-secret";

import { createRequire } from "module";

// Dependencies live in backend/node_modules, not at the repo root.
const requireBackend = createRequire(new URL("../backend/package.json", import.meta.url));
const jwt = requireBackend("jsonwebtoken");
const bcrypt = requireBackend("bcryptjs");

const realFetch = globalThis.fetch;
let externalCalls = 0;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, opts);
  externalCalls += 1;
  throw new Error(`unexpected external fetch: ${url}`);
};

const { app, pool } = await import("../backend/server.js");

let failures = 0;
function ok(label, condition, detail = "") {
  console.log(`  ${condition ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const createdStaff = [];
let deviceRowId = null;

// Admin requester, created directly (no PIN) so the test owns its fixture.
const { rows: adminRows } = await pool.query(
  `INSERT INTO staff (name, title, role, hourly_rate, active)
   VALUES ('Slice1 Test Admin', 'Admin', 'admin', 20, true) RETURNING id`
);
const adminId = adminRows[0].id;
createdStaff.push(adminId);

const boCookie = `bo_session=${jwt.sign({ staffId: adminId, purpose: "session" }, process.env.SESSION_SECRET)}`;

// A paired device for /api/auth/login.
const { rows: devRows } = await pool.query(
  `INSERT INTO device_pairings (device_name, pairing_code_hash, code_expires_at, paired_at, created_by)
   VALUES ('slice1-test', 'x', now(), now(), $1) RETURNING id, device_id`,
  [adminId]
);
deviceRowId = devRows[0].id;
const deviceCookie = `device_token=${jwt.sign({ deviceId: devRows[0].device_id, purpose: "device" }, process.env.DEVICE_SECRET)}`;

async function call(method, path, body, cookie = boCookie) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data?.id && !createdStaff.includes(data.id) && method === "POST") createdStaff.push(data.id);
  return { status: res.status, data };
}

// A PIN nobody active has, so the tests never collide with dev data.
async function freePin() {
  const { rows } = await pool.query("SELECT pin_hash FROM staff WHERE active = true AND pin_hash IS NOT NULL");
  for (;;) {
    const pin = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    let taken = false;
    for (const r of rows) if (await bcrypt.compare(pin, r.pin_hash)) { taken = true; break; }
    if (!taken) return pin;
  }
}

// 555-01xx is reserved for fiction; confirm the ones we use are free.
const PHONE_A = "(416) 555-0142";
const PHONE_A_E164 = "+14165550142";
const PHONE_B = "647-555-0177";
const PHONE_B_E164 = "+16475550177";
const { rows: clash } = await pool.query("SELECT 1 FROM staff WHERE phone = ANY($1)", [[PHONE_A_E164, PHONE_B_E164]]);
if (clash.length) {
  console.error("Test phones already exist in staff — aborting.");
  process.exit(2);
}

try {
  console.log("Create without PIN:");
  const noPin = await call("POST", "/api/backoffice/staff", {
    name: "Slice1 NoPin", role: "cashier", hourly_rate: 17.5, phone: PHONE_A,
  });
  ok("201", noPin.status === 201, JSON.stringify(noPin.data));
  ok("phone normalized to E.164", noPin.data.phone === PHONE_A_E164, noPin.data.phone);
  ok("has_pin false", noPin.data.has_pin === false);
  ok("pin_hash never returned", !("pin_hash" in noPin.data));
  const { rows: np } = await pool.query("SELECT pin_hash FROM staff WHERE id = $1", [noPin.data.id]);
  ok("pin_hash NULL in DB", np[0].pin_hash === null);

  console.log("Phone unique:");
  const dup = await call("POST", "/api/backoffice/staff", {
    name: "Slice1 Dup", role: "cashier", hourly_rate: 17.5, phone: "+1 416 555 0142",
  });
  ok("same number, other format -> 409", dup.status === 409, JSON.stringify(dup.data));

  console.log("Blank phone -> NULL:");
  const blank1 = await call("POST", "/api/backoffice/staff", { name: "Slice1 Blank1", role: "line", hourly_rate: 17.5, phone: "" });
  const blank2 = await call("POST", "/api/backoffice/staff", { name: "Slice1 Blank2", role: "line", hourly_rate: 17.5, phone: "   " });
  ok("'' -> null", blank1.status === 201 && blank1.data.phone === null, JSON.stringify(blank1.data));
  ok("'   ' -> null, no collision with other NULLs", blank2.status === 201 && blank2.data.phone === null);

  console.log("Invalid phone:");
  const bad = await call("POST", "/api/backoffice/staff", { name: "Slice1 Bad", role: "cashier", hourly_rate: 17.5, phone: "123" });
  ok("400", bad.status === 400, JSON.stringify(bad.data));

  console.log("Create with PIN:");
  const pin1 = await freePin();
  const withPin = await call("POST", "/api/backoffice/staff", {
    name: "Slice1 WithPin", role: "cashier", hourly_rate: 17.5, pin: pin1, phone: PHONE_B,
  });
  ok("201", withPin.status === 201, JSON.stringify(withPin.data));
  ok("has_pin true", withPin.data.has_pin === true);
  const badPin = await call("POST", "/api/backoffice/staff", { name: "Slice1 BadPin", role: "cashier", hourly_rate: 17.5, pin: "12" });
  ok("malformed PIN still 400", badPin.status === 400);
  const dupPin = await call("POST", "/api/backoffice/staff", { name: "Slice1 DupPin", role: "cashier", hourly_rate: 17.5, pin: pin1 });
  ok("duplicate PIN still 409 with NULL-PIN rows present", dupPin.status === 409, JSON.stringify(dupPin.data));

  console.log("PIN login with NULL pin_hash rows present:");
  const login = await call("POST", "/api/auth/login", { pin: pin1 }, deviceCookie);
  ok("created PIN logs in", login.status === 200 && login.data.staff?.id === withPin.data.id, JSON.stringify(login.data));
  const unknown = await call("POST", "/api/auth/login", { pin: await freePin() }, deviceCookie);
  ok("unknown PIN -> 401, not 500", unknown.status === 401, `${unknown.status}`);
  const setup = await call("POST", "/api/backoffice/auth/setup-start", { pin: await freePin() }, "");
  ok("setup-start unknown PIN -> 401, not 500", setup.status === 401, `${setup.status}`);

  console.log("PUT phone + PIN:");
  const taken = await call("PUT", `/api/backoffice/staff/${noPin.data.id}`, { phone: PHONE_B });
  ok("phone already used -> 409", taken.status === 409, JSON.stringify(taken.data));
  const same = await call("PUT", `/api/backoffice/staff/${noPin.data.id}`, { phone: "416.555.0142" });
  ok("unchanged phone alone -> 200 no-op", same.status === 200 && same.data.phone === PHONE_A_E164, JSON.stringify(same.data));
  const pin2 = await freePin();
  const setPin = await call("PUT", `/api/backoffice/staff/${noPin.data.id}`, { pin: pin2 });
  ok("PIN created on no-PIN row", setPin.status === 200 && setPin.data.has_pin === true, JSON.stringify(setPin.data));
  const login2 = await call("POST", "/api/auth/login", { pin: pin2 }, deviceCookie);
  ok("new PIN logs in", login2.status === 200 && login2.data.staff?.id === noPin.data.id);
  const clear = await call("PUT", `/api/backoffice/staff/${noPin.data.id}`, { phone: "", pin: "" });
  ok("blank phone clears it; blank PIN leaves PIN", clear.status === 200 && clear.data.phone === null && clear.data.has_pin === true, JSON.stringify(clear.data));

  console.log("quick-add stays PIN-required and phone-free:");
  const qaNoPin = await call("POST", "/api/staff/quick-add", { staffId: adminId, name: "Slice1 QA", role: "cashier", hourly_rate: 17.5, phone: "416-555-0199" }, "");
  ok("no PIN -> 400", qaNoPin.status === 400, JSON.stringify(qaNoPin.data));
  const qa = await call("POST", "/api/staff/quick-add", { staffId: adminId, name: "Slice1 QA", role: "cashier", hourly_rate: 17.5, pin: await freePin(), phone: "416-555-0199" }, "");
  ok("with PIN -> 201", qa.status === 201, JSON.stringify(qa.data));
  ok("phone NOT written", qa.data.phone === null, qa.data.phone);

  ok("no external (Twilio) calls", externalCalls === 0, `${externalCalls}`);
} finally {
  if (deviceRowId) await pool.query("DELETE FROM device_pairings WHERE id = $1", [deviceRowId]);
  await pool.query("DELETE FROM staff WHERE id = ANY($1::uuid[])", [createdStaff]);
  server.close();
  await pool.end();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
