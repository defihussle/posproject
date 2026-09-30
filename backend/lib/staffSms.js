// Staff verification codes by SMS (P3): Order Entry first-time PIN setup and
// Forgot PIN. Codes live in staff_auth_codes (database/staff_sms_auth.sql).
//
// Entirely separate from customer order SMS (lib/onlineSms.js): its own flag
// (STAFF_SMS_ENABLED) and its own sender (TWILIO_STAFF_FROM_NUMBER). It never
// reads ONLINE_SMS_ENABLED or TWILIO_FROM_NUMBER, so turning customer texts
// off can't break PIN recovery and vice versa. Only the HTTP call is shared.
//
// Never logs a code, a full phone number, or a Twilio credential.

const crypto = require("crypto");
const { sendTwilioSms } = require("./onlineSms");

const STAFF_CODE_TTL_MS = 10 * 60 * 1000;
const STAFF_CODE_MAX_ATTEMPTS = 5;

const staffCodeCopy = (code) => `Narcos staff code: ${code}. Expires in 10 min.`;

function staffSmsEnabled() {
  return process.env.STAFF_SMS_ENABLED === "true";
}

/** Null unless the flag is on AND every staff credential is present. */
function staffTwilioConfig() {
  if (!staffSmsEnabled()) return null;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_STAFF_FROM_NUMBER;
  if (!accountSid || !authToken || !from) return null;
  return { accountSid, authToken, from };
}

/** Uniform 6 digits, leading zeros allowed. */
function generateStaffCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

// Keyed HMAC bound to the row id: a leaked table alone can't be brute-forced
// offline (1M codes) without the server secret, and one row's hash is useless
// for any other row.
function hashStaffCode(secret, codeId, code) {
  return crypto.createHmac("sha256", secret).update(`${codeId}:${code}`).digest("hex");
}

function staffCodeMatches(secret, codeId, code, storedHash) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  const a = Buffer.from(hashStaffCode(secret, codeId, code), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Texts the code. Resolves "sent", "skipped" (flag off / not configured — no
 * network call) or "failed". Never throws.
 */
async function sendStaffCode(to, code) {
  const config = staffTwilioConfig();
  if (!config) return "skipped";
  try {
    await sendTwilioSms(config, to, staffCodeCopy(code));
    return "sent";
  } catch (err) {
    console.error(`[staff-sms] send failed: ${String(err?.message || "send_failed").slice(0, 80)}`);
    return "failed";
  }
}

module.exports = {
  STAFF_CODE_TTL_MS,
  STAFF_CODE_MAX_ATTEMPTS,
  staffCodeCopy,
  staffSmsEnabled,
  staffTwilioConfig,
  generateStaffCode,
  hashStaffCode,
  staffCodeMatches,
  sendStaffCode,
};
