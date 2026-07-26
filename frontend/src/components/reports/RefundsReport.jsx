import { useState, useEffect, useCallback } from "react";
import { API_URL } from "../../config";
import { exportCsv, exportPdf, reportFilename } from "../reportExport";

// Refunds Report body — the reversal audit. Every void + refund in the period,
// two grains like the Discount Report:
//   1. per-reason rollup (Reason | Count | Amount | % of Sales)
//   2. per-reversal detail (Order # | Date/Time | Type | Amount | Tax | Reason
//      | Requested by | Approved by | Method) — the line that justifies each
//      reversal (who asked, who approved — the dual-control trail).
// Data from GET /api/backoffice/reports/refunds. `range` is the resolved
// { start, end, label } from the shared layout. Scoped by when the reversal
// happened (activity view), distinct from Sales Summary / Transaction Log.

const fmtMoney = (n) =>
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (n) => `${Number(n).toFixed(1)}%`;
const REASON_LABELS = {
  wrong_order: "Wrong order",
  kitchen_error: "Kitchen error",
  quality_issue: "Quality issue",
  customer_cancelled: "Customer cancelled",
  overcharge: "Overcharge",
  duplicate: "Duplicate",
  other: "Other",
};
const METHOD_LABELS = { cash: "Cash", card: "Card", gift_card: "Gift Card", other: "Other" };
const reasonLabel = (r) => (r ? REASON_LABELS[r] || r : "—");
const typeLabel = (t) => (t === "void" ? "Void" : "Refund");
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

export default function RefundsReport({ range }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!range?.start || !range?.end) return;
    setLoading(true);
    try {
      const res = await fetch(
        `${API_URL}/api/backoffice/reports/refunds?start=${range.start}&end=${range.end}`,
        { credentials: "include" }
      );
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e.message || "Failed to load refunds report");
    } finally {
      setLoading(false);
    }
  }, [range?.start, range?.end]);

  useEffect(() => {
    load();
  }, [load]);

  const byReason = data?.byReason || [];
  const refunds = data?.refunds || [];
  const subtitle = range?.label || `${range?.start} → ${range?.end}`;
  const hasData = data && refunds.length > 0;

  // --- Export: rollup as the leading section, per-reversal detail as the main
  // table, so one file carries both grains (matches the screen). ---
  const reasonExport = () => ({
    title: "By reason",
    headers: ["Reason", "Count", "Amount", "% of Sales"],
    rows: byReason.map((r) => [
      reasonLabel(r.reason),
      String(r.count),
      r.amount.toFixed(2),
      r.pctOfSales.toFixed(1),
    ]),
    footer: ["Total", String(data.reversedCount), data.reversedTotal.toFixed(2), data.pctOfSales.toFixed(1)],
  });

  const detailHeaders = [
    "Order #", "Date/Time", "Type", "Amount", "Tax", "Reason",
    "Requested by", "Approved by", "Method", "Stripe refund ID",
  ];
  const detailRows = () =>
    refunds.map((r) => [
      r.orderNumber,
      r.createdAt,
      typeLabel(r.type),
      r.amount.toFixed(2),
      r.taxAmount.toFixed(2),
      reasonLabel(r.reason) + (r.reason === "other" && r.reasonNote ? ` — ${r.reasonNote}` : ""),
      r.requestedBy || "",
      r.approvedBy || "",
      METHOD_LABELS[r.method] || r.method || "",
      r.stripeRefundId || "",
    ]);
  const detailFooter = data
    ? ["Total", "", "", data.reversedTotal.toFixed(2), "", "", "", "", "", ""]
    : null;

  const doCsv = () =>
    exportCsv({
      filename: reportFilename("refunds", range.start, range.end, "csv"),
      title: `Refunds Report — ${subtitle}`,
      preSection: reasonExport(),
      tableTitle: "Reversal detail",
      headers: detailHeaders,
      rows: detailRows(),
      footer: detailFooter,
    });

  const doPdf = () =>
    exportPdf({
      filename: reportFilename("refunds", range.start, range.end, "pdf"),
      title: "Refunds Report",
      subtitle,
      preTable: {
        title: "By reason",
        headers: ["Reason", "Count", "Amount", "% of Sales"],
        rows: byReason.map((r) => [
          reasonLabel(r.reason),
          String(r.count),
          fmtMoney(r.amount),
          fmtPct(r.pctOfSales),
        ]),
        foot: ["Total", String(data.reversedCount), fmtMoney(data.reversedTotal), fmtPct(data.pctOfSales)],
      },
      tableTitle: "Reversal detail",
      headers: detailHeaders,
      rows: detailRows(),
    });

  return (
    <div className="reports__report">
      <div className="reports__report-head">
        <h3 className="reports__report-title">Refunds Report</h3>
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
          <div className="reports__coming">No refunds or voids in this period.</div>
        </div>
      ) : (
        <>
          {/* Headline: total reversed + share of gross sales, refund/void split */}
          <div className="reports__logbar">
            <div className="reports__logbar-main">
              <span className="reports__logbar-total">{fmtMoney(data.reversedTotal)} reversed</span>
              <span className="reports__logbar-sep">·</span>
              <span className="reports__logbar-count">
                {data.reversedCount} reversal{data.reversedCount === 1 ? "" : "s"}
              </span>
              <span className="reports__logbar-sep">·</span>
              <span className="reports__logbar-count" title={`Of ${fmtMoney(data.grossSales)} gross sales`}>
                {fmtPct(data.pctOfSales)} of sales
              </span>
            </div>
            <div className="reports__logbar-cmp">
              <span className="reports__cmp-label">
                {data.refundCount} refund{data.refundCount === 1 ? "" : "s"} ({fmtMoney(data.refundTotal)})
              </span>
              <span className="reports__logbar-sep">·</span>
              <span className="reports__cmp-label">
                {data.voidCount} void{data.voidCount === 1 ? "" : "s"} ({fmtMoney(data.voidTotal)})
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
                    <th className="reports__num">Count</th>
                    <th className="reports__num">Amount</th>
                    <th className="reports__num">% of Sales</th>
                  </tr>
                </thead>
                <tbody>
                  {byReason.map((r) => (
                    <tr key={r.reason}>
                      <td>{reasonLabel(r.reason)}</td>
                      <td className="reports__num">{r.count}</td>
                      <td className="reports__num">−{fmtMoney(r.amount)}</td>
                      <td className="reports__num">{fmtPct(r.pctOfSales)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="reports__row--total">
                    <td>Total</td>
                    <td className="reports__num">{data.reversedCount}</td>
                    <td className="reports__num">−{fmtMoney(data.reversedTotal)}</td>
                    <td className="reports__num">{fmtPct(data.pctOfSales)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Part 2 — per-reversal detail (the dual-control audit line) */}
          <div className="reports__submeta">
            <div className="reports__submeta-head">
              <h4 className="reports__submeta-title">Reversal Detail</h4>
            </div>
            <div className="reports__tablewrap">
              <table className="reports__table reports__table--log">
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Date/Time</th>
                    <th>Type</th>
                    <th className="reports__num">Amount</th>
                    <th className="reports__num">Tax</th>
                    <th>Reason</th>
                    <th>Requested by</th>
                    <th>Approved by</th>
                    <th>Method</th>
                  </tr>
                </thead>
                <tbody>
                  {refunds.map((r) => (
                    <tr key={r.id}>
                      <td className="reports__mono">#{r.orderNumber}</td>
                      <td>{fmtDateTime(r.createdAt)}</td>
                      <td>
                        <span className={`reports__badge ${r.type === "void" ? "reports__badge--warn" : "reports__badge--ok"}`}>
                          {typeLabel(r.type)}
                        </span>
                      </td>
                      <td className="reports__num reports__strong-cell">−{fmtMoney(r.amount)}</td>
                      <td className="reports__num">{fmtMoney(r.taxAmount)}</td>
                      <td
                        className="reports__reason"
                        title={r.reason === "other" && r.reasonNote ? r.reasonNote : undefined}
                      >
                        {reasonLabel(r.reason)}
                      </td>
                      <td>{r.requestedBy || "—"}</td>
                      <td>{r.approvedBy || "—"}</td>
                      <td>{METHOD_LABELS[r.method] || r.method || "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="reports__row--total">
                    <td colSpan={3}>Total ({data.reversedCount})</td>
                    <td className="reports__num">−{fmtMoney(data.reversedTotal)}</td>
                    <td colSpan={5} />
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
