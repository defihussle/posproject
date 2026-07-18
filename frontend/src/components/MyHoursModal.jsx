import { useState, useEffect, useCallback } from "react";
import { API_URL } from "../config";
import "./StaffManager.css";
import "./MyHoursModal.css";

const RANGES = [
  { key: "today", label: "Today" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

function fmtDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Self-service shift history — Order Entry account dropdown, every role.
 * GET /api/staff/me/hours always returns the CALLING staffId's own shifts
 * only; there's no parameter that broadens this to anyone else's.
 * Order-Entry-only by design (not reachable from Back Office) since
 * cashier/kitchen have no Back Office access at all.
 */
export default function MyHoursModal({ staff, onClose }) {
  const [range, setRange] = useState("today");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `${API_URL}/api/staff/me/hours?staffId=${staff.id}&range=${range}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
      setError(null);
    } catch (err) {
      setError(err.message || "Failed to load hours");
    } finally {
      setLoading(false);
    }
  }, [staff.id, range]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="staffmgr__overlay" onClick={onClose}>
      <div className="staffmgr__modal myhours__modal" onClick={(e) => e.stopPropagation()}>
        <div className="staffmgr__modal-head">
          <h3 className="staffmgr__modal-title">My Hours</h3>
          <button className="staffmgr__modal-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="staffmgr__modal-body myhours__body">
          <div className="myhours__range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                className={`myhours__range-btn${range === r.key ? " myhours__range-btn--active" : ""}`}
                onClick={() => setRange(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>

          {error && <div className="staffmgr__error">{error}</div>}

          {loading ? (
            <div className="staffmgr__notice">Loading…</div>
          ) : (
            <>
              <div className="myhours__total">
                <span className="myhours__total-label">Total — {range}</span>
                <span className="myhours__total-value">
                  {fmtDuration((data?.totalHours || 0) * 3600)}
                </span>
              </div>

              {!data?.shifts?.length ? (
                <div className="myhours__empty">No shifts in this range</div>
              ) : (
                <div className="myhours__list">
                  {data.shifts.map((s) => (
                    <div key={s.id} className="myhours__row">
                      <span className="myhours__row-date">{fmtDate(s.clockIn)}</span>
                      <span className="myhours__row-times">
                        {fmtTime(s.clockIn)} – {s.clockOut ? fmtTime(s.clockOut) : "In progress"}
                      </span>
                      <span className="myhours__row-dur">{fmtDuration(s.seconds)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
