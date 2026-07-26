import { useState, useMemo, useEffect, useCallback } from "react";
import { Outlet, useOutletContext, Navigate } from "react-router-dom";
import {
  toYmd,
  toYm,
  PRESETS,
  resolvePreset,
  resolveMonth,
  resolveQuarter,
  resolveCustomRange,
} from "../reportRange";
import { visibleReports } from "./registry";
import "../Reports.css";

// ============================================================
// Back Office → Reports — SHARED LAYOUT for every report route.
// Each report is its own URL (/backoffice/reports/<path>), but they all render
// INSIDE this one layout, so the period-oriented range selector exists exactly
// once (DRY) and the resolved range flows down to whichever report is active
// via <Outlet> context. The report picker is now the sidebar dropdown (see
// BackOffice.jsx); this layout no longer owns tabs. The CSV/PDF export
// scaffolding stays shared in reportExport.js, used by each report body.
//
// See docs/architecture/reports-plan.md. Range resolution lives in
// ../reportRange (pure + unit-tested).
// ============================================================
export default function ReportsLayout({ staff }) {
  const [range, setRange] = useState(() => resolvePreset("last-month"));

  return (
    <div className="reports">
      <div className="reports__head">
        <h2 className="reports__title">Reports</h2>
      </div>

      <RangeSelector value={range} onChange={setRange} />

      <div className="reports__body">
        {/* The active report renders here, reading `range` from context. */}
        <Outlet context={{ range, staff }} />
      </div>
    </div>
  );
}

// Route element for a single report: reads the shared range from the layout's
// context and enforces the report's OWN role list (redirecting an unauthorized
// role to the first report it can see). Keeps the four report bodies unchanged
// — they still take a `range` prop.
export function ReportRoute({ report }) {
  const { range, staff } = useOutletContext();
  if (!report.roles.includes(staff.role)) {
    const fallback = visibleReports(staff.role)[0];
    return <Navigate to={fallback ? `../${fallback.path}` : ".."} replace />;
  }
  const Report = report.Component;
  return <Report range={range} staff={staff} />;
}

// ---- Date range selector (period-oriented) --------------------------------
// Presets cover the common filing windows; "Custom" opens month / quarter /
// range pickers so "July 2026" or "Q2 2026" is one tap. Everything resolves
// to { start, end (YYYY-MM-DD), label, kind } and is handed up via onChange —
// the backend gets these as getStatsBounds' custom start/end, so no new bounds
// logic is needed server-side.
function RangeSelector({ value, onChange }) {
  const now = new Date();
  const [preset, setPreset] = useState("last-month"); // preset key or "custom"
  const [customMode, setCustomMode] = useState("month"); // month | quarter | range
  const [month, setMonth] = useState(() => toYm(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
  const [qYear, setQYear] = useState(now.getFullYear());
  const [quarter, setQuarter] = useState(Math.floor(now.getMonth() / 3) + 1 || 1);
  const [rangeStart, setRangeStart] = useState(() => resolvePreset("last-month").start);
  const [rangeEnd, setRangeEnd] = useState(() => resolvePreset("last-month").end);

  const resolved = useMemo(() => {
    if (preset !== "custom") return resolvePreset(preset);
    if (customMode === "month") return resolveMonth(month);
    if (customMode === "quarter") return resolveQuarter(Number(qYear), Number(quarter));
    return resolveCustomRange(rangeStart, rangeEnd);
  }, [preset, customMode, month, qYear, quarter, rangeStart, rangeEnd]);

  const emit = useCallback((v) => v && onChange(v), [onChange]);
  useEffect(() => {
    emit(resolved);
  }, [resolved, emit]);

  const isCustom = preset === "custom";

  return (
    <div className="reports__rangesel">
      <div className="reports__presets">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            className={`reports__pill${preset === p.key ? " reports__pill--active" : ""}`}
            onClick={() => setPreset(p.key)}
          >
            {p.label}
          </button>
        ))}
        <button
          className={`reports__pill${isCustom ? " reports__pill--active" : ""}`}
          onClick={() => setPreset("custom")}
        >
          Custom
        </button>
      </div>

      {isCustom && (
        <div className="reports__custom">
          <div className="reports__custom-tabs">
            {[
              { key: "month", label: "Month" },
              { key: "quarter", label: "Quarter" },
              { key: "range", label: "Range" },
            ].map((t) => (
              <button
                key={t.key}
                className={`reports__subtab${customMode === t.key ? " reports__subtab--active" : ""}`}
                onClick={() => setCustomMode(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="reports__custom-body">
            {customMode === "month" && (
              <label className="reports__field">
                <span className="reports__field-label">Month</span>
                <input
                  type="month"
                  className="reports__input"
                  value={month}
                  max={toYm(new Date())}
                  onChange={(e) => setMonth(e.target.value)}
                />
              </label>
            )}

            {customMode === "quarter" && (
              <div className="reports__quarter">
                <label className="reports__field">
                  <span className="reports__field-label">Year</span>
                  <input
                    type="number"
                    className="reports__input reports__input--year"
                    value={qYear}
                    min="2020"
                    max={now.getFullYear()}
                    onChange={(e) => setQYear(e.target.value)}
                  />
                </label>
                <div className="reports__qbtns">
                  {[1, 2, 3, 4].map((q) => (
                    <button
                      key={q}
                      className={`reports__qbtn${Number(quarter) === q ? " reports__qbtn--active" : ""}`}
                      onClick={() => setQuarter(q)}
                    >
                      Q{q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {customMode === "range" && (
              <div className="reports__daterange">
                <label className="reports__field">
                  <span className="reports__field-label">Start</span>
                  <input
                    type="date"
                    className="reports__input"
                    value={rangeStart}
                    max={rangeEnd || toYmd(new Date())}
                    onChange={(e) => setRangeStart(e.target.value)}
                  />
                </label>
                <label className="reports__field">
                  <span className="reports__field-label">End</span>
                  <input
                    type="date"
                    className="reports__input"
                    value={rangeEnd}
                    min={rangeStart}
                    max={toYmd(new Date())}
                    onChange={(e) => setRangeEnd(e.target.value)}
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      )}

      {/* The exact window being queried — label + the underlying dates, so
          there's never ambiguity about what a report covers. */}
      <div className="reports__resolved">
        <span className="reports__resolved-label">{value?.label || "—"}</span>
        {value && (
          <span className="reports__resolved-dates">
            {value.start} → {value.end}
          </span>
        )}
      </div>
    </div>
  );
}
