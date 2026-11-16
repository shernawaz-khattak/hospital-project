// PDF export for financial reports (SRS UC-43: "Reports must be exportable in PDF format").
import PDFDocument from 'pdfkit';

const money = (n, c) => `${c} ${Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const INK = '#14213d';
const MUTED = '#5c6b7a';
const RULE = '#d5dde5';

function table(doc, headers, rows, widths, { align = [] } = {}) {
  const x0 = doc.page.margins.left;
  let y = doc.y;
  const lineH = 18;
  const drawRow = (cells, bold = false, fill = null) => {
    if (y > doc.page.height - doc.page.margins.bottom - lineH) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    if (fill) doc.rect(x0, y - 4, widths.reduce((a, b) => a + b, 0), lineH).fill(fill);
    let x = x0;
    doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    cells.forEach((c, i) => {
      doc.text(String(c), x + 4, y, { width: widths[i] - 8, align: align[i] ?? 'left', lineBreak: false });
      x += widths[i];
    });
    y += lineH;
    doc.moveTo(x0, y - 4).lineTo(x0 + widths.reduce((a, b) => a + b, 0), y - 4).strokeColor(RULE).lineWidth(0.5).stroke();
  };
  drawRow(headers, true, '#eef3f7');
  rows.forEach((r) => drawRow(r));
  doc.y = y + 6;
  doc.x = x0;
}

export function financialReportPdf(report, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Financial report ${report.from} to ${report.to}`, Author: report.hospital } });
  doc.pipe(stream);
  const c = report.currency;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(report.hospital);
  doc.font('Helvetica').fontSize(12).fillColor(MUTED).text(`Financial report — ${report.period[0].toUpperCase()}${report.period.slice(1)} breakdown`);
  doc.fontSize(10).text(`Period: ${report.from} to ${report.to}    Generated: ${new Date(report.generatedAt).toLocaleString()}`);
  doc.moveDown();

  if (!report.hasData) {
    doc.fillColor(INK).fontSize(12).text(report.message);
    doc.end();
    return;
  }
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text('Summary');
  doc.moveDown(0.3);
  table(doc, ['Metric', 'Value'], [
    ['Bills generated', report.totals.bills],
    ['Total billed (before insurance)', money(report.totals.billed, c)],
    ['Insurance coverage', money(report.totals.insurance, c)],
    ['Payments received', `${report.totals.payments} (${money(report.totals.collected, c)})`],
    ['Outstanding at end of period', money(report.outstandingAtEnd, c)],
  ], [300, 199], { align: ['left', 'right'] });

  doc.font('Helvetica-Bold').fontSize(12).text(`By ${report.period === 'daily' ? 'day' : report.period === 'weekly' ? 'week (starting)' : 'month'}`);
  doc.moveDown(0.3);
  table(doc, ['Period', 'Bills', 'Billed', 'Insurance', 'Collected'], report.rows.map((r) => [r.period, r.bills, money(r.billed, c), money(r.insurance, c), money(r.collected, c)]), [90, 50, 120, 119, 120], { align: ['left', 'right', 'right', 'right', 'right'] });

  if (report.byCategory.length) {
    doc.font('Helvetica-Bold').fontSize(12).text('Billed by service category');
    doc.moveDown(0.3);
    table(doc, ['Category', 'Amount'], report.byCategory.map((r) => [r.category, money(r.amount, c)]), [300, 199], { align: ['left', 'right'] });
  }
  if (report.byMethod.length) {
    doc.font('Helvetica-Bold').fontSize(12).text('Payments by method');
    doc.moveDown(0.3);
    table(doc, ['Method', 'Payments', 'Amount'], report.byMethod.map((r) => [r.method.replace('_', ' '), r.n, money(r.amount, c)]), [200, 100, 199], { align: ['left', 'right', 'right'] });
  }
  if (report.insurance.length) {
    doc.font('Helvetica-Bold').fontSize(12).text('Insurance coverage by provider');
    doc.moveDown(0.3);
    table(doc, ['Provider', 'Bills', 'Amount'], report.insurance.map((r) => [r.name, r.n, money(r.amount, c)]), [200, 100, 199], { align: ['left', 'right', 'right'] });
  }
  doc.end();
}
