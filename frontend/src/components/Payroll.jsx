import { useState, useEffect, useCallback, useMemo } from "react";
import { API_URL } from "../config";
import "./Payroll.css";
// jsPDF is heavy and only needed on the (infrequent) PDF export, so it's
// dynamically imported in exportPdf() to keep it out of the main bundle.

// --- Local date helpers (weeks are Mon–Sun). Build Dates from numeric
// parts, never from a string: iOS Safari (JavaScriptCore) throws
// "The string did not match the expected pattern." on new Date("YYYY-MM-DDT..")
// where Chromium silently accepts it. Numeric construction is safe on every
// engine and needs no timezone parsing.
const toYmd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseYmd = (ymd) => {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return new Date(y, m - 1, d); // local midnight, no string parsing
};
const currentMonday = () => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back up to Monday
  return toYmd(d);
};
const addDays = (ymd, n) => {
  const d = parseYmd(ymd);
  d.setDate(d.getDate() + n);
  return toYmd(d);
};
const fmtRange = (a, b) => {
  const s = parseYmd(a);
  const e = parseYmd(b);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return `${a} – ${b}`;
  const mo = (x) => x.toLocaleString(undefined, { month: "short" });
  const right = s.getMonth() === e.getMonth() ? `${e.getDate()}` : `${mo(e)} ${e.getDate()}`;
  return `${mo(s)} ${s.getDate()} – ${right}, ${e.getFullYear()}`;
};

const ROLE_LABELS = { admin: "Admin", manager: "Manager", cashier: "Cashier", kitchen: "Kitchen" };
const fmtMoney = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Back Office → Payroll (owner/admin). Weekly Mon–Sun view of staff hours +
 * gross pay, with a Mark-as-Paid toggle persisted per week and CSV/PDF
 * export. Hours/pay come from GET /api/backoffice/payroll (owners excluded,
 * breaks subtracted, past-week open shifts capped server-side); the paid
 * flags are saved via PUT /api/backoffice/payroll/status.
 */
export default function Payroll({ staff }) {
  const [weekStart, setWeekStart] = useState(() => currentMonday());
  const [data, setData] = useState(null);
  const [paid, setPaid] = useState({}); // staff_id -> bool (local, editable)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `${API_URL}/api/backoffice/payroll?staffId=${staff.id}&weekStart=${weekStart}`,
        { credentials: "include" }
      );
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setData(d);
      setPaid(Object.fromEntries(d.rows.map((r) => [r.staff_id, r.paid])));
      setError(null);
    } catch (e) {
      setError(e.message || "Failed to load payroll");
    } finally {
      setLoading(false);
    }
  }, [staff.id, weekStart]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = data?.rows || [];
  const dirty = useMemo(() => rows.some((r) => paid[r.staff_id] !== r.paid), [rows, paid]);
  const totals = useMemo(
    () => ({
      hours: rows.reduce((s, r) => s + r.hours, 0),
      gross: rows.reduce((s, r) => s + (r.grossPay || 0), 0),
    }),
    [rows]
  );
  const isCurrent = weekStart === currentMonday();

  const goPrev = () => setWeekStart((w) => addDays(w, -7));
  const goCurrent = () => setWeekStart(currentMonday());
  const togglePaid = (id) => setPaid((p) => ({ ...p, [id]: !p[id] }));

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/backoffice/payroll/status`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: staff.id,
          weekStart: data.weekStart,
          entries: rows.map((r) => ({ staffId: r.staff_id, paid: !!paid[r.staff_id] })),
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      // Reflect saved state as the new baseline so the Save button disables.
      setData((prev) => ({ ...prev, rows: prev.rows.map((r) => ({ ...r, paid: !!paid[r.staff_id] })) }));
      setError(null);
      setSavedNote(true);
      setTimeout(() => setSavedNote(false), 2000);
    } catch (e) {
      setError(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const exportRows = () =>
    rows.map((r) => [
      r.name,
      ROLE_LABELS[r.role] || r.role,
      r.hours.toFixed(2),
      r.hourlyRate == null ? "Rate not set" : r.hourlyRate.toFixed(2),
      r.grossPay == null ? "" : r.grossPay.toFixed(2),
      paid[r.staff_id] ? "Paid" : "Unpaid",
    ]);

  const exportCsv = () => {
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const head = ["Staff Name", "Role", "Hours Worked", "Hourly Rate", "Gross Pay", "Status"];
    const lines = [
      esc(`Payroll — ${fmtRange(data.weekStart, data.weekEnd)}`),
      head.map(esc).join(","),
      ...exportRows().map((row) => row.map(esc).join(",")),
      ["Total", "", totals.hours.toFixed(2), "", totals.gross.toFixed(2), ""].map(esc).join(","),
    ];
    downloadBlob(lines.join("\n"), "text/csv;charset=utf-8", `payroll-${data.weekStart}-to-${data.weekEnd}.csv`);
  };

  const exportPdf = async () => {
    const [{ jsPDF }, { default: autoTable }] = await Promise.all([
      import("jspdf"),
      import("jspdf-autotable"),
    ]);
    const doc = new jsPDF();
    doc.setFontSize(14);
    doc.text("Payroll", 14, 16);
    doc.setFontSize(10);
    doc.text(fmtRange(data.weekStart, data.weekEnd), 14, 23);
    autoTable(doc, {
      startY: 28,
      head: [["Staff Name", "Role", "Hours", "Rate", "Gross Pay", "Status"]],
      body: exportRows(),
      foot: [["Total", "", totals.hours.toFixed(2), "", fmtMoney(totals.gross), ""]],
      styles: { fontSize: 9 },
      headStyles: { fillColor: [232, 68, 46] }, // brand red
      footStyles: { fillColor: [245, 245, 244], textColor: 20, fontStyle: "bold" },
    });
    doc.save(`payroll-${data.weekStart}-to-${data.weekEnd}.pdf`);
  };

  return (
    <div className="payroll">
      <div className="payroll__head">
        <h2 className="payroll__title">Payroll</h2>
        <div className="payroll__weeknav">
          <button className="payroll__navbtn" onClick={goPrev}>
            ← Previous Week
          </button>
          <button className="payroll__navbtn" onClick={goCurrent} disabled={isCurrent}>
            Current Week
          </button>
        </div>
      </div>

      {data && <div className="payroll__range">{fmtRange(data.weekStart, data.weekEnd)}</div>}

      {error ? (
        <div className="payroll__errorstate">
          <p className="payroll__errorstate-msg">{error}</p>
          <button className="payroll__navbtn" onClick={load}>
            Try Again
          </button>
        </div>
      ) : loading ? (
        <div className="payroll__notice">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="payroll__empty">No shifts this week</div>
      ) : (
        <>
          <div className="payroll__tablewrap">
            <table className="payroll__table">
              <thead>
                <tr>
                  <th>Staff Name</th>
                  <th>Role</th>
                  <th className="payroll__num">Hours</th>
                  <th className="payroll__num">Rate</th>
                  <th className="payroll__num">Gross Pay</th>
                  <th className="payroll__center">Paid</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.staff_id}>
                    <td className="payroll__name">{r.name}</td>
                    <td className="payroll__role">{ROLE_LABELS[r.role] || r.role}</td>
                    <td className="payroll__num">{r.hours.toFixed(2)}h</td>
                    <td className="payroll__num">
                      {r.hourlyRate == null ? (
                        <span className="payroll__norate">Rate not set</span>
                      ) : (
                        `${fmtMoney(r.hourlyRate)}/h`
                      )}
                    </td>
                    <td className="payroll__num">{r.grossPay == null ? "—" : fmtMoney(r.grossPay)}</td>
                    <td className="payroll__center">
                      <input
                        type="checkbox"
                        className="payroll__check"
                        checked={!!paid[r.staff_id]}
                        onChange={() => togglePaid(r.staff_id)}
                        aria-label={`Mark ${r.name} paid`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="payroll__total">
                  <td>Total</td>
                  <td />
                  <td className="payroll__num">{totals.hours.toFixed(2)}h</td>
                  <td />
                  <td className="payroll__num">{fmtMoney(totals.gross)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="payroll__actions">
            <div className="payroll__exports">
              <button className="payroll__navbtn" onClick={exportCsv}>
                Export CSV
              </button>
              <button className="payroll__navbtn" onClick={exportPdf}>
                Export PDF
              </button>
            </div>
            <div className="payroll__save-wrap">
              {savedNote && <span className="payroll__saved">Saved ✓</span>}
              <button className="payroll__save" onClick={save} disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function downloadBlob(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
