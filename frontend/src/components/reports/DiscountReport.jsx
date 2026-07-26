import { useState, useEffect, useCallback } from "react";
import { API_URL } from "../../config";
import { exportCsv, exportPdf, reportFilename } from "../reportExport";

// Discount Report body — the comp audit. Two grains over one period:
//   1. per-reason rollup (Reason | Orders | Discount | % of Sales)
//   2. per-order detail (Order # | Date/Time | Subtotal | Discount | % |
//      Reason | Applied by) — the line that justifies each comp.
// Data from GET /api/backoffice/reports/discounts. `range` is the resolved
// { start, end, label } from the shell's period selector. No period-over-
// period comparison here (the plan defines this report as rollup + detail
// only — the audit question is "who comped what", not "vs last month").

const fmtMoney = (n) =>
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (n) => `${Number(n).toFixed(1)}%`;
const REASON_LABELS = {
  family: "Family",
  friend: "Friend",
  employee: "Employee",
  neighbouring_store: "Neighbouring store",
};
const reasonLabel = (r) => (r ? REASON_LABELS[r] || r : "—");
const fmtDateTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

export default function DiscountReport({ range }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!range?.start || !range?.end) return;
    setLoading(true);
    try {
      const res = await fetch(
        `${API_URL}/api/backoffice/reports/discounts?start=${range.start}&end=${range.end}`,
        { credentials: "include" }
      );
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e.message || "Failed to load discount report");
    } finally {
      setLoading(false);
    }
  }, [range?.start, range?.end]);

  useEffect(() => {
    load();
  }, [load]);

  const byReason = data?.byReason || [];
  const orders = data?.orders || [];
  const subtitle = range?.label || `${range?.start} → ${range?.end}`;
  const hasData = data && orders.length > 0;

  // --- Export: rollup as the leading section, per-order detail as the main
  // table, so one file carries both grains (matches the screen). ---
  const reasonExport = () => ({
    title: "By reason",
    headers: ["Reason", "Orders", "Discount", "% of Sales"],
    rows: byReason.map((r) => [
      reasonLabel(r.reason),
      String(r.orders),
      r.amount.toFixed(2),
      r.pctOfSales.toFixed(1),
    ]),
    footer: [
      "Total",
      String(data.discountedOrders),
      data.discountTotal.toFixed(2),
      data.pctOfSales.toFixed(1),
    ],
  });

  const detailHeaders = ["Order #", "Date/Time", "Subtotal", "Discount", "%", "Reason", "Applied by"];
  const detailRows = () =>
    orders.map((o) => [
      o.orderNumber,
      o.completedAt,
      o.subtotal.toFixed(2),
      o.discount.toFixed(2),
      o.discountPercent == null ? "" : o.discountPercent.toFixed(0),
      reasonLabel(o.discountReason),
      o.appliedBy || "",
    ]);
  const detailFooter = [
    "Total",
    "",
    "",
    data ? data.discountTotal.toFixed(2) : "",
    "",
    "",
    "",
  ];

  const doCsv = () =>
    exportCsv({
      filename: reportFilename("discounts", range.start, range.end, "csv"),
      title: `Discount Report — ${subtitle}`,
      preSection: reasonExport(),
      tableTitle: "Per-order detail",
      headers: detailHeaders,
      rows: detailRows(),
      footer: detailFooter,
    });

  const doPdf = () =>
    exportPdf({
      filename: reportFilename("discounts", range.start, range.end, "pdf"),
      title: "Discount Report",
      subtitle,
      preTable: {
        title: "By reason",
        headers: ["Reason", "Orders", "Discount", "% of Sales"],
        rows: byReason.map((r) => [
          reasonLabel(r.reason),
          String(r.orders),
          fmtMoney(r.amount),
          fmtPct(r.pctOfSales),
        ]),
        foot: [
          "Total",
          String(data.discountedOrders),
          fmtMoney(data.discountTotal),
          fmtPct(data.pctOfSales),
        ],
      },
      tableTitle: "Per-order detail",
      headers: detailHeaders,
      rows: detailRows(),
    });

  return (
    <div className="reports__report">
      <div className="reports__report-head">
        <h3 className="reports__report-title">Discount Report</h3>
        <div className="reports__exports">
          <button className="reports__exportbtn" onClick={doCsv} disabled={!hasData}>
            Export CSV
          </button>
          <button className="reports__exportbtn" onClick={doPdf} disabled={!hasData}>
            Export PDF
          </button>
        </div>
      </div>

      {error ? (
        <div className="reports__errorstate">
          <p className="reports__errorstate-msg">{error}</p>
          <button className="reports__exportbtn" onClick={load}>
            Try Again
          </button>
        </div>
      ) : loading ? (
        <div className="reports__tablewrap">
          <div className="reports__coming">Loading…</div>
        </div>
      ) : !hasData ? (
        <div className="reports__tablewrap">
          <div className="reports__coming">No discounts applied in this period.</div>
        </div>
      ) : (
        <>
          {/* Headline: total comped + share of gross sales */}
          <div className="reports__logbar">
            <div className="reports__logbar-main">
              <span className="reports__logbar-total">{fmtMoney(data.discountTotal)} discounted</span>
              <span className="reports__logbar-sep">·</span>
              <span className="reports__logbar-count">
                {data.discountedOrders} order{data.discountedOrders === 1 ? "" : "s"}
              </span>
              <span className="reports__logbar-sep">·</span>
              <span
                className="reports__logbar-count"
                title={`Of ${fmtMoney(data.grossSales)} gross sales`}
              >
                {fmtPct(data.pctOfSales)} of sales
              </span>
            </div>
          </div>

          {/* Part 1 — per-reason rollup */}
          <div className="reports__submeta">
            <div className="reports__submeta-head">
              <h4 className="reports__submeta-title">By Reason</h4>
            </div>
            <div className="reports__tablewrap">
              <table className="reports__table">
                <thead>
                  <tr>
                    <th>Reason</th>
                    <th className="reports__num">Orders</th>
                    <th className="reports__num">Discount</th>
                    <th className="reports__num">% of Sales</th>
                  </tr>
                </thead>
                <tbody>
                  {byReason.map((r) => (
                    <tr key={r.reason}>
                      <td>{reasonLabel(r.reason)}</td>
                      <td className="reports__num">{r.orders}</td>
                      <td className="reports__num">−{fmtMoney(r.amount)}</td>
                      <td className="reports__num">{fmtPct(r.pctOfSales)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="reports__row--total">
                    <td>Total</td>
                    <td className="reports__num">{data.discountedOrders}</td>
                    <td className="reports__num">−{fmtMoney(data.discountTotal)}</td>
                    <td className="reports__num">{fmtPct(data.pctOfSales)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Part 2 — per-order detail (the audit line) */}
          <div className="reports__submeta">
            <div className="reports__submeta-head">
              <h4 className="reports__submeta-title">Per-Order Detail</h4>
            </div>
            <div className="reports__tablewrap">
              <table className="reports__table reports__table--log">
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Date/Time</th>
                    <th className="reports__num">Subtotal</th>
                    <th className="reports__num">Discount</th>
                    <th className="reports__num">%</th>
                    <th>Reason</th>
                    <th>Applied by</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.orderNumber}>
                      <td className="reports__mono">#{o.orderNumber}</td>
                      <td>{fmtDateTime(o.completedAt)}</td>
                      <td className="reports__num">{fmtMoney(o.subtotal)}</td>
                      <td className="reports__num reports__strong-cell">−{fmtMoney(o.discount)}</td>
                      <td className="reports__num">
                        {o.discountPercent == null ? "—" : `${o.discountPercent.toFixed(0)}%`}
                      </td>
                      <td className="reports__reason">{reasonLabel(o.discountReason)}</td>
                      <td>{o.appliedBy || "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="reports__row--total">
                    <td colSpan={3}>Total ({data.discountedOrders})</td>
                    <td className="reports__num">−{fmtMoney(data.discountTotal)}</td>
                    <td />
                    <td />
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
