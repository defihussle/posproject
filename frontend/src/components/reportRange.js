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
// `kind` (month | quarter | year | range) is carried on every resolved window
// so previousPeriod() can pick the right prior-equivalent even when calendar
// boundaries coincide — e.g. Jul 1–24 is identical dates whether it's "this
// month to date" or "this quarter to date", but their prior periods differ
// (Jun 1–24 vs Apr 1–24). It can't be recovered from the dates alone.
export function finalize(startDate, naturalEndDate, baseLabel, today = new Date(), kind = "range") {
  const capped = naturalEndDate > today;
  const endDate = capped ? today : naturalEndDate;
  return {
    start: toYmd(startDate),
    end: toYmd(endDate),
    label: capped ? `${baseLabel} (to date)` : baseLabel,
    kind,
  };
}

export function resolvePreset(key, today = new Date()) {
  const y = today.getFullYear();
  const mo = today.getMonth();
  if (key === "last-month") {
    const s = new Date(y, mo - 1, 1);
    return finalize(s, new Date(y, mo, 0), monthLabel(s), today, "month"); // day 0 = last day of prev month
  }
  if (key === "this-month") {
    const s = new Date(y, mo, 1);
    return finalize(s, new Date(y, mo + 1, 0), monthLabel(s), today, "month");
  }
  if (key === "this-quarter") {
    const q = Math.floor(mo / 3);
    const s = new Date(y, q * 3, 1);
    return finalize(s, new Date(y, q * 3 + 3, 0), `Q${q + 1} ${y}`, today, "quarter");
  }
  // this-year
  const s = new Date(y, 0, 1);
  return finalize(s, new Date(y, 11, 31), `${y}`, today, "year");
}

export function resolveMonth(ym, today = new Date()) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return null;
  const s = new Date(y, m - 1, 1);
  return finalize(s, new Date(y, m, 0), monthLabel(s), today, "month");
}

export function resolveQuarter(y, q, today = new Date()) {
  if (!y || !q) return null;
  const s = new Date(y, (q - 1) * 3, 1);
  return finalize(s, new Date(y, q * 3, 0), `Q${q} ${y}`, today, "quarter");
}

export function resolveCustomRange(a, b) {
  if (!a || !b) return null;
  const [lo, hi] = a <= b ? [a, b] : [b, a]; // swap defensively
  return { start: lo, end: hi, label: fmtRange(lo, hi), kind: "range" };
}

export const PRESETS = [
  { key: "last-month", label: "Last Month" },
  { key: "this-month", label: "This Month" },
  { key: "this-quarter", label: "This Quarter" },
  { key: "this-year", label: "This Year" },
];

const lastDayOfMonth = (y, m) => new Date(y, m + 1, 0).getDate();
// Same month/day in a target month, clamped to that month's last day so
// Jul 31 → Jun 30 (not Jul 1) and Feb 29 → Feb 28 in a non-leap prior year.
const clampDay = (y, m, day) => new Date(y, m, Math.min(day, lastDayOfMonth(y, m)));

// Best-effort period type when a caller doesn't supply `kind` (e.g. a raw
// start/end pair): a FULL calendar year/quarter/month, else "range".
function inferKind(s, e) {
  const firstOfMonth = s.getDate() === 1;
  const lastOfMonth = e.getDate() === lastDayOfMonth(e.getFullYear(), e.getMonth());
  if (firstOfMonth && lastOfMonth && s.getFullYear() === e.getFullYear()) {
    if (s.getMonth() === 0 && e.getMonth() === 11) return "year";
    if (s.getMonth() % 3 === 0 && e.getMonth() === s.getMonth() + 2) return "quarter";
    if (s.getMonth() === e.getMonth()) return "month";
  }
  return "range";
}

// Map a resolved [start, end] window to its "prior equivalent period" for
// period-over-period comparison (the backend runs the same aggregate over
// whatever prevStart/prevEnd it's handed). Alignment is by SAME DAY OF PERIOD,
// per accounting convention:
//   - a FULL calendar month/quarter/year → the previous FULL such period
//   - a TO-DATE month/quarter/year → the same elapsed span of the PRIOR period
//     (Jul 1–24 → Jun 1–24; Q3-to-date Jul 1–24 → Apr 1–24; YTD → prior YTD),
//     shifting the end date back one period and clamping to a valid day
//   - an arbitrary custom range → the equal-length window immediately before.
// NOTE (flagged): same-day alignment compares equal calendar spans, so the two
// windows can contain a different mix of weekdays (e.g. one more Saturday);
// day-of-week composition is NOT normalized. Surfaced in the comparison UI.
export function previousPeriod(start, end, kind) {
  const s = parseYmd(start);
  const e = parseYmd(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  if (!kind) kind = inferKind(s, e);

  if (kind === "year") {
    const py = s.getFullYear() - 1;
    const full = s.getMonth() === 0 && s.getDate() === 1 && e.getMonth() === 11 && e.getDate() === 31;
    const pEnd = full ? new Date(py, 11, 31) : clampDay(py, e.getMonth(), e.getDate());
    return { start: toYmd(new Date(py, 0, 1)), end: toYmd(pEnd) };
  }

  if (kind === "quarter") {
    const qStartMonth = s.getMonth(); // 0,3,6,9
    let pStartMonth = qStartMonth - 3;
    let pStartYear = s.getFullYear();
    if (pStartMonth < 0) {
      pStartMonth += 12;
      pStartYear -= 1;
    }
    const full =
      e.getMonth() === qStartMonth + 2 && e.getDate() === lastDayOfMonth(e.getFullYear(), e.getMonth());
    let pEnd;
    if (full) {
      pEnd = new Date(pStartYear, pStartMonth + 3, 0); // last day of prior quarter
    } else {
      let pEndMonth = e.getMonth() - 3;
      let pEndYear = e.getFullYear();
      if (pEndMonth < 0) {
        pEndMonth += 12;
        pEndYear -= 1;
      }
      pEnd = clampDay(pEndYear, pEndMonth, e.getDate());
    }
    return { start: toYmd(new Date(pStartYear, pStartMonth, 1)), end: toYmd(pEnd) };
  }

  if (kind === "month") {
    const pStart = new Date(s.getFullYear(), s.getMonth() - 1, 1);
    const pYear = pStart.getFullYear();
    const pMonth = pStart.getMonth();
    const full =
      e.getFullYear() === s.getFullYear() &&
      e.getMonth() === s.getMonth() &&
      e.getDate() === lastDayOfMonth(s.getFullYear(), s.getMonth());
    const pEnd = full ? new Date(pYear, pMonth + 1, 0) : clampDay(pYear, pMonth, e.getDate());
    return { start: toYmd(pStart), end: toYmd(pEnd) };
  }

  // range: equal-length window immediately before [start, end] (inclusive).
  const days = Math.round((e - s) / 86400000) + 1;
  const prevEnd = new Date(s);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - (days - 1));
  return { start: toYmd(prevStart), end: toYmd(prevEnd) };
}
