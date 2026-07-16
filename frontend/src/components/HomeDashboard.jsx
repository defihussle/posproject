import { useState, useEffect, useCallback } from "react";
import { API_URL } from "../config";
import "./HomeDashboard.css";

const RANGES = [
  { key: "today", label: "Today" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

const fmtMoney = (n) => `$${Number(n).toFixed(2)}`;

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
        fetch(`${API_URL}/api/backoffice/stats/summary?${qs}`),
        fetch(`${API_URL}/api/backoffice/stats/top-items?${qs}&limit=5`),
        fetch(`${API_URL}/api/backoffice/stats/staff-performance?${qs}`),
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

      {error && <div className="homedash__error">{error}</div>}

      <div className="homedash__grid">
        <SalesCard summary={summary} loading={loading} />
        <TopSellersCard items={topItems} loading={loading} />
        <StaffPerformanceCard rows={staffPerf} loading={loading} />
      </div>
    </div>
  );
}

function CardShell({ title, children }) {
  return (
    <section className="homedash-card">
      <h3 className="homedash-card__title">{title}</h3>
      {children}
    </section>
  );
}

function SalesCard({ summary, loading }) {
  return (
    <CardShell title="Sales">
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
