// Phone normalization for online pickup SMS
// (docs/architecture/online-pickup-sms-plan.md).
//
// orders.customer_phone is whatever the customer typed at checkout, trimmed.
// Before anything is texted it must become one canonical E.164 number, and a
// value that cannot become one is a "do not text", never an error: this runs
// after the order is already paid for and on the kitchen's screen.

// Formatting people type between digits. Anything else (letters, "ext", a
// second "+", slashes) makes the whole value unusable.
const SEPARATORS = /[\s\-().]/g;

// NANP: area code and exchange both start 2-9.
const NANP_TEN = /^[2-9]\d{2}[2-9]\d{6}$/;

/**
 * Normalizes a Canadian / US phone number to '+1XXXXXXXXXX'.
 *
 * Accepts 10 digits, 11 digits starting with 1, or +1 followed by 10 digits,
 * with spaces, dashes, parentheses and dots ignored. Returns null for
 * anything else, including non-strings. Never throws.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizePhone(raw) {
  if (typeof raw !== "string") return null;

  const compact = raw.replace(SEPARATORS, "");
  const match = /^(\+?)(\d+)$/.exec(compact);
  if (!match) return null;

  const [, plus, digits] = match;
  let national;
  if (digits.length === 11 && digits[0] === "1") {
    national = digits.slice(1);
  } else if (digits.length === 10 && !plus) {
    national = digits;
  } else {
    return null;
  }

  return NANP_TEN.test(national) ? `+1${national}` : null;
}

module.exports = { normalizePhone };
