// Online pickup SMS Slice 1 — phone normalizer acceptance tests.
//
// normalizePhone() is pure: no database, no env, no server import. It turns
// whatever the customer typed into '+1XXXXXXXXXX', or null for "do not text".
//
// Run from the repo root: node tests/phone_normalize_acceptance.mjs

import phone from "../backend/lib/phone.js";

const { normalizePhone } = phone;

let failures = 0;
function ok(label, condition, detail = "") {
  console.log(`  ${condition ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

function expect(input, expected) {
  let actual;
  try {
    actual = normalizePhone(input);
  } catch (err) {
    ok(`${JSON.stringify(input)} does not throw`, false, err.message);
    return;
  }
  ok(
    `${JSON.stringify(input)} -> ${JSON.stringify(expected)}`,
    actual === expected,
    actual === expected ? "" : `got ${JSON.stringify(actual)}`
  );
}

console.log("Accepts CA/US numbers:");
expect("(416) 555-1234", "+14165551234");
expect("4165551234", "+14165551234");
expect("1 416 555 1234", "+14165551234");
expect("+14165551234", "+14165551234");
expect("+1 (416) 555-1234", "+14165551234");
expect("416.555.1234", "+14165551234");
expect("  647-555-0199  ", "+16475550199");

console.log("Rejects:");
expect("", null);
expect("   ", null);
expect("123", null);
expect("44165551234", null); // 11 digits not starting with 1
expect("+44165551234", null); // not +1
expect("+4165551234", null); // + with 10 digits is not +1 NANP
expect("+140165551234", null); // too long
expect("0165551234", null); // area code starts 0
expect("+10165551234", null); // leading 0 after country code
expect("1165551234", null); // area code starts 1
expect("4160551234", null); // exchange starts 0
expect(null, null);
expect(undefined, null);
expect(4165551234, null); // non-string
expect({}, null);
expect("call me", null);
expect("416-555-1234 ext 5", null);
expect("416/555/1234", null);
expect("++14165551234", null);
expect("1-800-FLOWERS", null);

console.log(failures === 0 ? "\nAll phone normalize tests passed." : `\n${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
