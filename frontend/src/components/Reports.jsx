import { useState, useMemo, useEffect, useCallback } from "react";
import {
  toYmd,
  toYm,
  PRESETS,
  resolvePreset,
  resolveMonth,
  resolveQuarter,
  resolveCustomRange,
} from "./reportRange";
import "./Reports.css";

// ============================================================
// Back Office → Reports (owner/admin). Portable, exportable records for
// record-keeping, filing, and audit — distinct from the Dashboard, which is
// the live/visual surface. This file is the SHELL: a period-oriented date
// range selector, a role-aware report registry, report-picker tabs, and the
// shared table/export scaffolding each report body plugs into. The four
// report bodies (Sales Summary, Transaction Log, Discount, Labor) arrive in
// later slices; today every report renders a placeholder.
//
// See docs/architecture/reports-plan.md for the full design.
// Period-oriented range resolution lives in ./reportRange (pure + unit-tested).
// ============================================================

// Role-aware from day one: each report carries the roles that may run it.
// Every phase-1 report is owner+admin, but keeping the field here means
// restricting the financial reports (e.g. Sales Summary / Transaction Log)
// to owner-only later is a one-line change per report, not a refactor.
// Component === null renders the shared placeholder until its slice lands.
const REPORTS = [
  { key: "sales-summary", label: "Sales Summary", roles: ["owner", "admin"], Component: null },
  { key: "transactions", label: "Transaction Log", roles: ["owner", "admin"], Component: null },
  { key: "discounts", label: "Discount Report", roles: ["owner", "admin"], Component: null },
  { key: "labor", label: "Labor Report", roles: ["owner", "admin"], Component: null },
];

export default function Reports({ staff }) {
  const [range, setRange] = useState(() => resolvePreset("last-month"));

  const visibleReports = useMemo(
    () => REPORTS.filter((r) => r.roles.includes(staff.role)),
    [staff.role]
  );
  const [activeKey, setActiveKey] = useState(() => visibleReports[0]?.key ?? null);
  const active = visibleReports.find((r) => r.key === activeKey) || visibleReports[0];

  return (
    <div className="reports">
      <div className="reports__head">
        <h2 className="reports__title">Reports</h2>
      </div>

      <RangeSelector value={range} onChange={setRange} />

      {/* Report picker */}
      <div className="reports__tabs" role="tablist" aria-label="Reports">
        {visibleReports.map((r) => (
          <button
            key={r.key}
            role="tab"
            aria-selected={r.key === active?.key}
            className={`reports__tab${r.key === active?.key ? " reports__tab--active" : ""}`}
            onClick={() => setActiveKey(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="reports__body">
        {active ? (
          active.Component ? (
            <active.Component staff={staff} range={range} />
          ) : (
            <ReportPlaceholder label={active.label} range={range} />
          )
        ) : (
          <div className="reports__placeholder">No reports available</div>
        )}
      </div>
    </div>
  );
}

// ---- Date range selector (period-oriented) --------------------------------
// Presets cover the common filing windows; "Custom" opens month / quarter /
// range pickers so "July 2026" or "Q2 2026" is one tap. Everything resolves
// to { start, end (YYYY-MM-DD), label } and is handed up via onChange — the
// backend gets these as getStatsBounds' custom start/end, so no new bounds
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

// ---- Shared placeholder ---------------------------------------------------
// Shows the shared table shell + a disabled export bar, so the scaffolding
// each report body will fill is visible now. Replaced per-report in later
// slices (registry entry gains a real Component).
function ReportPlaceholder({ label, range }) {
  return (
    <div className="reports__report">
      <div className="reports__report-head">
        <h3 className="reports__report-title">{label}</h3>
        <div className="reports__exports">
          <button className="reports__exportbtn" disabled title="Available once this report ships">
            Export CSV
          </button>
          <button className="reports__exportbtn" disabled title="Available once this report ships">
            Export PDF
          </button>
        </div>
      </div>
      <div className="reports__tablewrap">
        <div className="reports__coming">
          {label} for <strong>{range?.label}</strong> — table and exports arrive in the next slice.
        </div>
      </div>
    </div>
  );
}
