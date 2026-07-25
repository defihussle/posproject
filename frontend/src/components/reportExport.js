// ============================================================
// Back Office → Reports — shared export scaffolding.
// One CSV builder and one PDF builder used by every report body, so all
// four reports export with an identical look, header, and filename
// convention (report-<name>-<start>-to-<end>.{csv,pdf}). jsPDF is heavy and
// only needed on the (infrequent) PDF export, so it's dynamically imported
// here — same lazy pattern as Payroll, keeping it out of the main bundle.
// ============================================================

export function downloadBlob(content, type, filename) {
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

// Filenames follow the Payroll convention so exports sort/group predictably.
export const reportFilename = (name, start, end, ext) =>
  `report-${name}-${start}-to-${end}.${ext}`;

/**
 * Build and download a CSV from already-fetched rows.
 * @param {object} o
 * @param {string} o.filename
 * @param {string} [o.title]   optional first line (e.g. report + range)
 * @param {string[]} o.headers column headers
 * @param {Array<Array>} o.rows body rows (arrays of cell values)
 * @param {Array} [o.footer]   optional totals row
 */
export function exportCsv({ filename, title, headers, rows, footer }) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [];
  if (title) lines.push(esc(title));
  lines.push(headers.map(esc).join(","));
  for (const r of rows) lines.push(r.map(esc).join(","));
  if (footer) lines.push(footer.map(esc).join(","));
  downloadBlob(lines.join("\n"), "text/csv;charset=utf-8", filename);
}

/**
 * Build and download a PDF (jsPDF + autotable, lazy-loaded).
 * @param {object} o
 * @param {string} o.filename
 * @param {string} o.title     document heading
 * @param {string} [o.subtitle] second line (e.g. the date range)
 * @param {string[]} o.headers column headers
 * @param {Array<Array>} o.rows body rows
 * @param {Array} [o.foot]     optional totals row
 */
export async function exportPdf({ filename, title, subtitle, headers, rows, foot }) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const doc = new jsPDF();
  doc.setFontSize(14);
  doc.text(title, 14, 16);
  let startY = 22;
  if (subtitle) {
    doc.setFontSize(10);
    doc.text(subtitle, 14, 23);
    startY = 28;
  }
  autoTable(doc, {
    startY,
    head: [headers],
    body: rows,
    foot: foot ? [foot] : undefined,
    styles: { fontSize: 9 },
    headStyles: { fillColor: [232, 68, 46] }, // brand red
    footStyles: { fillColor: [245, 245, 244], textColor: 20, fontStyle: "bold" },
  });
  doc.save(filename);
}
