// Deterministic checks for the Reports range resolvers. Pins `today` so the
// assertions don't drift with the wall clock. Run: node reportRange.test.mjs
import {
  resolvePreset,
  resolveMonth,
  resolveQuarter,
  resolveCustomRange,
} from "./reportRange.js";

const TODAY = new Date(2026, 6, 24); // 2026-07-24 (local), mid-Q3
let pass = 0;
let fail = 0;

function check(name, got, expected) {
  const g = JSON.stringify(got);
  const e = JSON.stringify(expected);
  if (g === e) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}\n        got      ${g}\n        expected ${e}`);
  }
}

check("last-month → full June", resolvePreset("last-month", TODAY), {
  start: "2026-06-01",
  end: "2026-06-30",
  label: "June 2026",
});
check("this-month → July to date", resolvePreset("this-month", TODAY), {
  start: "2026-07-01",
  end: "2026-07-24",
  label: "July 2026 (to date)",
});
check("this-quarter → Q3 to date", resolvePreset("this-quarter", TODAY), {
  start: "2026-07-01",
  end: "2026-07-24",
  label: "Q3 2026 (to date)",
});
check("this-year → 2026 to date", resolvePreset("this-year", TODAY), {
  start: "2026-01-01",
  end: "2026-07-24",
  label: "2026 (to date)",
});
check("month picker → full past May", resolveMonth("2026-05", TODAY), {
  start: "2026-05-01",
  end: "2026-05-31",
  label: "May 2026",
});
check("month picker → current month capped", resolveMonth("2026-07", TODAY), {
  start: "2026-07-01",
  end: "2026-07-24",
  label: "July 2026 (to date)",
});
check("quarter picker → full past Q2", resolveQuarter(2026, 2, TODAY), {
  start: "2026-04-01",
  end: "2026-06-30",
  label: "Q2 2026",
});
check("quarter picker → current Q3 capped", resolveQuarter(2026, 3, TODAY), {
  start: "2026-07-01",
  end: "2026-07-24",
  label: "Q3 2026 (to date)",
});
check("quarter picker → full past year Q4", resolveQuarter(2025, 4, TODAY), {
  start: "2025-10-01",
  end: "2025-12-31",
  label: "Q4 2025",
});
check("custom range keeps its bounds", resolveCustomRange("2026-02-10", "2026-02-20"), {
  start: "2026-02-10",
  end: "2026-02-20",
  label: "Feb 10 – Feb 20, 2026",
});
check("custom range swaps reversed bounds", resolveCustomRange("2026-02-20", "2026-02-10"), {
  start: "2026-02-10",
  end: "2026-02-20",
  label: "Feb 10 – Feb 20, 2026",
});
// Cross-year January: last-month must roll back to prior December.
check("last-month across year boundary", resolvePreset("last-month", new Date(2026, 0, 15)), {
  start: "2025-12-01",
  end: "2025-12-31",
  label: "December 2025",
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
