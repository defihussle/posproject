import { useState, useEffect, useCallback, useMemo } from "react";
import { API_URL } from "../config";
import "./HomeDashboard.css";

// Preset ranges map 1:1 to the backend's resolveStatsRange. "custom" is a
// UI-only option for now — the stats endpoints don't accept start/end yet,
// so selecting it shows the date pickers + a "coming next" note rather than
// firing a request the backend would 400. (Backend custom-range support is
// the next phase — see the endpoint plan.)
const RANGES = [
  { key: "today", label: "Today" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
  { key: "custom", label: "Custom" },
];

const LIVE_STATUS_POLL_MS = 5000;

const fmtMoney = (n) =>
  `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt = (n) => Number(n || 0).toLocaleString();
const fmtPct = (n) => `${Number(n || 0).toFixed(1)}%`;
const fmtHour = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "a" : "p"}`; // 15 -> "3p"
const fmtHourLong = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`; // 15 -> "3 PM"

function fmtSince(iso, nowMs) {
  const seconds = Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}

/**
 * Back Office → Home. A glanceable, mobile-first stats dashboard
 * (Clover/Square/Toast-inspired, tailored to this restaurant). Owner/admin
 * only. Layout: top bar (range + comparison) → horizontally-scrolling KPI
 * strip → a responsive grid of section cards (charts, breakdowns, lists).
 *
 * This pass establishes the full UI structure. KPIs, the discount total,
 * top items, staff performance, and live status are wired to real data;
 * the four trend/breakdown charts and the per-reason discount / labor /
 * hours columns are scaffolded, awaiting their backend routes (see the
 * endpoint plan). Each scaffolded card shows a labelled "pending" state,
 * never fake data.
 */
export default function HomeDashboard({ staff }) {
  const [range, setRange] = useState("today");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [compare, setCompare] = useState(false);

  const [summary, setSummary] = useState(null);
  const [topItems, setTopItems] = useState([]);
  const [staffPerf, setStaffPerf] = useState([]);
  const [hourly, setHourly] = useState([]);
  const [trend, setTrend] = useState([]);
  const [trendMode, setTrendMode] = useState("hourly"); // Sales Trend Hourly/Daily toggle
  const [trendLoading, setTrendLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const isCustom = range === "custom";

  const load = useCallback(async () => {
    // Custom range has no backend support yet — don't fire a request the
    // server would reject; the sections render their pending state instead.
    if (range === "custom") {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const qs = `staffId=${staff.id}&range=${range}`;
      const [sumRes, topRes, perfRes, hourRes] = await Promise.all([
        fetch(`${API_URL}/api/backoffice/stats/summary?${qs}`, { credentials: "include" }),
        fetch(`${API_URL}/api/backoffice/stats/top-items?${qs}&limit=5`, { credentials: "include" }),
        fetch(`${API_URL}/api/backoffice/stats/staff-performance?${qs}`, { credentials: "include" }),
        fetch(`${API_URL}/api/backoffice/stats/hourly?${qs}`, { credentials: "include" }),
      ]);
      const [sumData, topData, perfData, hourData] = await Promise.all([
        sumRes.json(),
        topRes.json(),
        perfRes.json(),
        hourRes.json(),
      ]);
      if (!sumRes.ok) throw new Error(sumData.error || `HTTP ${sumRes.status}`);
      if (!topRes.ok) throw new Error(topData.error || `HTTP ${topRes.status}`);
      if (!perfRes.ok) throw new Error(perfData.error || `HTTP ${perfRes.status}`);
      if (!hourRes.ok) throw new Error(hourData.error || `HTTP ${hourRes.status}`);
      setSummary(sumData);
      setTopItems(topData);
      setStaffPerf(perfData);
      setHourly(hourData);
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

  // Sales Trend has its own fetch — it depends on the Hourly/Daily toggle as
  // well as the range, and shouldn't refetch the whole dashboard when the
  // toggle flips. Errors here are non-fatal to the rest of the dashboard:
  // the trend card falls back to its own empty state rather than blanking
  // every card, so one endpoint hiccup doesn't take the page down.
  useEffect(() => {
    if (isCustom) {
      setTrendLoading(false);
      return;
    }
    let cancelled = false;
    setTrendLoading(true);
    const gran = trendMode === "daily" ? "day" : "hour";
    fetch(`${API_URL}/api/backoffice/stats/trend?staffId=${staff.id}&range=${range}&granularity=${gran}`, {
      credentials: "include",
    })
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
        return Array.isArray(data) ? data : [];
      })
      .then((data) => {
        if (!cancelled) setTrend(data);
      })
      .catch(() => {
        if (!cancelled) setTrend([]);
      })
      .finally(() => {
        if (!cancelled) setTrendLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [staff.id, range, trendMode, isCustom]);

  // KPI definitions — real values from the (extended) summary endpoint;
  // Labor % awaits the labor endpoint. `delta` stays null until the
  // comparison endpoint lands, so the arrow simply doesn't render yet.
  const kpis = useMemo(
    () => [
      { key: "gross", label: "Gross Sales", value: summary ? fmtMoney(summary.grossSales) : null, delta: null },
      { key: "net", label: "Net Sales", value: summary ? fmtMoney(summary.netSales) : null, delta: null, hint: "after discounts" },
      { key: "orders", label: "Orders", value: summary ? fmtInt(summary.orderCount) : null, delta: null },
      { key: "aov", label: "Avg Order", value: summary ? fmtMoney(summary.avgOrderValue) : null, delta: null },
      { key: "tips", label: "Total Tips", value: summary ? fmtMoney(summary.totalTips) : null, delta: null },
      { key: "labor", label: "Labor Cost %", value: null, delta: null, pending: true },
    ],
    [summary]
  );

  return (
    <div className="homedash">
      <TopBar
        range={range}
        onRange={setRange}
        isCustom={isCustom}
        customStart={customStart}
        customEnd={customEnd}
        onCustomStart={setCustomStart}
        onCustomEnd={setCustomEnd}
        compare={compare}
        onCompare={setCompare}
      />

      {error ? (
        <div className="homedash__errorstate">
          <h3 className="homedash__errorstate-title">Couldn't load dashboard data</h3>
          <p className="homedash__errorstate-msg">{error}</p>
          <button className="homedash__errorstate-retry" onClick={load}>
            Try Again
          </button>
        </div>
      ) : (
        <>
          {isCustom && (
            <div className="homedash__note">
              Custom date ranges arrive with the next backend update — the pickers above are ready to wire in.
            </div>
          )}

          <KpiStrip kpis={kpis} compare={compare} loading={loading && !isCustom} pending={isCustom} />

          <div className="homedash__sections">
            <SalesTrendCard trend={trend} mode={trendMode} onMode={setTrendMode} loading={trendLoading} pending={isCustom} />
            <HourlyBreakdownCard data={hourly} loading={loading} pending={isCustom} />
            <CategorySalesCard loading={loading} pending={isCustom} />
            <LaborVsSalesCard loading={loading} pending={isCustom} />
            <DiscountReportCard summary={summary} loading={loading && !isCustom} pending={isCustom} />
            <TopItemsCard items={topItems} loading={loading && !isCustom} pending={isCustom} />
            <StaffPerformanceCard rows={staffPerf} loading={loading && !isCustom} pending={isCustom} />
            <LiveStatusCard />
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- Top bar ---------------- */
function TopBar({ range, onRange, isCustom, customStart, customEnd, onCustomStart, onCustomEnd, compare, onCompare }) {
  return (
    <div className="homedash__topbar">
      <div className="homedash__topbar-row">
        <h2 className="homedash__title">Dashboard</h2>
        <button
          type="button"
          className={`homedash__compare${compare ? " homedash__compare--on" : ""}`}
          onClick={() => onCompare(!compare)}
          aria-pressed={compare}
        >
          <span className="homedash__compare-track"><span className="homedash__compare-thumb" /></span>
          vs Last Period
        </button>
      </div>

      <div className="homedash__ranges" role="tablist" aria-label="Date range">
        {RANGES.map((r) => (
          <button
            key={r.key}
            role="tab"
            aria-selected={range === r.key}
            className={`homedash__range-btn${range === r.key ? " homedash__range-btn--active" : ""}`}
            onClick={() => onRange(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {isCustom && (
        <div className="homedash__custom">
          <label className="homedash__custom-field">
            <span>From</span>
            <input type="date" value={customStart} onChange={(e) => onCustomStart(e.target.value)} />
          </label>
          <label className="homedash__custom-field">
            <span>To</span>
            <input type="date" value={customEnd} onChange={(e) => onCustomEnd(e.target.value)} />
          </label>
        </div>
      )}
    </div>
  );
}

/* ---------------- KPI strip ---------------- */
function KpiStrip({ kpis, compare, loading, pending }) {
  return (
    <div className="homedash__kpis">
      {kpis.map((k) => (
        <KpiCard key={k.key} kpi={k} compare={compare} loading={loading} pending={pending} />
      ))}
    </div>
  );
}

function KpiCard({ kpi, compare, loading, pending }) {
  const showValue = !loading && !pending && !kpi.pending && kpi.value != null;
  return (
    <div className="homedash-kpi">
      <div className="homedash-kpi__label">{kpi.label}</div>
      {showValue ? (
        <div className="homedash-kpi__value">{kpi.value}</div>
      ) : (
        <div className={`homedash-kpi__value homedash-kpi__value--muted`}>
          {kpi.pending ? "—" : pending ? "—" : loading ? "" : "—"}
        </div>
      )}
      {kpi.hint && <div className="homedash-kpi__hint">{kpi.hint}</div>}
      {/* Delta — arrow + status color, never color alone (accessibility). Renders
          only once the comparison endpoint provides a previous-period number. */}
      {compare && (
        <div className="homedash-kpi__delta homedash-kpi__delta--pending">
          {kpi.delta == null ? "— vs last period" : <Delta value={kpi.delta} />}
        </div>
      )}
      {kpi.pending && <div className="homedash-kpi__badge">Soon</div>}
    </div>
  );
}

function Delta({ value }) {
  const up = value >= 0;
  return (
    <span className={`homedash-delta homedash-delta--${up ? "up" : "down"}`}>
      <span aria-hidden="true">{up ? "▲" : "▼"}</span> {Math.abs(value).toFixed(1)}%
    </span>
  );
}

/* ---------------- Section shell ---------------- */
function SectionCard({ title, actions, wide, children }) {
  return (
    <section className={`homedash-card${wide ? " homedash-card--wide" : ""}`}>
      <div className="homedash-card__head">
        <h3 className="homedash-card__title">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

// Skeleton bars used while a chart's backend route is still pending, so the
// card reads as "chart here, data coming" rather than broken/empty.
function ChartPending({ shape = "bars", note }) {
  return (
    <div className="homedash-pending">
      {shape === "bars" ? (
        <div className="homedash-pending__bars" aria-hidden="true">
          {[42, 68, 55, 80, 48, 72, 60].map((h, i) => (
            <span key={i} style={{ height: `${h}%` }} />
          ))}
        </div>
      ) : (
        <div className="homedash-pending__line" aria-hidden="true" />
      )}
      <div className="homedash-pending__note">{note}</div>
    </div>
  );
}

/* ---------------- Inline SVG charts ----------------
   Both are single-series (sales), so per the dataviz method: line for
   change-over-time, bar for magnitude, one brand hue (no categorical
   palette to validate), recessive axes, ink-token text, and a hover layer.
   viewBox coordinates scale to the container width; strokes stay crisp via
   vector-effect (see CSS). */
const CHART_W = 640;
const CHART_H = 200;

function LineChart({ data }) {
  const [hover, setHover] = useState(null); // { idx, px }
  const padL = 6, padR = 6, padT = 14, padB = 22;
  const n = data.length;
  const innerW = CHART_W - padL - padR;
  const innerH = CHART_H - padT - padB;
  const maxSales = Math.max(1, ...data.map((d) => d.sales));
  const xAt = (i) => (n <= 1 ? padL + innerW / 2 : padL + (i / (n - 1)) * innerW);
  const yAt = (v) => padT + innerH - (v / maxSales) * innerH;
  const line = data.map((d, i) => `${xAt(i).toFixed(1)},${yAt(d.sales).toFixed(1)}`).join(" ");
  const area = `${padL},${(padT + innerH).toFixed(1)} ${line} ${xAt(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)}`;
  const gridY = [0.25, 0.5, 0.75, 1].map((f) => padT + innerH - f * innerH);
  const labelEvery = Math.max(1, Math.ceil(n / 6));

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover({ idx: Math.round(frac * (n - 1)), px: e.clientX - rect.left });
  };
  const hv = hover ? data[hover.idx] : null;

  return (
    <div className="homedash-chart" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="homedash-chart__svg" role="img" aria-label="Sales trend over time">
        {gridY.map((y, i) => (
          <line key={i} x1={padL} x2={CHART_W - padR} y1={y} y2={y} className="homedash-chart__grid" />
        ))}
        <polygon points={area} className="homedash-chart__area" />
        <polyline points={line} className="homedash-chart__line" />
        {hv && (
          <>
            <line x1={xAt(hover.idx)} x2={xAt(hover.idx)} y1={padT} y2={padT + innerH} className="homedash-chart__crosshair" />
            <circle cx={xAt(hover.idx)} cy={yAt(hv.sales)} r="5" className="homedash-chart__dot" />
          </>
        )}
      </svg>
      <div className="homedash-chart__xlabels">
        {data.map((d, i) =>
          i % labelEvery === 0 || i === n - 1 ? (
            <span key={i} style={{ left: `${(xAt(i) / CHART_W) * 100}%` }}>{d.label}</span>
          ) : null
        )}
      </div>
      {hv && (
        <div className="homedash-chart__tip" style={{ left: `${hover.px}px` }}>
          <div className="homedash-chart__tip-label">{hv.label}</div>
          <div className="homedash-chart__tip-val">{fmtMoney(hv.sales)}</div>
          <div className="homedash-chart__tip-sub">{fmtInt(hv.orders)} orders</div>
        </div>
      )}
    </div>
  );
}

function BarChart({ data }) {
  const [hover, setHover] = useState(null); // { idx, px }
  const padT = 14, padB = 20, padX = 6;
  const n = data.length;
  const innerW = CHART_W - 2 * padX;
  const innerH = CHART_H - padT - padB;
  const maxV = Math.max(1, ...data.map((d) => d.value));
  const band = innerW / n;
  const barW = Math.max(3, Math.min(band - 6, 48));
  const xAt = (i) => padX + i * band + (band - barW) / 2;
  const labelEvery = n > 14 ? 2 : 1;

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(0.9999, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover({ idx: Math.floor(frac * n), px: e.clientX - rect.left });
  };
  const hv = hover ? data[hover.idx] : null;

  return (
    <div className="homedash-chart" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="homedash-chart__svg" role="img" aria-label="Sales by hour of day">
        <line x1={padX} x2={CHART_W - padX} y1={padT + innerH} y2={padT + innerH} className="homedash-chart__grid" />
        {data.map((d, i) => {
          const bh = (d.value / maxV) * innerH;
          return (
            <rect
              key={i}
              x={xAt(i)}
              y={padT + innerH - bh}
              width={barW}
              height={Math.max(bh, 0.5)}
              rx="4"
              className={`homedash-chart__bar${hover && hover.idx === i ? " homedash-chart__bar--hover" : ""}`}
            />
          );
        })}
      </svg>
      <div className="homedash-chart__xlabels">
        {data.map((d, i) =>
          i % labelEvery === 0 ? (
            <span key={i} style={{ left: `${((xAt(i) + barW / 2) / CHART_W) * 100}%` }}>{d.label}</span>
          ) : null
        )}
      </div>
      {hv && (
        <div className="homedash-chart__tip" style={{ left: `${hover.px}px` }}>
          <div className="homedash-chart__tip-label">{fmtHourLong(hv.hour)}</div>
          <div className="homedash-chart__tip-val">{fmtMoney(hv.sales)}</div>
          <div className="homedash-chart__tip-sub">
            {fmtInt(hv.orders)} orders · {hv.orders > 0 ? `${fmtMoney(hv.avg)} avg` : "—"}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Sales Trend (line) ---------------- */
function SalesTrendCard({ trend, mode, onMode, loading, pending }) {
  const hasData = trend.some((d) => d.sales > 0);
  return (
    <SectionCard
      title="Sales Trend"
      wide
      actions={
        <div className="homedash-toggle">
          {[["hourly", "Hourly"], ["daily", "Daily"]].map(([m, label]) => (
            <button
              key={m}
              className={`homedash-toggle__btn${mode === m ? " homedash-toggle__btn--active" : ""}`}
              onClick={() => onMode(m)}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      {pending ? (
        <ChartPending shape="line" note="Select a preset range" />
      ) : loading ? (
        <div className="homedash-card__notice">Loading…</div>
      ) : !hasData ? (
        <div className="homedash-card__notice">No sales in this range</div>
      ) : (
        <LineChart data={trend} />
      )}
    </SectionCard>
  );
}

/* ---------------- Hourly Breakdown (bar + table) ---------------- */
function HourlyBreakdownCard({ data, loading, pending }) {
  // Trim the gap-filled 24h series to the active operating window so the
  // chart/table aren't padded with dead overnight hours.
  const active = useMemo(() => {
    const idx = data.map((d, i) => (d.orders > 0 ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 0) return [];
    return data.slice(idx[0], idx[idx.length - 1] + 1);
  }, [data]);

  return (
    <SectionCard title="Hourly Breakdown" wide>
      {pending ? (
        <ChartPending shape="bars" note="Select a preset range" />
      ) : loading ? (
        <div className="homedash-card__notice">Loading…</div>
      ) : active.length === 0 ? (
        <div className="homedash-card__notice">No sales in this range</div>
      ) : (
        <>
          <BarChart
            data={active.map((d) => ({ label: fmtHour(d.hour), value: d.sales, hour: d.hour, orders: d.orders, sales: d.sales, avg: d.avg }))}
          />
          <div className="homedash-table">
            <div className="homedash-table__head">
              <span>Hour</span><span>Orders</span><span>Sales</span><span>Avg</span>
            </div>
            {active.map((d) => (
              <div key={d.hour} className="homedash-table__row">
                <span className="homedash-table__name">{fmtHourLong(d.hour)}</span>
                <span className="homedash-num">{fmtInt(d.orders)}</span>
                <span className="homedash-num">{fmtMoney(d.sales)}</span>
                <span className="homedash-num">{d.orders > 0 ? fmtMoney(d.avg) : "—"}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </SectionCard>
  );
}

function CategorySalesCard({ pending }) {
  return (
    <SectionCard title="Category Sales">
      <ChartPending shape="bars" note={pending ? "Select a preset range" : "Sales by category — needs the category endpoint"} />
    </SectionCard>
  );
}

function LaborVsSalesCard({ pending }) {
  return (
    <SectionCard title="Labor Cost %">
      <ChartPending shape="line" note={pending ? "Select a preset range" : "Labor cost as % of sales — needs the labor endpoint"} />
    </SectionCard>
  );
}

/* ---------------- Discount report (total is real; per-reason pending) ---------------- */
function DiscountReportCard({ summary, loading, pending }) {
  const pctOfGross = summary && summary.grossSales > 0 ? (summary.discountTotal / summary.grossSales) * 100 : 0;
  return (
    <SectionCard title="Discount Report">
      {loading || pending ? (
        <div className="homedash-card__notice">{pending ? "Select a preset range" : "Loading…"}</div>
      ) : (
        <div className="homedash-table">
          <div className="homedash-table__head">
            <span>Reason</span><span>Amount</span><span>% of Sales</span>
          </div>
          <div className="homedash-table__row">
            <span>All discounts</span>
            <span className="homedash-num">{fmtMoney(summary?.discountTotal)}</span>
            <span className="homedash-num">{fmtPct(pctOfGross)}</span>
          </div>
          <div className="homedash-table__note">Per-reason breakdown (family / friend / employee / neighbouring store) arrives with the discount endpoint.</div>
        </div>
      )}
    </SectionCard>
  );
}

/* ---------------- Top items (real) ---------------- */
function TopItemsCard({ items, loading, pending }) {
  return (
    <SectionCard title="Top 5 Items">
      {loading || pending ? (
        <div className="homedash-card__notice">{pending ? "Select a preset range" : "Loading…"}</div>
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
              <span className="homedash-list__value">×{it.quantity}</span>
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

/* ---------------- Staff performance (orders/sales real; hours pending) ---------------- */
function StaffPerformanceCard({ rows, loading, pending }) {
  return (
    <SectionCard title="Staff Performance" wide>
      {loading || pending ? (
        <div className="homedash-card__notice">{pending ? "Select a preset range" : "Loading…"}</div>
      ) : rows.length === 0 ? (
        <div className="homedash-card__notice">No orders in this range</div>
      ) : (
        <div className="homedash-table">
          <div className="homedash-table__head">
            <span>Name</span><span>Orders</span><span>Sales</span><span>Hours</span>
          </div>
          {rows.map((r) => (
            <div key={r.staff_id} className="homedash-table__row">
              <span className="homedash-table__name">{r.name}</span>
              <span className="homedash-num">{fmtInt(r.orderCount)}</span>
              <span className="homedash-num">{fmtMoney(r.totalSales)}</span>
              <span className="homedash-num homedash-num--muted">—</span>
            </div>
          ))}
          <div className="homedash-table__note">Hours column fills in with the labor/shifts endpoint.</div>
        </div>
      )}
    </SectionCard>
  );
}

/* ---------------- Live status (real, keep) ---------------- */
function LiveStatusCard() {
  const [staffList, setStaffList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/backoffice/staff/live-status`, { credentials: "include" });
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

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <SectionCard title="Live Status">
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
              <span className={`homedash-live-dot homedash-live-dot--${s.status}`} aria-hidden="true" />
              <span className="homedash-list__name">{s.name}</span>
              <span className="homedash-list__sub">
                {s.status === "on_break" ? "On Break" : "Working"} · {fmtSince(s.since, nowMs)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
