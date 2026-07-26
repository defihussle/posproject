// ============================================================
// Back Office → Reports — period-oriented range resolution.
// Pure functions (no React) so they're unit-testable in node. Each resolver
// returns { start, end, label } where start/end are YYYY-MM-DD in LOCAL time
// and get handed to the backend as getStatsBounds' custom start/end — so no
// new date-window logic is needed server-side.
//
// Dates are built from numeric parts, never parsed from strings: iOS Safari
// (JavaScriptCore) throws on new Date("YYYY-MM-DD..") where Chromium accepts
// it. Numeric construction is safe on every engine.
// ============================================================

export const toYmd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const toYm = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
export const parseYmd = (ymd) => {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return new Date(y, m - 1, d);
};
export const monthLabel = (d) => d.toLocaleString(undefined, { month: "long", year: "numeric" });

export const fmtRange = (a, b) => {
  const s = parseYmd(a);
  const e = parseYmd(b);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return `${a} – ${b}`;
  const mo = (x) => x.toLocaleString(undefined, { month: "short" });
  const sameYear = s.getFullYear() === e.getFullYear();
  const left = sameYear ? `${mo(s)} ${s.getDate()}` : `${mo(s)} ${s.getDate()}, ${s.getFullYear()}`;
  return `${left} – ${mo(e)} ${e.getDate()}, ${e.getFullYear()}`;
};

// Reports describe COMPLETED periods, so a window is capped at today: pick
// "This Year" and you get Jan 1 → today, labelled "(to date)". A fully past
// period (Last Month, a picked month/quarter) ends on its real last day.
// `today` is injectable purely so tests are deterministic.
export function finalize(startDate, naturalEndDate, baseLabel, today = new Date()) {
  const capped = naturalEndDate > today;
  const endDate = capped ? today : naturalEndDate;
  return {
    start: toYmd(startDate),
    end: toYmd(endDate),
    label: capped ? `${baseLabel} (to date)` : baseLabel,
  };
}

export function resolvePreset(key, today = new Date()) {
  const y = today.getFullYear();
  const mo = today.getMonth();
  if (key === "last-month") {
    const s = new Date(y, mo - 1, 1);
    return finalize(s, new Date(y, mo, 0), monthLabel(s), today); // day 0 = last day of prev month
  }
  if (key === "this-month") {
    const s = new Date(y, mo, 1);
    return finalize(s, new Date(y, mo + 1, 0), monthLabel(s), today);
  }
  if (key === "this-quarter") {
    const q = Math.floor(mo / 3);
    const s = new Date(y, q * 3, 1);
    return finalize(s, new Date(y, q * 3 + 3, 0), `Q${q + 1} ${y}`, today);
  }
  // this-year
  const s = new Date(y, 0, 1);
  return finalize(s, new Date(y, 11, 31), `${y}`, today);
}

export function resolveMonth(ym, today = new Date()) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return null;
  const s = new Date(y, m - 1, 1);
  return finalize(s, new Date(y, m, 0), monthLabel(s), today);
}

export function resolveQuarter(y, q, today = new Date()) {
  if (!y || !q) return null;
  const s = new Date(y, (q - 1) * 3, 1);
  return finalize(s, new Date(y, q * 3, 0), `Q${q} ${y}`, today);
}

export function resolveCustomRange(a, b) {
  if (!a || !b) return null;
  const [lo, hi] = a <= b ? [a, b] : [b, a]; // swap defensively
  return { start: lo, end: hi, label: fmtRange(lo, hi) };
}

export const PRESETS = [
  { key: "last-month", label: "Last Month" },
  { key: "this-month", label: "This Month" },
  { key: "this-quarter", label: "This Quarter" },
  { key: "this-year", label: "This Year" },
];

const lastDayOfMonth = (y, m) => new Date(y, m + 1, 0).getDate();

// Map a resolved [start, end] window to its "prior equivalent period", used
// for every report's period-over-period comparison (the backend runs the same
// aggregate over whatever prevStart/prevEnd it's handed). Detects calendar-
// aligned windows from the dates alone:
//   - a FULL calendar year  → the previous full year
//   - a FULL calendar quarter → the previous full quarter
//   - a FULL calendar month → the previous full month
//   - anything else (a to-date window, or an arbitrary custom range) → the
//     equal-length window immediately before it.
// NOTE (flagged): for to-date and custom ranges this is a rolling equal-length
// window, NOT "same-day-of-period last time" — e.g. "July 1–24" compares to
// "Jun 7–30", not "Jun 1–24". Full month/quarter/year (the common picker
// cases) are exact. Same-day-to-date parity would be a small extra refactor.
export function previousPeriod(start, end) {
  const s = parseYmd(start);
  const e = parseYmd(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;

  const firstOfMonth = s.getDate() === 1;
  const lastOfMonth = e.getDate() === lastDayOfMonth(e.getFullYear(), e.getMonth());
  const sameYear = s.getFullYear() === e.getFullYear();

  if (firstOfMonth && lastOfMonth && sameYear) {
    // Full calendar year
    if (s.getMonth() === 0 && e.getMonth() === 11) {
      const py = s.getFullYear() - 1;
      return { start: toYmd(new Date(py, 0, 1)), end: toYmd(new Date(py, 11, 31)) };
    }
    // Full calendar quarter (start month is a quarter boundary, end = +2 months)
    if (s.getMonth() % 3 === 0 && e.getMonth() === s.getMonth() + 2) {
      let py = s.getFullYear();
      let pStartMonth = s.getMonth() - 3;
      if (pStartMonth < 0) {
        pStartMonth = 9;
        py -= 1;
      }
      return {
        start: toYmd(new Date(py, pStartMonth, 1)),
        end: toYmd(new Date(py, pStartMonth + 3, 0)),
      };
    }
    // Full calendar month
    if (s.getMonth() === e.getMonth()) {
      const ps = new Date(s.getFullYear(), s.getMonth() - 1, 1);
      return {
        start: toYmd(ps),
        end: toYmd(new Date(ps.getFullYear(), ps.getMonth() + 1, 0)),
      };
    }
  }

  // Fallback: equal-length window immediately before [start, end] (inclusive).
  const days = Math.round((e - s) / 86400000) + 1;
  const prevEnd = new Date(s);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - (days - 1));
  return { start: toYmd(prevStart), end: toYmd(prevEnd) };
}
