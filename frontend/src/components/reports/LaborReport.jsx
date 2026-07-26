import { useState, useEffect, useCallback } from "react";
import { API_URL } from "../../config";
import { exportCsv, exportPdf, reportFilename } from "../reportExport";

// Labor Report body — labor expense + output per staff for the period:
// hours worked, labor cost, and (folded in from Staff Performance) orders
// handled and sales rung, plus total labor cost and labor % of sales. Data
// from GET /api/backoffice/reports/labor, whose hours/cost come from the same
// canonical worked-time helpers as stats/labor, Payroll and My Hours — so the
// numbers can't drift from those surfaces. `range` is the resolved
// { start, end, label } from the shell's period selector.

const fmtMoney = (n) =>
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (n) => `${Number(n).toFixed(1)}%`;
const fmtHours = (n) => `${Number(n).toFixed(2)} h`;
const ROLE_LABELS = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  cashier: "Cashier",
  kitchen: "Kitchen",
};
const roleLabel = (r) => ROLE_LABELS[r] || r;

export default function LaborReport({ range }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!range?.start || !range?.end) return;
    setLoading(true);
    try {
      const res = await fetch(
        `${API_URL}/api/backoffice/reports/labor?start=${range.start}&end=${range.end}`,
        { credentials: "include" }
      );
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e.message || "Failed to load labor report");
    } finally {
      setLoading(false);
    }
  }, [range?.start, range?.end]);

  useEffect(() => {
    load();
  }, [load]);

  const perStaff = data?.perStaff || [];
  const subtitle = range?.label || `${range?.start} → ${range?.end}`;
  const hasData = data && perStaff.length > 0;
  // Any unset rate → cost counted as $0 (matches stats/labor); flag it so an
  // owner knows why a labour cost reads low.
  const hasUnsetRate = perStaff.some((s) => s.hourlyRate == null && s.hours > 0);

  const exportHeaders = ["Staff", "Role", "Hours", "Hourly Rate", "Labor Cost", "Orders", "Sales"];
  const exportRows = () =>
    perStaff.map((s) => [
      s.name,
      roleLabel(s.role),
      s.hours.toFixed(2),
      s.hourlyRate == null ? "" : s.hourlyRate.toFixed(2),
      s.laborCost.toFixed(2),
      String(s.orderCount),
      s.totalSales.toFixed(2),
    ]);
  const exportFooter = data
    ? ["Total", "", data.totalHours.toFixed(2), "", data.totalLaborCost.toFixed(2),
       String(data.totalOrders), data.totalSales.toFixed(2)]
    : null;

  const doCsv = () =>
    exportCsv({
      filename: reportFilename("labor", range.start, range.end, "csv"),
      title: `Labor Report — ${subtitle}`,
      headers: exportHeaders,
      rows: exportRows(),
      footer: exportFooter,
    });

  const doPdf = () =>
    exportPdf({
      filename: reportFilename("labor", range.start, range.end, "pdf"),
      title: "Labor Report",
      subtitle,
      headers: exportHeaders,
      rows: exportRows(),
      foot: exportFooter,
    });

  return (
    <div className="reports__report">
      <div className="reports__report-head">
        <h3 className="reports__report-title">Labor Report</h3>
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
          <div className="reports__coming">No shifts worked in this period.</div>
        </div>
      ) : (
        <>
          {/* Headline: total labor cost, hours, and labor % of sales */}
          <div className="reports__logbar">
            <div className="reports__logbar-main">
              <span className="reports__logbar-total">{fmtMoney(data.totalLaborCost)} labor</span>
              <span className="reports__logbar-sep">·</span>
              <span className="reports__logbar-count">{fmtHours(data.totalHours)}</span>
              <span className="reports__logbar-sep">·</span>
              <span
                className="reports__logbar-count"
                title={`Total labor cost as a share of ${fmtMoney(data.grossSales)} gross sales`}
              >
                {fmtPct(data.laborPct)} of sales
              </span>
            </div>
          </div>

          {hasUnsetRate && (
            <div className="reports__note">
              Staff with no hourly rate set are counted at $0 labor cost — set a rate in Staff
              Management for an accurate figure.
            </div>
          )}

          <div className="reports__tablewrap">
            <table className="reports__table reports__table--log">
              <thead>
                <tr>
                  <th>Staff</th>
                  <th>Role</th>
                  <th className="reports__num">Hours</th>
                  <th className="reports__num">Rate</th>
                  <th className="reports__num">Labor Cost</th>
                  <th className="reports__num">Orders</th>
                  <th className="reports__num">Sales</th>
                </tr>
              </thead>
              <tbody>
                {perStaff.map((s) => (
                  <tr key={s.staffId}>
                    <td>{s.name}</td>
                    <td>{roleLabel(s.role)}</td>
                    <td className="reports__num">{s.hours.toFixed(2)}</td>
                    <td className="reports__num">
                      {s.hourlyRate == null ? "—" : fmtMoney(s.hourlyRate)}
                    </td>
                    <td className="reports__num reports__strong-cell">{fmtMoney(s.laborCost)}</td>
                    <td className="reports__num">{s.orderCount}</td>
                    <td className="reports__num">{fmtMoney(s.totalSales)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="reports__row--total">
                  <td colSpan={2}>Total ({perStaff.length})</td>
                  <td className="reports__num">{data.totalHours.toFixed(2)}</td>
                  <td />
                  <td className="reports__num">{fmtMoney(data.totalLaborCost)}</td>
                  <td className="reports__num">{data.totalOrders}</td>
                  <td className="reports__num">{fmtMoney(data.totalSales)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
