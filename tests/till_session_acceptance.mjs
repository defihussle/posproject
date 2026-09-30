// P3 Slice 4 — POS staff-admin routes take the actor from the till session,
// not from a staffId in the body/query.
//
// Covers POST /api/staff/quick-add, POST /api/staff/:id/reset-pin,
// PATCH /api/staff/:id/status, GET /api/staff/roster and DELETE /api/staff/:id:
//   - unpaired device -> 401
//   - paired, no till session, owner UUID in the body -> 401
//   - forged / other-device till session -> 401
//   - real owner / manager / cashier sessions from a real PIN login
//
// Runs the real Express app in-process against the LOCAL Docker database
// (DATABASE_URL forced below) and deletes every row it creates.
//
// Run from the repo root: node tests/till_session_acceptance.mjs

process.env.DATABASE_URL = "postgresql://narcos:narcos_dev@localhost:5432/narcos_tacos";
process.env.SESSION_SECRET = "test-session-secret";
process.env.DEVICE_SECRET = "test-device-secret";
process.env.STAFF_SMS_ENABLED = "";

import { createRequire } from "module";

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
const created = [];
const devices = [];

async function freePin() {
  const { rows } = await pool.query("SELECT pin_hash FROM staff WHERE active = true AND pin_hash IS NOT NULL");
  for (;;) {
    const pin = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    let taken = false;
    for (const r of rows) if (await bcrypt.compare(pin, r.pin_hash)) { taken = true; break; }
    if (!taken) return pin;
  }
}
async function addStaff(name, role) {
  const pin = await freePin();
  const { rows } = await pool.query(
    `INSERT INTO staff (name, title, role, hourly_rate, pin_hash, active)
     VALUES ($1, $2, $3, 18, $4, true) RETURNING id`,
    [name, role, role, await bcrypt.hash(pin, 10)]
  );
  created.push(rows[0].id);
  return { id: rows[0].id, pin };
}
async function addDevice(creatorId) {
  const { rows } = await pool.query(
    `INSERT INTO device_pairings (device_name, pairing_code_hash, code_expires_at, paired_at, created_by)
     VALUES ('slice4-test', 'x', now(), now(), $1) RETURNING id, device_id`,
    [creatorId]
  );
  devices.push(rows[0].id);
  return {
    deviceId: rows[0].device_id,
    cookie: `device_token=${jwt.sign({ deviceId: rows[0].device_id, purpose: "device" }, process.env.DEVICE_SECRET)}`,
  };
}

async function call(method, path, body, cookie = "") {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (method === "POST" && path === "/api/staff/quick-add" && res.status === 201) created.push(data.id);
  return { status: res.status, data, setCookie: res.headers.get("set-cookie") || "" };
}

// Real PIN login on a device; returns the cookie header for later calls.
async function loginOn(device, pin) {
  const r = await call("POST", "/api/auth/login", { pin }, device.cookie);
  const till = /till_session=([^;]+)/.exec(r.setCookie)?.[1];
  return { ok: r.status === 200 && !!till, cookie: `${device.cookie}; till_session=${till}` };
}

const owner = await addStaff("Slice4 Owner", "owner");
const manager = await addStaff("Slice4 Manager", "manager");
const cashier = await addStaff("Slice4 Cashier", "cashier");
const target = await addStaff("Slice4 Target", "cashier");
const devA = await addDevice(owner.id);
const devB = await addDevice(owner.id);

const qaBody = async (extra = {}) => ({ name: "Slice4 QA", role: "cashier", hourly_rate: 17, pin: await freePin(), ...extra });
const routes = async () => [
  ["POST", "/api/staff/quick-add", await qaBody({ staffId: owner.id })],
  ["POST", `/api/staff/${target.id}/reset-pin`, { staffId: owner.id, pin: await freePin() }],
  ["PATCH", `/api/staff/${target.id}/status`, { staffId: owner.id, active: false }],
  ["GET", `/api/staff/roster?staffId=${owner.id}`, undefined],
  ["DELETE", `/api/staff/${target.id}?staffId=${owner.id}`, undefined],
];

try {
  console.log("Unpaired device, owner UUID in body/query:");
  for (const [m, p, b] of await routes()) {
    const r = await call(m, p, b);
    ok(`${m} ${p.split("?")[0]} -> 401`, r.status === 401, `${r.status}`);
  }

  console.log("Paired, no till session, owner UUID in body/query:");
  for (const [m, p, b] of await routes()) {
    const r = await call(m, p, b, devA.cookie);
    ok(`${m} ${p.split("?")[0]} -> 401`, r.status === 401, `${r.status}`);
  }

  console.log("Forged or wrong-device till sessions:");
  const forged = jwt.sign({ staffId: owner.id, deviceId: devA.deviceId, purpose: "till" }, "not-the-secret");
  const f = await call("POST", "/api/staff/quick-add", await qaBody(), `${devA.cookie}; till_session=${forged}`);
  ok("wrong signature -> 401", f.status === 401);
  const other = jwt.sign({ staffId: owner.id, deviceId: devB.deviceId, purpose: "till" }, process.env.SESSION_SECRET);
  const w = await call("POST", "/api/staff/quick-add", await qaBody(), `${devA.cookie}; till_session=${other}`);
  ok("session from another device -> 401", w.status === 401);
  const bo = jwt.sign({ staffId: owner.id, purpose: "session" }, process.env.SESSION_SECRET);
  const b = await call("POST", "/api/staff/quick-add", await qaBody(), `${devA.cookie}; till_session=${bo}`);
  ok("Back Office token in the till cookie -> 401", b.status === 401);

  console.log("Owner logged into the till:");
  const o = await loginOn(devA, owner.pin);
  ok("PIN login sets an httpOnly till_session", o.ok);
  const qa = await call("POST", "/api/staff/quick-add", await qaBody({ phone: "416-555-0141" }), o.cookie);
  ok("quick-add -> 201", qa.status === 201, JSON.stringify(qa.data));
  ok("quick-add still drops phone", qa.data.phone === null);
  const qaNoPin = await call("POST", "/api/staff/quick-add", { name: "Slice4 NoPin", role: "cashier", hourly_rate: 17 }, o.cookie);
  ok("quick-add still requires a PIN", qaNoPin.status === 400);
  ok("roster -> 200", (await call("GET", "/api/staff/roster", undefined, o.cookie)).status === 200);
  ok("reset-pin -> 200", (await call("POST", `/api/staff/${target.id}/reset-pin`, { pin: await freePin() }, o.cookie)).status === 200);
  ok("status -> 200", (await call("PATCH", `/api/staff/${target.id}/status`, { active: true }, o.cookie)).status === 200);
  const onB = await call("GET", "/api/staff/roster", undefined, `${devB.cookie}; till_session=${/till_session=([^;]+)/.exec(o.cookie)[1]}`);
  ok("owner's till cookie replayed on another paired device -> 401", onB.status === 401);

  console.log("Manager logged in:");
  const mg = await loginOn(devA, manager.pin);
  ok("quick-add -> 201", (await call("POST", "/api/staff/quick-add", await qaBody(), mg.cookie)).status === 201);
  ok("reset-pin -> 403 (owner/admin only, as before)",
    (await call("POST", `/api/staff/${target.id}/reset-pin`, { pin: await freePin() }, mg.cookie)).status === 403);

  console.log("Cashier logged in, owner UUID in the body:");
  const cs = await loginOn(devA, cashier.pin);
  ok("quick-add -> 403", (await call("POST", "/api/staff/quick-add", await qaBody({ staffId: owner.id }), cs.cookie)).status === 403);
  ok("reset-pin -> 403",
    (await call("POST", `/api/staff/${target.id}/reset-pin`, { staffId: owner.id, pin: await freePin() }, cs.cookie)).status === 403);
  ok("status -> 403", (await call("PATCH", `/api/staff/${target.id}/status`, { staffId: owner.id, active: false }, cs.cookie)).status === 403);
  ok("delete -> 403", (await call("DELETE", `/api/staff/${target.id}?staffId=${owner.id}`, undefined, cs.cookie)).status === 403);

  console.log("Session ends:");
  const lo = await call("POST", "/api/auth/logout", undefined, o.cookie);
  ok("logout clears till_session", lo.status === 200 && /till_session=;/.test(lo.setCookie), lo.setCookie);
  await pool.query("UPDATE staff SET active = false WHERE id = $1", [owner.id]);
  ok("deactivated owner's session -> 401", (await call("GET", "/api/staff/roster", undefined, o.cookie)).status === 401);

  ok("no external calls", externalCalls === 0);
} finally {
  await pool.query("DELETE FROM device_pairings WHERE id = ANY($1::uuid[])", [devices]);
  await pool.query("DELETE FROM staff WHERE id = ANY($1::uuid[])", [created]);
  server.close();
  await pool.end();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
