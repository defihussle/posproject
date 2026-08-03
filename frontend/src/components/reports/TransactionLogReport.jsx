import { useState, useEffect, useCallback, useMemo } from "react";
import { API_URL } from "../../config";
import { exportCsv, exportPdf, reportFilename } from "../reportExport";
import { previousPeriod } from "../reportRange";

// Transaction Log report body — one row per completed (ready) order: the
// audit backbone. Data from GET /api/backoffice/reports/transactions, which
// also returns period totals, a reconciliation check (order total ==
// payments total), and an optional prior-period comparison. `range` is the
// resolved { start, end, label } from the shell's period selector.

const fmtMoney = (n) =>
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const METHOD_LABELS = { cash: "Cash", card: "Card", gift_card: "Gift Card", other: "Other" };
const REASON_LABELS = {
  family: "Family",
  friend: "Friend",
  employee: "Employee",
  neighbouring_store: "Neighbouring store",
};
const fmtMethods = (methods) =>
  (methods || []).map((m) => METHOD_LABELS[m] || m).join(" + ") || "—";
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

// Per-row reversal state. Voided orders are 'cancelled'; otherwise a row is
// fully/partially refunded when it carries refunds, else a completed sale with
// nothing reversed — labelled "Settled" rather than left blank, so an untouched
// sale reads as a positive state instead of missing data.
const rowState = (r) => {
  if (r.status === "cancelled") return "voided";
  if (r.refunded >= r.total - 0.005) return "refunded"; // fully
  if (r.refunded > 0.005) return "partial";
  return "clean";
};
const STATE_LABELS = {
  voided: "Voided",
  refunded: "Refunded",
  partial: "Partially refunded",
  clean: "Settled",
};

// PDF is offered only up to this row count — beyond it a PDF is neither
// printable nor fast to render, so CSV is the real format (see reports-plan).
const PDF_ROW_LIMIT = 500;

export default function TransactionLogReport({ range }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!range?.start || !range?.end) return;
    setLoading(true);
    try {
      const prev = previousPeriod(range.start, range.end, range.kind);
      const qs = new URLSearchParams({ start: range.start, end: range.end });
      if (prev) {
        qs.set("prevStart", prev.start);
        qs.set("prevEnd", prev.end);
      }
      const res = await fetch(`${API_URL}/api/backoffice/reports/transactions?${qs}`, {
        credentials: "include",
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e.message || "Failed to load transaction log");
    } finally {
      setLoading(false);
    }
  }, [range?.start, range?.end]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = data?.rows || [];
  const totals = data?.totals;
  const subtitle = range?.label || `${range?.start} → ${range?.end}`;
  const pdfAllowed = rows.length > 0 && rows.length <= PDF_ROW_LIMIT;

  // Prior-period deltas (period-level — per-row comparison is meaningless for
  // a log). Arrow + color, never color alone (dataviz rule).
  const cmp = useMemo(() => {
    if (!data?.comparison || !totals) return null;
    const c = data.comparison;
    const pct = (cur, prev) => (prev > 0 ? ((cur - prev) / prev) * 100 : null);
    return {
      count: c.count,
      total: c.total,
      countPct: pct(totals.count, c.count),
      totalPct: pct(totals.total, c.total),
    };
  }, [data, totals]);

  const exportHeaders = [
    "Order #", "Date/Time", "Staff", "Subtotal", "Discount", "Reason",
    "Tax", "Tip", "Total", "Refunded", "Payment", "Status",
  ];
  const exportRows = () =>
    rows.map((r) => [
      r.orderNumber,
      r.completedAt,
      r.staffName,
      r.subtotal.toFixed(2),
      r.discount.toFixed(2),
      r.discountReason ? REASON_LABELS[r.discountReason] || r.discountReason : "",
      r.tax.toFixed(2),
      r.tip.toFixed(2),
      r.total.toFixed(2),
      r.refunded > 0 ? r.refunded.toFixed(2) : "",
      fmtMethods(r.methods),
      STATE_LABELS[rowState(r)],
    ]);
  const footer = totals
    ? ["Total", "", "", totals.subtotal.toFixed(2), totals.discount.toFixed(2), "",
       totals.tax.toFixed(2), totals.tip.toFixed(2), totals.total.toFixed(2),
       totals.refunded > 0 ? totals.refunded.toFixed(2) : "", "", `Net ${totals.net.toFixed(2)}`]
    : null;

  const doCsv = () =>
    exportCsv({
      filename: reportFilename("transactions", range.start, range.end, "csv"),
      title: `Transaction Log — ${subtitle}`,
      headers: exportHeaders,
      rows: exportRows(),
      footer,
    });

  const doPdf = () =>
    exportPdf({
      filename: reportFilename("transactions", range.start, range.end, "pdf"),
      title: "Transaction Log",
      subtitle,
      headers: exportHeaders,
      rows: exportRows(),
      foot: footer,
    });

  return (
    <div className="reports__report">
      <div className="reports__report-head">
        <h3 className="reports__report-title">Transaction Log</h3>
        <div className="reports__exports">
          <button className="reports__exportbtn" onClick={doCsv} disabled={rows.length === 0}>
            Export CSV
          </button>
          <button
            className="reports__exportbtn"
            onClick={doPdf}
            disabled={!pdfAllowed}
            title={
              rows.length > PDF_ROW_LIMIT
                ? `PDF disabled above ${PDF_ROW_LIMIT} rows — use CSV`
                : undefined
            }
          >
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
      ) : rows.length === 0 ? (
        <div className="reports__tablewrap">
          <div className="reports__coming">No completed orders in this period.</div>
        </div>
      ) : (
        <>
          {/* Period summary: count + collected, reconciliation, comparison */}
          <div className="reports__logbar">
            <div className="reports__logbar-main">
              <span className="reports__logbar-count">
                {totals.count} transaction{totals.count === 1 ? "" : "s"}
              </span>
              <span className="reports__logbar-sep">·</span>
              <span className="reports__logbar-total">{fmtMoney(totals.net)} collected</span>
              {totals.refunded > 0 && (
                <>
                  <span className="reports__logbar-sep">·</span>
                  <span className="reports__logbar-count" title="Refunds on orders in this period">
                    −{fmtMoney(totals.refunded)} refunded
                  </span>
                </>
              )}
              {data.reconciliation.balanced ? (
                <span
                  className="reports__badge reports__badge--ok"
                  title={`Net (total ${fmtMoney(data.reconciliation.transactionTotal)} − refunds ${fmtMoney(data.reconciliation.refundedTotal)}) = ${fmtMoney(data.reconciliation.netTotal)} == payments ${fmtMoney(data.reconciliation.paymentsTotal)}`}
                >
                  ✓ Reconciled
                </span>
              ) : (
                <span
                  className="reports__badge reports__badge--warn"
                  title={`Net ${fmtMoney(data.reconciliation.netTotal)} vs payments ${fmtMoney(data.reconciliation.paymentsTotal)}`}
                >
                  ⚠ Mismatch
                </span>
              )}
            </div>
            {cmp && (
              <div className="reports__logbar-cmp">
                <span
                  className="reports__cmp-label"
                  title="Compared to the same elapsed span of the prior period (same day-of-period). Day-of-week composition may differ between the two windows."
                >
                  vs prior period
                </span>
                <Delta pct={cmp.countPct} suffix=" orders" />
                <Delta pct={cmp.totalPct} suffix=" sales" />
              </div>
            )}
          </div>

          {rows.length > PDF_ROW_LIMIT && (
            <div className="reports__note">
              {rows.length} rows — PDF export is disabled above {PDF_ROW_LIMIT} rows; use CSV.
            </div>
          )}

          <div className="reports__tablewrap">
            <table className="reports__table reports__table--log">
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Date/Time</th>
                  <th>Staff</th>
                  <th className="reports__num">Subtotal</th>
                  <th className="reports__num">Discount</th>
                  <th>Reason</th>
                  <th className="reports__num">Tax</th>
                  <th className="reports__num">Tip</th>
                  <th className="reports__num">Total</th>
                  <th className="reports__num">Refunded</th>
                  <th>Payment</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const state = rowState(r);
                  const voided = state === "voided";
                  return (
                    <tr
                      key={r.orderNumber}
                      className={voided ? "reports__row--voided" : ""}
                    >
                      <td className="reports__mono">#{r.orderNumber}</td>
                      <td>{fmtDateTime(r.completedAt)}</td>
                      <td>{r.staffName}</td>
                      <td className="reports__num">{fmtMoney(r.subtotal)}</td>
                      <td className="reports__num">
                        {r.discount > 0 ? `−${fmtMoney(r.discount)}` : "—"}
                      </td>
                      <td className="reports__reason">
                        {r.discountReason ? REASON_LABELS[r.discountReason] || r.discountReason : "—"}
                      </td>
                      <td className="reports__num">{fmtMoney(r.tax)}</td>
                      <td className="reports__num">{r.tip > 0 ? fmtMoney(r.tip) : "—"}</td>
                      <td className="reports__num reports__strong-cell">{fmtMoney(r.total)}</td>
                      <td className="reports__num">
                        {r.refunded > 0 ? `−${fmtMoney(r.refunded)}` : "—"}
                      </td>
                      <td>{fmtMethods(r.methods)}</td>
                      <td>
                        <span
                          className={`reports__statepill reports__statepill--${state}`}
                        >
                          {STATE_LABELS[state]}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="reports__row--total">
                  <td colSpan={3}>Total ({totals.count})</td>
                  <td className="reports__num">{fmtMoney(totals.subtotal)}</td>
                  <td className="reports__num">−{fmtMoney(totals.discount)}</td>
                  <td />
                  <td className="reports__num">{fmtMoney(totals.tax)}</td>
                  <td className="reports__num">{fmtMoney(totals.tip)}</td>
                  <td className="reports__num">{fmtMoney(totals.total)}</td>
                  <td className="reports__num">
                    {totals.refunded > 0 ? `−${fmtMoney(totals.refunded)}` : "—"}
                  </td>
                  <td />
                  <td className="reports__num">Net {fmtMoney(totals.net)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// Signed percentage delta with an arrow + status color (never color alone).
function Delta({ pct, suffix }) {
  if (pct == null) {
    return (
      <span className="reports__delta reports__delta--flat">
        — {suffix.trim()}
      </span>
    );
  }
  const up = pct >= 0;
  return (
    <span className={`reports__delta ${up ? "reports__delta--up" : "reports__delta--down"}`}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%{suffix}
    </span>
  );
}
