// Online pickup SMS Slice 2 — "placed" helper acceptance tests.
//
// notifyOnlineOrderPlaced() is exercised against a fake pool (records every
// query, simulates the UNIQUE (order_id, event) claim) and a stubbed global
// fetch, so no database, no Twilio account and no network are needed.
//
// Run from the repo root: node tests/online_sms_acceptance.mjs

import sms from "../backend/lib/onlineSms.js";

const { notifyOnlineOrder, notifyOnlineOrderPlaced, SMS_COPY } = sms;

let failures = 0;
function ok(label, condition, detail = "") {
  console.log(`  ${condition ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

/** Fake pg pool: order_notifications only, with the unique claim enforced. */
function fakePool({ failAll = false } = {}) {
  const rows = new Map(); // id -> row
  const queries = [];
  let nextId = 1;
  return {
    rows,
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (failAll) throw new Error("db down");
      if (sql.startsWith("INSERT INTO order_notifications")) {
        const [orderId, event, toPhone, status, error] = params;
        for (const r of rows.values()) {
          if (r.orderId === orderId && r.event === event) return { rows: [] }; // ON CONFLICT DO NOTHING
        }
        const id = nextId++;
        rows.set(id, { id, orderId, event, toPhone, status, error, providerSid: null });
        return { rows: [{ id }] };
      }
      if (sql.startsWith("UPDATE order_notifications SET status = 'sent'")) {
        Object.assign(rows.get(params[0]), { status: "sent", providerSid: params[1] });
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE order_notifications SET status = 'failed'")) {
        Object.assign(rows.get(params[0]), { status: "failed", error: params[1] });
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

const fetchCalls = [];
function stubFetch(impl) {
  fetchCalls.length = 0;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return impl(url, init);
  };
}
const twilioCreated = () => ({ status: 201, json: async () => ({ sid: "SMfake123" }) });

const ENV_KEYS = ["ONLINE_SMS_ENABLED", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"];
function setEnv(values) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
}
const CONFIGURED = {
  ONLINE_SMS_ENABLED: "true",
  TWILIO_ACCOUNT_SID: "ACfake",
  TWILIO_AUTH_TOKEN: "fake-token",
  TWILIO_FROM_NUMBER: "+15005550006",
};
const ORDER = { orderId: "order-1", orderNumber: 42, customerPhone: "(416) 555-1234" };

// Quiet the helper's own logging so the PASS/FAIL list stays readable.
console.warn = () => {};
const realError = console.error;
console.error = () => {};
const realLog = console.log;
const logLines = [];
const captureLog = () => { console.log = (...a) => logLines.push(a.join(" ")); };
const restoreLog = () => { console.log = realLog; };

console.log("Copy:");
ok("placed copy", SMS_COPY.placed(42) === "Narcos Tacos: order #42 received. Pickup at 2072 Lawrence Ave E.");
ok("started copy", SMS_COPY.started(42) === "Narcos Tacos: we started order #42.");
ok("ready copy", SMS_COPY.ready(42) === "Narcos Tacos: order #42 is ready for pickup at 2072 Lawrence Ave E.");
ok("no copy says 'grill'", Object.values(SMS_COPY).every((fn) => !/grill/i.test(fn(1))));

console.log("Flag off:");
for (const flag of [undefined, "false", "TRUE", "1"]) {
  setEnv({ ...CONFIGURED, ONLINE_SMS_ENABLED: flag });
  if (flag === undefined) delete process.env.ONLINE_SMS_ENABLED;
  const pool = fakePool();
  stubFetch(twilioCreated);
  await notifyOnlineOrderPlaced(pool, ORDER);
  ok(`ONLINE_SMS_ENABLED=${flag} -> no row, no send`, pool.queries.length === 0 && fetchCalls.length === 0);
}

console.log("Invalid phone:");
{
  setEnv(CONFIGURED);
  const pool = fakePool();
  stubFetch(twilioCreated);
  await notifyOnlineOrderPlaced(pool, { ...ORDER, customerPhone: "call me" });
  const [row] = pool.rows.values();
  ok("skipped row with invalid_phone", row?.status === "skipped" && row?.error === "invalid_phone");
  ok("raw phone recorded", row?.toPhone === "call me");
  ok("no send", fetchCalls.length === 0);
}

console.log("Twilio not configured:");
{
  setEnv({ ONLINE_SMS_ENABLED: "true" });
  const pool = fakePool();
  stubFetch(twilioCreated);
  await notifyOnlineOrderPlaced(pool, ORDER);
  const [row] = pool.rows.values();
  ok("skipped row with twilio_not_configured", row?.status === "skipped" && row?.error === "twilio_not_configured");
  ok("no send", fetchCalls.length === 0);
}

console.log("Happy path:");
{
  setEnv(CONFIGURED);
  const pool = fakePool();
  stubFetch(twilioCreated);
  captureLog();
  await notifyOnlineOrderPlaced(pool, ORDER);
  restoreLog();
  const [row] = pool.rows.values();
  ok("row sent with provider_sid", row?.status === "sent" && row?.providerSid === "SMfake123");
  ok("to_phone normalized", row?.toPhone === "+14165551234");
  ok("one Twilio call", fetchCalls.length === 1);
  const call = fetchCalls[0];
  ok("Messages.json URL", call?.url === "https://api.twilio.com/2010-04-01/Accounts/ACfake/Messages.json");
  ok(
    "basic auth header",
    call?.init.headers.Authorization === `Basic ${Buffer.from("ACfake:fake-token").toString("base64")}`
  );
  const form = new URLSearchParams(call?.init.body);
  ok("To / From / Body", form.get("To") === "+14165551234" && form.get("From") === "+15005550006" && form.get("Body") === SMS_COPY.placed(42));
  ok("log has no token or phone", logLines.every((l) => !l.includes("fake-token") && !l.includes("555")));

  // Second call for the same order: the unique claim blocks it.
  await notifyOnlineOrderPlaced(pool, ORDER);
  ok("second call does not send again", fetchCalls.length === 1 && pool.rows.size === 1);
}

console.log("Twilio rejects:");
{
  setEnv(CONFIGURED);
  const pool = fakePool();
  stubFetch(() => ({ status: 400, json: async () => ({ code: 21211, message: "Invalid 'To' +14165551234" }) }));
  await notifyOnlineOrderPlaced(pool, ORDER);
  const [row] = pool.rows.values();
  ok("row failed", row?.status === "failed");
  ok("short error, no phone echoed", row?.error === "twilio_http_400_code_21211");
}

console.log("Twilio timeout / network:");
{
  setEnv(CONFIGURED);
  const pool = fakePool();
  stubFetch(() => { const e = new Error("t"); e.name = "TimeoutError"; throw e; });
  await notifyOnlineOrderPlaced(pool, ORDER);
  ok("timeout -> failed twilio_timeout", [...pool.rows.values()][0]?.error === "twilio_timeout");

  const pool2 = fakePool();
  stubFetch(() => { throw new TypeError("fetch failed"); });
  await notifyOnlineOrderPlaced(pool2, ORDER);
  ok("network -> failed twilio_network_error", [...pool2.rows.values()][0]?.error === "twilio_network_error");
}

console.log("Started / ready (KDS forward taps):");
{
  setEnv(CONFIGURED);
  const pool = fakePool();
  stubFetch(twilioCreated);
  await notifyOnlineOrderPlaced(pool, ORDER);
  await notifyOnlineOrder(pool, "started", ORDER);
  ok("started sent with started copy", new URLSearchParams(fetchCalls[1]?.init.body).get("Body") === SMS_COPY.started(42));
  await notifyOnlineOrder(pool, "ready", ORDER);
  ok("ready sent with ready copy", new URLSearchParams(fetchCalls[2]?.init.body).get("Body") === SMS_COPY.ready(42));
  const events = [...pool.rows.values()].map((r) => `${r.event}:${r.status}`).sort();
  ok("one row per event, all sent", events.join(",") === "placed:sent,ready:sent,started:sent", events.join(","));

  // Revert-then-forward: the route calls again for the same event.
  await notifyOnlineOrder(pool, "started", ORDER);
  await notifyOnlineOrder(pool, "ready", ORDER);
  ok("second started / ready do not send", fetchCalls.length === 3 && pool.rows.size === 3);
}
{
  setEnv({ ...CONFIGURED, ONLINE_SMS_ENABLED: "false" });
  const pool = fakePool();
  stubFetch(twilioCreated);
  await notifyOnlineOrder(pool, "ready", ORDER);
  ok("ready with flag off -> no row, no send", pool.queries.length === 0 && fetchCalls.length === 0);
}
{
  setEnv(CONFIGURED);
  const pool = fakePool();
  stubFetch(twilioCreated);
  await notifyOnlineOrder(pool, "completed", ORDER);
  ok("unknown event -> no row, no send", pool.queries.length === 0 && fetchCalls.length === 0);
}

console.log("Database down:");
{
  setEnv(CONFIGURED);
  const pool = fakePool({ failAll: true });
  stubFetch(twilioCreated);
  let threw = false;
  try {
    await notifyOnlineOrderPlaced(pool, ORDER);
  } catch {
    threw = true;
  }
  ok("never throws", !threw);
  ok("no send without a claim", fetchCalls.length === 0);
}

console.error = realError;
console.log(failures === 0 ? "\nAll online SMS tests passed." : `\n${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
