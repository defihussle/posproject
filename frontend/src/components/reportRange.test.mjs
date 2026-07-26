// Deterministic checks for the Reports range resolvers. Pins `today` so the
// assertions don't drift with the wall clock. Run: node reportRange.test.mjs
import {
  resolvePreset,
  resolveMonth,
  resolveQuarter,
  resolveCustomRange,
  previousPeriod,
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
  kind: "month",
});
check("this-month → July to date", resolvePreset("this-month", TODAY), {
  start: "2026-07-01",
  end: "2026-07-24",
  label: "July 2026 (to date)",
  kind: "month",
});
check("this-quarter → Q3 to date", resolvePreset("this-quarter", TODAY), {
  start: "2026-07-01",
  end: "2026-07-24",
  label: "Q3 2026 (to date)",
  kind: "quarter",
});
check("this-year → 2026 to date", resolvePreset("this-year", TODAY), {
  start: "2026-01-01",
  end: "2026-07-24",
  label: "2026 (to date)",
  kind: "year",
});
check("month picker → full past May", resolveMonth("2026-05", TODAY), {
  start: "2026-05-01",
  end: "2026-05-31",
  label: "May 2026",
  kind: "month",
});
check("month picker → current month capped", resolveMonth("2026-07", TODAY), {
  start: "2026-07-01",
  end: "2026-07-24",
  label: "July 2026 (to date)",
  kind: "month",
});
check("quarter picker → full past Q2", resolveQuarter(2026, 2, TODAY), {
  start: "2026-04-01",
  end: "2026-06-30",
  label: "Q2 2026",
  kind: "quarter",
});
check("quarter picker → current Q3 capped", resolveQuarter(2026, 3, TODAY), {
  start: "2026-07-01",
  end: "2026-07-24",
  label: "Q3 2026 (to date)",
  kind: "quarter",
});
check("quarter picker → full past year Q4", resolveQuarter(2025, 4, TODAY), {
  start: "2025-10-01",
  end: "2025-12-31",
  label: "Q4 2025",
  kind: "quarter",
});
check("custom range keeps its bounds", resolveCustomRange("2026-02-10", "2026-02-20"), {
  start: "2026-02-10",
  end: "2026-02-20",
  label: "Feb 10 – Feb 20, 2026",
  kind: "range",
});
check("custom range swaps reversed bounds", resolveCustomRange("2026-02-20", "2026-02-10"), {
  start: "2026-02-10",
  end: "2026-02-20",
  label: "Feb 10 – Feb 20, 2026",
  kind: "range",
});
// Cross-year January: last-month must roll back to prior December.
check("last-month across year boundary", resolvePreset("last-month", new Date(2026, 0, 15)), {
  start: "2025-12-01",
  end: "2025-12-31",
  label: "December 2025",
  kind: "month",
});

// --- previousPeriod (comparison window) — full periods → prior FULL period ---
check("prev of full month → prior month", previousPeriod("2026-06-01", "2026-06-30", "month"), {
  start: "2026-05-01",
  end: "2026-05-31",
});
check("prev of full month across year → prior Dec", previousPeriod("2026-01-01", "2026-01-31", "month"), {
  start: "2025-12-01",
  end: "2025-12-31",
});
check("prev of full quarter → prior quarter", previousPeriod("2026-04-01", "2026-06-30", "quarter"), {
  start: "2026-01-01",
  end: "2026-03-31",
});
check("prev of Q1 across year → prior Q4", previousPeriod("2026-01-01", "2026-03-31", "quarter"), {
  start: "2025-10-01",
  end: "2025-12-31",
});
check("prev of full year → prior year", previousPeriod("2026-01-01", "2026-12-31", "year"), {
  start: "2025-01-01",
  end: "2025-12-31",
});

// --- To-date windows → SAME elapsed span of the prior period (same-day) ---
check("prev of month-to-date → prior month same day", previousPeriod("2026-07-01", "2026-07-24", "month"), {
  start: "2026-06-01",
  end: "2026-06-24",
});
check("prev of quarter-to-date → prior quarter same day", previousPeriod("2026-07-01", "2026-07-24", "quarter"), {
  start: "2026-04-01",
  end: "2026-04-24",
});
check("prev of year-to-date → prior year same day", previousPeriod("2026-01-01", "2026-07-24", "year"), {
  start: "2025-01-01",
  end: "2025-07-24",
});
// Clamp: to-date month ending on the 30th → prior Feb clamps to the 28th.
check("prev of month-to-date clamps short prior month", previousPeriod("2026-03-01", "2026-03-30", "month"), {
  start: "2026-02-01",
  end: "2026-02-28",
});
// Clamp: leap-day YTD → prior (non-leap) year clamps Feb 29 → Feb 28.
check("prev of YTD ending on leap day clamps", previousPeriod("2024-01-01", "2024-02-29", "year"), {
  start: "2023-01-01",
  end: "2023-02-28",
});
// Arbitrary custom range → equal-length immediately-preceding window.
check("prev of 11-day custom range → equal-length preceding", previousPeriod("2026-02-10", "2026-02-20", "range"), {
  start: "2026-01-30",
  end: "2026-02-09",
});
// Inference fallback: no kind supplied, full month is detected as a month.
check("prev infers full month when kind omitted", previousPeriod("2026-06-01", "2026-06-30"), {
  start: "2026-05-01",
  end: "2026-05-31",
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
