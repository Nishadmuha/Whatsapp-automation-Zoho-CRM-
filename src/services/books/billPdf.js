'use strict';
const PDFDocument = require('pdfkit');

// Only pass an authoritative GET /bills/{id} response, never OCR/draft data.
async function renderCreatedBillPdf(bill, { fontPath, organizationName = 'Voltronix Contracting LLC' } = {}) {
  if (!bill?.bill_id || !bill.bill_number || !bill.currency_code || !Number.isFinite(bill.total) || !Array.isArray(bill.line_items)) throw new Error('INCOMPLETE_CREATED_BILL');
  const texts = [bill.vendor_name, bill.bill_number, bill.notes, ...bill.line_items.map(item => item.description || item.name)];
  // Standard PDF fonts do not support all scripts. Fail honestly instead of
  // silently replacing accounting text; deployments can supply a Unicode font.
  if (!fontPath && texts.some(text => /[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/u.test(String(text || '')))) throw new Error('BILL_PDF_UNICODE_FONT_REQUIRED');
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: `Zoho Books bill ${bill.bill_number}`, Author: organizationName } });
  const chunks = [];
  const ready = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  if (fontPath) doc.font(fontPath);
  const text = value => value == null || value === '' ? 'Not recorded' : String(value);
  const money = value => Number.isFinite(value) ? `${bill.currency_code} ${value.toFixed(2)}` : 'Not recorded';
  doc.fillColor('#111827').fontSize(21).text('PURCHASE BILL');
  doc.moveDown(0.4).fontSize(10).fillColor('#536174').text('Copy generated from the saved Zoho Books record.');
  doc.text('Not the original supplier invoice or an official Zoho template.');
  doc.moveDown().fillColor('#111827').fontSize(11);
  for (const [label, value] of [['Zoho Bill ID', bill.bill_id], ['Bill number', bill.bill_number], ['Vendor', bill.vendor_name], ['Bill date', bill.date], ['Due date', bill.due_date], ['Currency', bill.currency_code], ['Status', bill.status]]) doc.text(`${label}: ${text(value)}`, { lineGap: 4 });
  doc.moveDown().fontSize(14).text('Items');
  doc.moveDown(0.4).fontSize(10);
  bill.line_items.forEach((item, index) => {
    if (doc.y > 690) doc.addPage();
    doc.fillColor('#111827').text(`${index + 1}. ${text(item.description || item.name)}`, { lineGap: 3 });
    doc.fillColor('#536174').text(`Quantity: ${text(item.quantity)}   Rate: ${money(item.rate)}   Amount: ${money(item.item_total)}`, { lineGap: 3 });
    if (item.tax_percentage != null) doc.text(`Tax: ${item.tax_percentage}%`, { lineGap: 3 });
    doc.moveDown(0.6);
  });
  if (doc.y > 650) doc.addPage();
  doc.moveDown().fillColor('#111827').fontSize(11).text(`Subtotal: ${money(bill.sub_total)}`);
  doc.text(`Tax: ${money(bill.tax_total)}`);
  doc.moveDown(0.4).fontSize(16).text(`Total: ${money(bill.total)}`);
  if (bill.notes) doc.moveDown().fontSize(10).text(`Notes: ${bill.notes}`, { lineGap: 3 });
  const pages = doc.bufferedPageRange();
  for (let page = 0; page < pages.count; page++) {
    doc.switchToPage(page);
    doc.fontSize(8).fillColor('#536174').text(`Zoho Books record ${bill.bill_id} | Page ${page + 1} of ${pages.count}`, 48, 806, { lineBreak: false });
  }
  doc.end();
  return ready;
}
module.exports = { renderCreatedBillPdf };
