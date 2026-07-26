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
 * @param {object} [o.preSection] optional leading section emitted before the
 *   main table (for two-part reports like the Discount Report: a summary
 *   rollup above the line-level detail). Shape: { title?, headers, rows, footer? }.
 * @param {string} [o.tableTitle] optional heading row printed just above the
 *   main table's headers (labels the second section when preSection is used).
 */
export function exportCsv({ filename, title, headers, rows, footer, preSection, tableTitle }) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [];
  if (title) lines.push(esc(title));
  if (preSection) {
    if (preSection.title) lines.push(esc(preSection.title));
    lines.push(preSection.headers.map(esc).join(","));
    for (const r of preSection.rows) lines.push(r.map(esc).join(","));
    if (preSection.footer) lines.push(preSection.footer.map(esc).join(","));
    lines.push(""); // blank separator between sections
  }
  if (tableTitle) lines.push(esc(tableTitle));
  lines.push(headers.map(esc).join(","));
  for (const r of rows) lines.push(r.map(esc).join(","));
  if (footer) lines.push(footer.map(esc).join(","));
  downloadBlob(lines.join("\n"), "text/csv;charset=utf-8", filename);
}

// Shared autoTable styling so every table (and every section of a multi-part
// report) looks identical.
const TABLE_STYLES = {
  styles: { fontSize: 9 },
  headStyles: { fillColor: [232, 68, 46] }, // brand red
  footStyles: { fillColor: [245, 245, 244], textColor: 20, fontStyle: "bold" },
};

/**
 * Build and download a PDF (jsPDF + autotable, lazy-loaded).
 * @param {object} o
 * @param {string} o.filename
 * @param {string} o.title     document heading
 * @param {string} [o.subtitle] second line (e.g. the date range)
 * @param {string[]} o.headers column headers
 * @param {Array<Array>} o.rows body rows
 * @param {Array} [o.foot]     optional totals row
 * @param {object} [o.preTable] optional leading table rendered above the main
 *   one (two-part reports: a summary rollup above line-level detail).
 *   Shape: { title?, headers, rows, foot? }.
 * @param {string} [o.tableTitle] optional heading printed just above the main
 *   table (labels the second section when preTable is used).
 */
export async function exportPdf({ filename, title, subtitle, headers, rows, foot, preTable, tableTitle }) {
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
  if (preTable) {
    if (preTable.title) {
      doc.setFontSize(11);
      doc.text(preTable.title, 14, startY);
      startY += 4;
    }
    autoTable(doc, {
      startY,
      head: [preTable.headers],
      body: preTable.rows,
      foot: preTable.foot ? [preTable.foot] : undefined,
      ...TABLE_STYLES,
    });
    startY = doc.lastAutoTable.finalY + 10;
  }
  if (tableTitle) {
    doc.setFontSize(11);
    doc.text(tableTitle, 14, startY);
    startY += 4;
  }
  autoTable(doc, {
    startY,
    head: [headers],
    body: rows,
    foot: foot ? [foot] : undefined,
    ...TABLE_STYLES,
  });
  doc.save(filename);
}
