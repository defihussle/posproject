import { useState, useEffect, useCallback } from "react";
import { API_URL } from "../config";
import "./HomeDashboard.css";

const RANGES = [
  { key: "today", label: "Today" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

const fmtMoney = (n) => `$${Number(n).toFixed(2)}`;

const LIVE_STATUS_POLL_MS = 5000; // same cadence KDS uses for its live order queue

function fmtSince(iso, nowMs) {
  const seconds = Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/**
 * Back Office → Home. Pure display — stat cards only, no editing controls.
 * Owner/admin only (StaffManager route is the manager's landing page instead).
 */
export default function HomeDashboard({ staff }) {
  const [range, setRange] = useState("today");
  const [summary, setSummary] = useState(null);
  const [topItems, setTopItems] = useState([]);
  const [staffPerf, setStaffPerf] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = `staffId=${staff.id}&range=${range}`;
      const [sumRes, topRes, perfRes] = await Promise.all([
        fetch(`${API_URL}/api/backoffice/stats/summary?${qs}`, { credentials: "include" }),
        fetch(`${API_URL}/api/backoffice/stats/top-items?${qs}&limit=5`, { credentials: "include" }),
        fetch(`${API_URL}/api/backoffice/stats/staff-performance?${qs}`, { credentials: "include" }),
      ]);
      const [sumData, topData, perfData] = await Promise.all([
        sumRes.json(),
        topRes.json(),
        perfRes.json(),
      ]);
      if (!sumRes.ok) throw new Error(sumData.error || `HTTP ${sumRes.status}`);
      if (!topRes.ok) throw new Error(topData.error || `HTTP ${topRes.status}`);
      if (!perfRes.ok) throw new Error(perfData.error || `HTTP ${perfRes.status}`);
      setSummary(sumData);
      setTopItems(topData);
      setStaffPerf(perfData);
      setError(null);
    } catch (err) {
      setError(err.message || "Failed to load dashboard stats");
    } finally {
      setLoading(false);
    }
  }, [staff.id, range]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="homedash">
      <div className="homedash__toolbar">
        <h2 className="homedash__title">Home</h2>
        <div className="homedash__range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className={`homedash__range-btn${range === r.key ? " homedash__range-btn--active" : ""}`}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        // A failed fetch must never look like "no sales today" — that was
        // the actual root cause of stats silently appearing not to load:
        // once loading finished, the cards had no way to distinguish
        // "genuinely empty range" from "the request never succeeded," and
        // defaulted to rendering the same calm empty-state copy either way.
        // This replaces the whole grid with an unmissable, actionable error
        // instead of three cards quietly lying about having real data.
        <div className="homedash__errorstate">
          <h3 className="homedash__errorstate-title">Couldn't load dashboard data</h3>
          <p className="homedash__errorstate-msg">{error}</p>
          <button className="homedash__errorstate-retry" onClick={load}>
            Try Again
          </button>
        </div>
      ) : (
        <div className="homedash__grid">
          <SalesCard summary={summary} loading={loading} />
          <TopSellersCard items={topItems} loading={loading} />
          <StaffPerformanceCard rows={staffPerf} loading={loading} />
          <LiveStatusCard />
        </div>
      )}
    </div>
  );
}

// Every currently-clocked-in staff member (any location), live. Polls
// independently of the Today/Week/Month range switcher above — this is
// real-time state, not a historical range. The clock-in/out actions
// themselves stay Order-Entry-only; this is read-only visibility into
// that same state, not a duplicate control surface.
function LiveStatusCard() {
  const [staffList, setStaffList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/backoffice/staff/live-status`, {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStaffList(data);
      setError(null);
    } catch (err) {
      setError(err.message || "Failed to load live status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, LIVE_STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // 1s tick so each "since" duration counts up smoothly between polls,
  // same pattern KDS uses for its elapsed timers.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <CardShell title="Live Status">
      {loading ? (
        <div className="homedash-card__notice">Loading…</div>
      ) : error ? (
        <div className="homedash-card__notice">{error}</div>
      ) : staffList.length === 0 ? (
        <div className="homedash-card__notice">No one clocked in right now</div>
      ) : (
        <ul className="homedash-list">
          {staffList.map((s) => (
            <li key={s.staffId} className="homedash-list__row">
              <span
                className={`homedash-live-dot homedash-live-dot--${s.status}`}
                aria-hidden="true"
              />
              <span className="homedash-list__name">{s.name}</span>
              <span className="homedash-list__sub">
                {s.status === "on_break" ? "On Break" : "Working"} · {fmtSince(s.since, nowMs)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}

function CardShell({ title, children, className = "" }) {
  return (
    <section className={`homedash-card${className ? ` ${className}` : ""}`}>
      <h3 className="homedash-card__title">{title}</h3>
      {children}
    </section>
  );
}

// The one number an owner opens this screen to see — given its own visually
// dominant row (full-width, larger type) rather than sitting as just
// another tile the same size as Top Sellers/Staff Performance/Live Status.
function SalesCard({ summary, loading }) {
  return (
    <CardShell title="Sales" className="homedash-card--hero">
      {loading || !summary ? (
        <div className="homedash-card__notice">Loading…</div>
      ) : (
        <>
          <div className="homedash-card__hero">{fmtMoney(summary.totalSales)}</div>
          <div className="homedash-card__stats">
            <div className="homedash-stat">
              <span className="homedash-stat__value">{summary.orderCount}</span>
              <span className="homedash-stat__label">orders</span>
            </div>
            <div className="homedash-stat">
              <span className="homedash-stat__value">{fmtMoney(summary.avgOrderValue)}</span>
              <span className="homedash-stat__label">avg order</span>
            </div>
            <div className="homedash-stat">
              <span className="homedash-stat__value">{fmtMoney(summary.totalTips)}</span>
              <span className="homedash-stat__label">total tips</span>
            </div>
          </div>
        </>
      )}
    </CardShell>
  );
}

function TopSellersCard({ items, loading }) {
  return (
    <CardShell title="Top Sellers">
      {loading ? (
        <div className="homedash-card__notice">Loading…</div>
      ) : items.length === 0 ? (
        <div className="homedash-card__notice">No sales in this range</div>
      ) : (
        <ol className="homedash-list">
          {items.map((it, i) => (
            <li key={`${it.item_id}-${it.variant || ""}`} className="homedash-list__row">
              <span className="homedash-list__rank">{i + 1}</span>
              <span className="homedash-list__name">
                {it.name}
                {it.variant && <span className="homedash-list__variant"> · {it.variant}</span>}
              </span>
              <span className="homedash-list__value">{it.quantity}</span>
            </li>
          ))}
        </ol>
      )}
    </CardShell>
  );
}

function StaffPerformanceCard({ rows, loading }) {
  return (
    <CardShell title="Staff Performance">
      {loading ? (
        <div className="homedash-card__notice">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="homedash-card__notice">No orders in this range</div>
      ) : (
        <ul className="homedash-list">
          {rows.map((r) => (
            <li key={r.staff_id} className="homedash-list__row">
              <span className="homedash-list__name">{r.name}</span>
              <span className="homedash-list__sub">{r.orderCount} orders</span>
              <span className="homedash-list__value">{fmtMoney(r.totalSales)}</span>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}
