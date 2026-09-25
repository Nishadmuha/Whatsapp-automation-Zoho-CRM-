'use strict';
const { PAYMENT_METHODS } = require('./paymentMethods');

function formatAmount(amount, currency = '') {
  if (amount === null || amount === undefined) return null;
  const num = Number(amount);
  if (!Number.isFinite(num)) return null;
  const formatted = num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${formatted}` : formatted;
}

/**
 * Formats structured purchase bill details for WhatsApp messaging.
 */
function formatBillSummary(bill = {}) {
  const currency = bill.currency || '[Not detected]';
  const lines = ['📄 *BILL DETAILS*'];
  lines.push(`• *Organization:* ${bill.organization?.name || '[Not detected]'}`);

  lines.push(`• *Vendor:* ${bill.vendor_name || '⚠️ [Not detected]'}`);
  lines.push(`• *Bill #:* ${bill.bill_number || '[Not detected]'}`);
  lines.push(`• *Bill Date:* ${bill.bill_date || '[Not detected]'}`);
  if (bill.due_date) {
    lines.push(`• *Due Date:* ${bill.due_date}`);
  }
  lines.push(`• *Currency:* ${currency}`);

  lines.push(`• *Payment method:* ${bill.payment_type || '⚠️ [Required before SAVE]'}`);
  const customer = bill.customer_details || {};
  lines.push(`• *Customer:* ${customer.customer_name || '⚠️ [Required before SAVE]'}`);
  if (customer.customer_phone) lines.push(`  Phone: ${customer.customer_phone}`);
  if (customer.project_site) lines.push(`  Project/site: ${customer.project_site}`);

  if (Array.isArray(bill.line_items) && bill.line_items.length > 0) {
    lines.push('');
    lines.push('*Items:*');
    bill.line_items.slice(0, 12).forEach((item, index) => {
      const parts = [];
      if (item.quantity !== null && item.quantity !== undefined) {
        parts.push(`Qty: ${item.quantity}`);
      }
      if (item.rate !== null && item.rate !== undefined) {
        parts.push(`Rate: ${formatAmount(item.rate, currency)}`);
      }
      if (item.amount !== null && item.amount !== undefined) {
        parts.push(`Amount: ${formatAmount(item.amount, currency)}`);
      }
      const itemDetails = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      lines.push(`  ${index + 1}. ${String(item.name || 'Item').slice(0, 80)}${itemDetails}`);
    });
    if (bill.line_items.length > 12) lines.push(`... ${bill.line_items.length - 12} more items stored.`);
  }

  lines.push('');
  if (bill.subtotal !== null && bill.subtotal !== undefined) {
    lines.push(`• *Subtotal:* ${formatAmount(bill.subtotal, currency)}`);
  }
  if (bill.tax_amount !== null && bill.tax_amount !== undefined) {
    lines.push(`• *VAT / Tax:* ${formatAmount(bill.tax_amount, currency)}`);
  }
  lines.push(`• *Total:* ${bill.total_amount !== null && bill.total_amount !== undefined ? formatAmount(bill.total_amount, currency) : '⚠️ [Not detected]'}`);

  if (bill.notes) {
    lines.push(`• *Notes:* ${String(bill.notes).slice(0, 300)}`);
  }

  return lines.join('\n');
}

/**
 * Summary with the first turn question.
 */
function formatInitialReviewPrompt(bill) {
  const paymentPrompt = bill.payment_type
    ? `Payment method: ${bill.payment_type}`
    : `Before SAVE, send payment method: ${PAYMENT_METHODS.join(' / ')}`;
  return `${formatBillSummary(bill).slice(0, 3500)}\n\n${paymentPrompt}\n\n1 SAVE\n2 EDIT\n3 DELETE\nNothing is saved to Zoho Books until you reply SAVE or 1.`;
}

function formatCustomerSelectionPrompt(customers = []) {
  const lines = ['Please select the customer from Zoho Books.'];
  customers.forEach((customer, index) => {
    lines.push(`${index + 1}. ${customer.name.slice(0, 80)}${customer.phone ? ` — ${customer.phone}` : ''}`);
  });
  lines.push('Select a customer from the list.');
  return lines.join('\n');
}

function formatOrganizationSelectionPrompt(bill = {}) {
  return `${formatBillSummary(bill).slice(0, 3500)}\n\nOrganization could not be clearly detected from the invoice.\nPlease select the bill organization:\n\n1. VOLTRONIX SWITCHGEAR LLC\n2. VOLTRONIX CONTRACTING LLC\nReply DELETE to cancel.`;
}

/**
 * Summary after additional information is added.
 */
function formatAdditionalInfoUpdatedPrompt(bill) {
  return formatInitialReviewPrompt(bill);
}

/**
 * Summary after edit instruction is applied.
 */
function formatEditUpdatedPrompt(bill) {
  return formatInitialReviewPrompt(bill);
}

/**
 * Formats the final confirmation request.
 */
function formatFinalConfirmation(bill) {
  return formatInitialReviewPrompt(bill);
}

/**
 * Formats the success message after creating a bill in Zoho Books.
 */
function formatSuccessReport({ bill = {}, zohoBillId, zohoBillUrl, attachmentStatus = 'NONE' }) {
  const currency = bill.currency || 'AED';
  const lines = [
    '🎉 *BILL SAVED TO ZOHO BOOKS*',
    '',
    `• *Vendor:* ${bill.vendor_name || 'N/A'}`,
    `• *Bill #:* ${bill.bill_number || 'N/A'}`,
    `• *Total:* ${bill.total_amount !== null ? formatAmount(bill.total_amount, currency) : 'N/A'}`,
    `• *Zoho Bill ID:* ${zohoBillId}`,
  ];

  if (zohoBillUrl) {
    lines.push(`• *View in Zoho Books:* ${zohoBillUrl}`);
  }

  if (bill.payment_type) lines.push(`• *Payment method:* ${bill.payment_type}`);
  const customer = bill.customer_details || {};
  if (customer.customer_name) lines.push(`• *Customer:* ${customer.customer_name}`);
  if (customer.customer_phone) lines.push(`  Phone: ${customer.customer_phone}`);
  if (customer.project_site) lines.push(`  Project/site: ${customer.project_site}`);

  if (attachmentStatus === 'ATTACHED') {
    lines.push('• *Attachment:* ✅ Original document uploaded');
  } else if (attachmentStatus === 'FAILED') {
    lines.push('• *Attachment:* ⚠️ Bill created, but file attachment upload failed');
  }

  return lines.join('\n');
}

/**
 * Formats a duplicate warning.
 */
function formatDuplicateWarning({ billNumber, vendorName, existingBillId }) {
  const billInfo = billNumber ? `Bill #${billNumber}` : 'this bill';
  const vendorInfo = vendorName ? `for vendor *${vendorName}*` : '';
  const existingId = existingBillId ? ` (Existing Zoho Bill ID: ${existingBillId})` : '';
  return `⚠️ *DUPLICATE BILL DETECTED*\n\n${billInfo} ${vendorInfo} already exists in Zoho Books${existingId}.\n\nThe bill was *not* recreated to avoid duplicate expenses. Please verify in Zoho Books or edit the bill number if this is a new bill.`;
}

/**
 * Notice for active in-progress session.
 */
function formatActiveSessionNotice() {
  return '⚠️ You already have a bill review in progress.\nPlease finish or cancel the current bill before starting another one.';
}

/**
 * Notice for cancelled bill.
 */
function formatCancellationMessage() {
  return '❌ Bill entry has been cancelled. You can send a new bill whenever you\'re ready.';
}

module.exports = {
  formatAmount,
  formatBillSummary,
  formatInitialReviewPrompt,
  formatCustomerSelectionPrompt,
  formatOrganizationSelectionPrompt,
  formatAdditionalInfoUpdatedPrompt,
  formatEditUpdatedPrompt,
  formatFinalConfirmation,
  formatSuccessReport,
  formatDuplicateWarning,
  formatActiveSessionNotice,
  formatCancellationMessage,
};
