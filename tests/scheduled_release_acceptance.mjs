// Scheduled pickup release rule — acceptance tests.
//
// Pure: exercises backend/lib/scheduledRelease.js (the JS mirror of the SQL
// predicate loadLiveBoard uses) and the KDS countdown helper. No database, no
// network.
//
// Run from the repo root: node tests/scheduled_release_acceptance.mjs

import rule from "../backend/lib/scheduledRelease.js";
import { startInMinutes } from "../frontend/src/components/kdsBoard.js";

const { SCHEDULE_LEAD_MINUTES, RELEASED_SQL, releaseAt, isReleased } = rule;

let failures = 0;
function ok(label, condition, detail = "") {
  console.log(`  ${condition ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

const NOW = new Date("2026-09-30T18:00:00Z");
const plus = (min) => new Date(NOW.getTime() + min * 60000).toISOString();

console.log("Release rule:");
ok("lead is 20 minutes", SCHEDULE_LEAD_MINUTES === 20);
ok("null pickup (in-store / ASAP) -> live", isReleased({ pickup_at: null, released_at: null }, NOW));
ok("pickup in 2h -> scheduled", !isReleased({ pickup_at: plus(120), released_at: null }, NOW));
ok("pickup in 10 min -> live", isReleased({ pickup_at: plus(10), released_at: null }, NOW));
ok("pickup in exactly 20 min -> live", isReleased({ pickup_at: plus(20), released_at: null }, NOW));
ok("pickup in 21 min -> scheduled", !isReleased({ pickup_at: plus(21), released_at: null }, NOW));
ok("pickup already past -> live", isReleased({ pickup_at: plus(-5), released_at: null }, NOW));
ok("pickup in 2h but fired (released_at) -> live", isReleased({ pickup_at: plus(120), released_at: NOW.toISOString() }, NOW));
ok("release_at = pickup - 20 min", releaseAt(plus(120)).toISOString() === plus(100));
ok("release_at null when no pickup", releaseAt(null) === null);
ok("SQL predicate covers the same three cases",
  RELEASED_SQL.includes("pickup_at IS NULL") &&
  RELEASED_SQL.includes("released_at IS NOT NULL") &&
  RELEASED_SQL.includes("interval '20 minutes'"));

console.log("Countdown:");
ok("100 min to release -> 100", startInMinutes(plus(100), NOW.getTime()) === 100);
ok("30 s to release -> 1 (rounds up)", startInMinutes(new Date(NOW.getTime() + 30000).toISOString(), NOW.getTime()) === 1);
ok("release passed -> 0", startInMinutes(plus(-1), NOW.getTime()) === 0);

console.log(failures === 0 ? "\nAll scheduled release tests passed." : `\n${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
