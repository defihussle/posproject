// Customer SMS for online pickup orders
// (docs/architecture/online-pickup-sms-plan.md).
//
// The POS is the only thing that texts customers: never the website, never
// Flex / Cloud Pay Display. Every send is claimed first with a row in
// order_notifications (database/online_order_sms.sql), whose UNIQUE
// (order_id, event) is the double-text lock. There is no automatic retry in
// v1: a failed send stays 'failed'.
//
// Nothing here may break the caller. These functions run after the order has
// been paid for and committed, so every failure is caught, recorded where
// possible, logged by order number only, and swallowed.

const { normalizePhone } = require("./phone");

// One place for customer-facing copy, keyed by order_notifications.event.
const SMS_COPY = {
  placed: (orderNumber) =>
    `Narcos Tacos: order #${orderNumber} received. Pickup at 2072 Lawrence Ave E.`,
  started: (orderNumber) => `Narcos Tacos: we started order #${orderNumber}.`,
  ready: (orderNumber) =>
    `Narcos Tacos: order #${orderNumber} is ready for pickup at 2072 Lawrence Ave E.`,
};

// Long enough for a normal Twilio round trip, short enough that a hung call is
// marked failed rather than left queued.
const TWILIO_TIMEOUT_MS = 8000;

function smsEnabled() {
  return process.env.ONLINE_SMS_ENABLED === "true";
}

// TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are shared with the Back Office SMS
// 2FA plan; TWILIO_FROM_NUMBER is this workstream's own.
function twilioConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !from) return null;
  return { accountSid, authToken, from };
}

/** Claims (order, event). Returns the new row id, or null if already claimed. */
async function claimNotification(pool, { orderId, event, toPhone, status, error = null }) {
  const { rows } = await pool.query(
    `INSERT INTO order_notifications (order_id, event, to_phone, status, error)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (order_id, event) DO NOTHING
     RETURNING id`,
    [orderId, event, toPhone, status, error]
  );
  return rows.length > 0 ? rows[0].id : null;
}

/**
 * One Twilio Programmable Messaging call. Resolves { sid } on 201, throws an
 * Error with a short, secret-free message otherwise.
 */
async function sendTwilioSms({ accountSid, authToken, from }, to, body) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    accountSid
  )}/Messages.json`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(err?.name === "TimeoutError" ? "twilio_timeout" : "twilio_network_error");
  }

  const payload = await res.json().catch(() => ({}));
  if (res.status === 201 && payload.sid) return { sid: payload.sid };
  // Twilio's numeric error code is enough to look the failure up; its message
  // text can echo the destination number, so it is not stored.
  throw new Error(`twilio_http_${res.status}${payload.code ? `_code_${payload.code}` : ""}`);
}

/**
 * Texts an online pickup customer for one event (placed | started | ready).
 * Call only after the caller's COMMIT, and only for source = 'online' orders.
 * Never throws.
 */
async function notifyOnlineOrder(pool, event, { orderId, orderNumber, customerPhone }) {
  try {
    if (!smsEnabled()) return;
    if (!SMS_COPY[event]) {
      console.error(`[online-sms] unknown event '${event}' order #${orderNumber}`);
      return;
    }

    const to = normalizePhone(customerPhone);
    if (!to) {
      const claimed = await claimNotification(pool, {
        orderId,
        event,
        toPhone: customerPhone || null,
        status: "skipped",
        error: "invalid_phone",
      });
      if (claimed) console.warn(`[online-sms] ${event} skipped (invalid phone) order #${orderNumber}`);
      return;
    }

    const config = twilioConfig();
    if (!config) {
      const claimed = await claimNotification(pool, {
        orderId,
        event,
        toPhone: to,
        status: "skipped",
        error: "twilio_not_configured",
      });
      if (claimed) {
        console.warn(`[online-sms] ${event} skipped (Twilio not configured) order #${orderNumber}`);
      }
      return;
    }

    const notificationId = await claimNotification(pool, {
      orderId,
      event,
      toPhone: to,
      status: "queued",
    });
    if (!notificationId) return; // already claimed: someone else owns this send

    try {
      const { sid } = await sendTwilioSms(config, to, SMS_COPY[event](orderNumber));
      await pool.query(
        "UPDATE order_notifications SET status = 'sent', provider_sid = $2 WHERE id = $1",
        [notificationId, sid]
      );
      console.log(`[online-sms] ${event} sent order #${orderNumber}`);
      return "sent";
    } catch (err) {
      console.error(`[online-sms] ${event} failed order #${orderNumber}`);
      await pool.query(
        "UPDATE order_notifications SET status = 'failed', error = $2 WHERE id = $1",
        [notificationId, String(err?.message || "send_failed").slice(0, 200)]
      );
    }
  } catch (err) {
    // A database error while recording. Nothing more to do: the ticket is
    // already on the KDS and the customer has their confirmation page.
    console.error(`[online-sms] ${event} failed order #${orderNumber}`);
  }
}

/** "placed": after the ingest COMMIT, on the 201 new-row path only. */
function notifyOnlineOrderPlaced(pool, order) {
  return notifyOnlineOrder(pool, "placed", order);
}

/**
 * "ready": after the KDS preparing → ready COMMIT. Online orders keep their
 * P1a behaviour (always attempted). An in-store order is texted only when the
 * cashier took an optional walk-in phone, and that phone is wiped from the
 * order once the text is actually sent; order_notifications.to_phone is the
 * audit copy. Never throws.
 */
async function notifyOrderReady(pool, { orderId, orderNumber, customerPhone, source }) {
  const isOnline = source === "online";
  if (!isOnline && !normalizePhone(customerPhone)) return;

  const outcome = await notifyOnlineOrder(pool, "ready", { orderId, orderNumber, customerPhone });
  if (outcome !== "sent" || isOnline) return;

  try {
    await pool.query("UPDATE orders SET customer_phone = NULL WHERE id = $1", [orderId]);
  } catch (err) {
    console.error(`[online-sms] ready phone wipe failed order #${orderNumber}`);
  }
}

module.exports = {
  notifyOnlineOrder,
  notifyOnlineOrderPlaced,
  notifyOrderReady,
  SMS_COPY,
  TWILIO_TIMEOUT_MS,
  // Reused by lib/staffSms.js with its own from-number and flag.
  sendTwilioSms,
};
