import { useState, useEffect, useCallback, useMemo } from "react";
import { API_URL } from "../../config";
import { exportCsv, exportPdf, reportFilename } from "../reportExport";

// Sales Summary report body — a P&L-style single-period snapshot:
//   Gross → Discounts → Net → Tax → Tips → Total collected
// plus order count, AOV, and a payment-method mix. Data comes from
// GET /api/backoffice/reports/sales-summary (reuses the stats/summary money
// math; tax + payment mix are net-new there). `range` is the resolved
// { start, end, label } from the shell's period selector.

const fmtMoney = (n) =>
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const METHOD_LABELS = { cash: "Cash", card: "Card", gift_card: "Gift Card", other: "Other" };

export default function SalesSummaryReport({ range }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!range?.start || !range?.end) return;
    setLoading(true);
    try {
      const res = await fetch(
        `${API_URL}/api/backoffice/reports/sales-summary?start=${range.start}&end=${range.end}`,
        { credentials: "include" }
      );
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e.message || "Failed to load sales summary");
    } finally {
      setLoading(false);
    }
  }, [range?.start, range?.end]);

  useEffect(() => {
    load();
  }, [load]);

  // Ordered P&L line items. `sign` drives the +/− prefix; `strong` marks the
  // Net and Total subtotal lines.
  const lineItems = useMemo(() => {
    if (!data) return [];
    return [
      { label: "Gross sales", value: data.grossSales },
      { label: "Discounts", value: data.discountTotal, sign: "-" },
      { label: "Net sales", value: data.netSales, strong: true },
      { label: "Tax collected", value: data.taxCollected, sign: "+" },
      { label: "Tips", value: data.totalTips, sign: "+" },
      { label: "Total collected", value: data.totalCollected, strong: true, total: true },
    ];
  }, [data]);

  const subtitle = range?.label || `${range?.start} → ${range?.end}`;

  const exportRows = () => {
    const rows = lineItems.map((li) => [
      li.label,
      `${li.sign === "-" ? "-" : ""}${Number(li.value).toFixed(2)}`,
    ]);
    rows.push(["Order count", String(data.orderCount)]);
    rows.push(["Average order value", data.avgOrderValue.toFixed(2)]);
    for (const m of data.paymentMix) {
      rows.push([`Payment — ${METHOD_LABELS[m.method] || m.method}`, Number(m.amount).toFixed(2)]);
    }
    return rows;
  };

  const doCsv = () =>
    exportCsv({
      filename: reportFilename("sales-summary", range.start, range.end, "csv"),
      title: `Sales Summary — ${subtitle}`,
      headers: ["Line item", "Amount"],
      rows: exportRows(),
    });

  const doPdf = () =>
    exportPdf({
      filename: reportFilename("sales-summary", range.start, range.end, "pdf"),
      title: "Sales Summary",
      subtitle,
      headers: ["Line item", "Amount"],
      rows: exportRows(),
    });

  const hasData = data && data.orderCount > 0;

  return (
    <div className="reports__report">
      <div className="reports__report-head">
        <h3 className="reports__report-title">Sales Summary</h3>
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
          <div className="reports__coming">No completed orders in this period.</div>
        </div>
      ) : (
        <div className="reports__summary">
          {/* P&L line items */}
          <div className="reports__tablewrap">
            <table className="reports__table reports__table--summary">
              <tbody>
                {lineItems.map((li) => (
                  <tr
                    key={li.label}
                    className={`${li.strong ? " reports__row--strong" : ""}${li.total ? " reports__row--total" : ""}`}
                  >
                    <td className="reports__li-label">{li.label}</td>
                    <td className="reports__li-value">
                      {li.sign === "-" ? "−" : li.sign === "+" ? "+" : ""}
                      {fmtMoney(li.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Secondary stats */}
          <div className="reports__statgrid">
            <div className="reports__stat">
              <span className="reports__stat-label">Orders</span>
              <span className="reports__stat-value">{data.orderCount}</span>
            </div>
            <div className="reports__stat">
              <span className="reports__stat-label">Avg Order Value</span>
              <span className="reports__stat-value">{fmtMoney(data.avgOrderValue)}</span>
            </div>
          </div>

          {/* Payment-method mix */}
          <div className="reports__submeta">
            <div className="reports__submeta-head">
              <h4 className="reports__submeta-title">Payment Mix</h4>
              <span className="reports__note" title="Payments are recorded but not settled through a processor yet">
                Reflects method selected at checkout, not verified settlement
              </span>
            </div>
            <div className="reports__tablewrap">
              <table className="reports__table">
                <thead>
                  <tr>
                    <th>Method</th>
                    <th className="reports__num">Orders</th>
                    <th className="reports__num">Amount</th>
                    <th className="reports__num">% of Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.paymentMix.map((m) => (
                    <tr key={m.method}>
                      <td>{METHOD_LABELS[m.method] || m.method}</td>
                      <td className="reports__num">{m.count}</td>
                      <td className="reports__num">{fmtMoney(m.amount)}</td>
                      <td className="reports__num">
                        {data.totalCollected > 0
                          ? `${((m.amount / data.totalCollected) * 100).toFixed(1)}%`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="reports__row--total">
                    <td>Total</td>
                    <td className="reports__num">{data.orderCount}</td>
                    <td className="reports__num">{fmtMoney(data.totalCollected)}</td>
                    <td className="reports__num">100%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
