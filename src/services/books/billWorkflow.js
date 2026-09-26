'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { validateBill, normalizeCurrency } = require('./billValidator');
const { formatInitialReviewPrompt, formatCustomerSelectionPrompt, formatOrganizationSelectionPrompt, formatSuccessReport, formatDuplicateWarning } = require('./billFormatter');
const { BOOKS_ORGANIZATIONS, resolveOrganization, findOrganizationsInText, organizationById } = require('./organizations');
const { PAYMENT_METHODS, normalizePaymentMethod } = require('./paymentMethods');
const { mediaKind, normalizeMediaMimeType } = require('../../utils/media');
// Preserve persisted legacy state names; only SAVE/1 can authorize a write.
const WORKFLOW_STATES = Object.freeze({ PROCESSING: 'EXTRACTING', AWAITING_ADDITIONAL_INFO_CHOICE: 'AWAITING_ADDITIONAL_INFO', WAITING_FOR_ADDITIONAL_INFO: 'WAITING_FOR_ADDITIONAL_INFO', WAITING_FOR_CURRENCY: 'WAITING_FOR_CURRENCY', WAITING_FOR_ORGANIZATION: 'WAITING_FOR_ORGANIZATION', WAITING_FOR_CUSTOMER_SELECTION: 'WAITING_FOR_CUSTOMER_SELECTION', AWAITING_EDIT_CHOICE: 'AWAITING_EDIT', WAITING_FOR_EDIT_INSTRUCTION: 'WAITING_FOR_EDIT_INSTRUCTION', AWAITING_FINAL_CONFIRMATION: 'AWAITING_FINAL_CONFIRMATION', SAVING: 'CREATING_IN_ZOHO', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED', FAILED: 'FAILED' });
const REVIEW = WORKFLOW_STATES.AWAITING_FINAL_CONFIRMATION;
const EDIT = WORKFLOW_STATES.WAITING_FOR_EDIT_INSTRUCTION;
const SAVING = WORKFLOW_STATES.SAVING;
const CURRENCY_PROMPT = 'Currency not detected. Please enter the currency (e.g. AED, USD, EUR).';
const CUSTOMER_DETAILS_PROMPT = 'Please send the customer details. You can type the customer/company name, phone number, email, location, or any available customer details.';
const PIPELINE_FAILURES = Object.freeze({
  DOWNLOAD: 'A_MEDIA_DOWNLOAD_FAILURE',
  EXTRACTION: 'B_OCR_VISION_EXTRACTION_FAILURE',
  JSON: 'C_INVALID_AI_JSON',
  INSUFFICIENT: 'D_INSUFFICIENT_BILL_INFORMATION',
  STORAGE: 'MEDIA_STORAGE_FAILURE',
});
function pipelineError(category, reason) {
  const error = new Error(reason);
  error.code = 'BILL_MEDIA_PIPELINE_FAILED';
  error.category = category;
  error.reason = reason;
  return error;
}
function hasBillInformation(bill = {}) {
  return Boolean(
    (typeof bill.vendor_name === 'string' && bill.vendor_name.trim())
    || (typeof bill.bill_number === 'string' && bill.bill_number.trim())
    || (bill.total_amount !== null && bill.total_amount !== undefined && Number.isFinite(bill.total_amount))
    || (Array.isArray(bill.line_items) && bill.line_items.length)
  );
}
function isWeakBillText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 30) return true;
  const signals = [
    /\b(?:invoice|bill|receipt|tax invoice)\b/i,
    /\b(?:total|subtotal|amount|vat|tax)\b/i,
    /\b(?:aed|usd|eur|gbp|sar|qar|dhs?)\b/i,
    /\b\d+(?:[.,]\d{2})\b/,
    /\b(?:vendor|supplier|sold by|from)\b/i,
  ];
  return signals.filter((pattern) => pattern.test(text)).length < 2;
}
function parseYesNo(input) {
  const value = String(input || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  return ['yes', 'y', 'yeah', 'yep'].includes(value) ? 'YES' : ['no', 'n', 'nope'].includes(value) ? 'NO' : null;
}
function command(text) {
  return ({ '1': 'SAVE', '1 SAVE': 'SAVE', SAVE: 'SAVE', '2': 'EDIT', '2 EDIT': 'EDIT', EDIT: 'EDIT', '3': 'DELETE', '3 DELETE': 'DELETE', DELETE: 'DELETE' })[String(text || '').trim().toUpperCase().replace(/\s+/g, ' ')] || null;
}
function parseCurrencyInput(text) {
  const source = String(text || '').trim().replace(/[.!?,;:]+$/, '');
  const match = source.match(/^(?:currency(?:\s+code)?\s*[:=-]?\s*)?([^\s,;]+)$/i);
  if (!match) return null;
  const normalized = normalizeCurrency(match[1]);
  return /^[A-Z]{3}$/.test(normalized || '') ? normalized : null;
}
function parseOrganizationInput(text) {
  const source = String(text || '').trim().replace(/[.!?]+$/, '');
  if (!source) return null;
  if (source === '1') return resolveOrganization(BOOKS_ORGANIZATIONS[1], { selected: true });
  if (source === '2') return resolveOrganization(BOOKS_ORGANIZATIONS[0], { selected: true });
  const candidate = source.replace(/^(?:organization|company)(?:\s+name)?(?:\s+is)?\s*[:=-]?\s*/i, '');
  return resolveOrganization(candidate, { selected: true });
}
function normalizeBillOrganization(bill = {}, previousBill = null) {
  const normalized = { ...bill, organization: resolveOrganization(bill.organization) };
  if (previousBill && previousBill.organization?.organizationId !== normalized.organization?.organizationId) {
    // Contact/accounting IDs are scoped to an organization, not portable.
    normalized.customer_details = bill.customer_details?.project_site ? { project_site: bill.customer_details.project_site } : null;
    normalized.currency_id = null;
    normalized.zoho_vendor_id = null;
    normalized.line_items = (bill.line_items || []).map(item => Object.fromEntries(Object.entries(item)
      .filter(([key]) => !['account_id', 'accountId', 'tax_id', 'taxId', 'item_id'].includes(key))));
  }
  return normalized;
}
function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}
function normalizeCustomerRecord(customer = {}) {
  const contactId = nullableText(customer.contactId ?? customer.contact_id ?? customer.id);
  const contactName = nullableText(customer.contactName ?? customer.contact_name ?? (!customer.contactId && !customer.contact_id ? customer.name : null));
  const companyName = nullableText(customer.companyName ?? customer.company_name);
  const email = nullableText(customer.email);
  const phone = nullableText(customer.phone);
  const mobile = nullableText(customer.mobile);
  const contactType = nullableText(customer.contactType ?? customer.contact_type);
  const status = nullableText(customer.status);
  const displayName = nullableText(customer.displayName)
    || (companyName && contactName && companyName !== contactName ? `${companyName} (${contactName})` : companyName || contactName);
  return { contactId, contactName, companyName, email, phone, mobile, contactType, status, displayName };
}
function isSafeContactId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
function customerNameKey(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
function parseManualCustomerDetails(text) {
  const source = String(text || '').trim().slice(0, 500)
    .replace(/^(?:customer|client)(?:\s+(?:details|name))?\s*[:=-]\s*/i, '');
  if (!source) return null;
  const details = {};
  for (const part of source.split(/[,;\n]+/).map(value => value.trim()).filter(Boolean)) {
    const label = part.match(/^(?:customer|client|company|name|phone|mobile|email|location|site|project)\s*[:=-]\s*/i)?.[0] || '';
    const email = part.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    const phone = part.match(/\+?\d[\d\s()-]{6,}\d/);
    if (email) details.customer_email = email.slice(0, 200);
    if (phone) details.customer_phone = phone[0].replace(/[\s()-]/g, '').slice(0, 20);
    const remaining = part.replace(label, '').replace(email || '', '').replace(phone?.[0] || '', '').trim();
    if (!remaining) continue;
    if (/^(?:location|site|project)/i.test(label) || (!details.customer_name && /\bsite\b/i.test(remaining))) {
      details.project_site = remaining.slice(0, 200);
    } else if (!details.customer_name) {
      details.customer_name = remaining.slice(0, 160);
    } else {
      details.project_site = [details.project_site, remaining].filter(Boolean).join(', ').slice(0, 200);
    }
  }
  return Object.keys(details).length ? details : null;
}
function hasManualCustomerFallback(bill) {
  const customer = bill.customer_details;
  return customer?.customer_source === 'manual' && customer.customer_lookup_status === 'not_found'
    && customer.organization_id === bill.organization?.organizationId;
}
function parseWorkerDetails(text, { allowShorthand = true, allowVendor = true } = {}) {
  const source = String(text || '').trim();
  if (!source) return {};
  const details = {};
  const payment = source.match(/(?:payment\s*(?:type|method)?|paid\s*by)\s*[:=-]\s*([^\n;,]+)/i);
  const shorthand = allowShorthand ? source.match(/\b(cash|bank\s+remittance|bank\s+transfer|credit\s+card|cheque)\b/i) : null;
  const paymentValue = payment?.[1]?.trim().slice(0, 80) || shorthand?.[1];
  if (paymentValue) {
    const normalizedPayment = normalizePaymentMethod(paymentValue);
    if (normalizedPayment) details.payment_type = normalizedPayment;
    else details.payment_type_invalid = paymentValue;
  }
  const customer = {};
  const customerName = source.match(/(?:customer|client)(?:\s+name)?\s*[:=-]\s*([^\n]+)/i);
  const customerPhone = source.match(/(?:customer\s*)?(?:phone|mobile|contact)\s*[:=-]?\s*(\+?\d[\d\s()-]{6,})/i);
  const projectSite = source.match(/(?:project|site|location)\s*[:=-]\s*([^\n;,]+)/i);
  if (customerName) customer.customer_name = customerName[1].split(';')[0].trim().slice(0, 160);
  if (customerPhone) customer.customer_phone = customerPhone[1].replace(/[\s()-]/g, '').slice(0, 20);
  if (projectSite) customer.project_site = projectSite[1].trim().slice(0, 200);
  if (customerName && (!customerPhone || !projectSite)) {
    const parts = customerName[1].split(',').map(part => part.trim()).filter(Boolean);
    if (parts[0]) customer.customer_name = parts[0].slice(0, 160);
    if (!customerPhone && parts[1] && /^\+?\d[\d\s()-]{6,}$/.test(parts[1])) customer.customer_phone = parts[1].replace(/[\s()-]/g, '').slice(0, 20);
    if (!projectSite && parts[2]) customer.project_site = parts.slice(2).join(', ').slice(0, 200);
  }
  if (Object.keys(customer).length) details.customer_details = customer;
  if (allowVendor) {
    const vendorName = source.match(/(?:vendor|supplier)(?:\s+name)?\s*[:=-]\s*([^\n;,]+)/i);
    if (vendorName) details.vendor_name = vendorName[1].trim().slice(0, 200);
    const vendorTrn = source.match(/(?:vendor\s+)?(?:TRN|tax\s+registration\s+number)\s*[:=-]\s*([A-Za-z0-9-]+)/i);
    if (vendorTrn) details.vendor_trn = vendorTrn[1].slice(0, 80);
  }
  const currency = parseCurrencyInput(source);
  if (currency) details.currency = currency;
  const organization = parseOrganizationInput(source);
  if (organization) details.organization = organization;
  return details;
}
function mergeWorkerDetails(currentBill, text, parsed = parseWorkerDetails(text)) {
  const existing = currentBill.customer_details || {};
  return {
    ...currentBill,
    ...(parsed.vendor_name ? { vendor_name: parsed.vendor_name, vendor_trn: parsed.vendor_trn || null, zoho_vendor_id: null } : {}),
    ...(!parsed.vendor_name && parsed.vendor_trn ? { vendor_trn: parsed.vendor_trn } : {}),
    ...(parsed.currency ? { currency: parsed.currency } : {}),
    ...(parsed.organization ? { organization: parsed.organization } : {}),
    ...(parsed.payment_type ? { payment_type: parsed.payment_type } : {}),
    ...(parsed.customer_details ? { customer_details: parsed.customer_details.customer_name
      ? { ...parsed.customer_details }
      : { ...existing, ...parsed.customer_details } } : {}),
  };
}
function vendorNameKey(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
function isUnpricedSourceLine(item) {
  return item && item.rate == null && item.amount == null;
}
function reconciledUnpricedLines(bill) {
  if (!Array.isArray(bill.line_items) || ![bill.subtotal, bill.tax_amount, bill.total_amount].every(Number.isFinite)) return [];
  const unpriced = bill.line_items.flatMap((item, index) => isUnpricedSourceLine(item) ? [index] : []);
  if (!unpriced.length) return [];
  const priced = bill.line_items.filter(item => !isUnpricedSourceLine(item));
  if (!priced.length || priced.some(item => !Number.isFinite(item.quantity) || item.quantity <= 0
      || !Number.isFinite(item.rate) || item.rate < 0
      || (item.amount != null && (!Number.isFinite(item.amount) || Math.abs(item.quantity * item.rate - item.amount) > 0.05))
      || !Number.isFinite(item.tax_percentage) || item.tax_percentage < 0 || item.tax_percentage > 100)) return [];
  const subtotal = priced.reduce((sum, item) => sum + item.quantity * item.rate, 0);
  const tax = priced.reduce((sum, item) => sum + item.quantity * item.rate * item.tax_percentage / 100, 0);
  return Math.abs(subtotal - bill.subtotal) <= 0.05
    && Math.abs(tax - bill.tax_amount) <= 0.05
    && Math.abs(bill.subtotal + bill.tax_amount - bill.total_amount) <= 0.05 ? unpriced : [];
}
function taxAllocation(bill, requireAccounting) {
  if (!requireAccounting || !(bill.tax_amount > 0) || !Array.isArray(bill.line_items)) return { missingLines: [], mismatch: false };
  const priced = bill.line_items.filter(item => !isUnpricedSourceLine(item));
  const missingLines = bill.line_items.flatMap((item, index) => isUnpricedSourceLine(item)
    || (Number.isFinite(item?.tax_percentage) && item.tax_percentage >= 0 && item.tax_percentage <= 100) ? [] : [index + 1]);
  // An unpriced source line may contain the remaining tax base. Until the
  // subtotal proves it contributes nothing, ask for its amounts, not its rate.
  const calculated = missingLines.length || priced.length !== bill.line_items.length
    || priced.some(item => !Number.isFinite(item.quantity) || !Number.isFinite(item.rate))
    ? null : priced.reduce((sum, item) => sum + item.quantity * item.rate * item.tax_percentage / 100, 0);
  return { missingLines, mismatch: calculated !== null && Math.abs(calculated - bill.tax_amount) > 0.05 };
}
function parseLineTaxInput(text, bill) {
  const source = String(text || '').trim();
  const updates = new Map();
  const entries = source.split(/[\n;]+/).map(part => part.trim()).filter(Boolean);
  for (const entry of entries) {
    const match = entry.match(/^(?:line|item)\s+(\d{1,3})\s+tax(?:\s+percentage)?\s*[:=]\s*(\d+(?:\.\d{1,2})?)\s*%?$/i);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > (bill.line_items?.length || 0) || Number(match[2]) > 100) return null;
    updates.set(Number(match[1]) - 1, Number(match[2]));
  }
  if (!updates.size && entries.length === 1 && bill.line_items?.length === 1 && taxAllocation(bill, true).missingLines.length === 1) {
    const match = entries[0].match(/^(\d+(?:\.\d{1,2})?)\s*%?$/);
    if (match && Number(match[1]) <= 100) updates.set(0, Number(match[1]));
  }
  return updates.size ? bill.line_items.map((item, index) => updates.has(index) ? { ...item, tax_percentage: updates.get(index) } : item) : null;
}
function billMissingFields(bill, { requireCustomerId = false, requireAccounting = false } = {}) {
  const validation = validateBill(bill);
  const sourceOnlyLines = reconciledUnpricedLines(bill);
  const missing = [];
  if (!bill.vendor_name) missing.push('vendor name');
  if (!bill.bill_number) missing.push('bill number');
  if (!bill.bill_date) missing.push('bill date');
  if (!bill.currency) missing.push('currency');
  if (!bill.customer_details?.customer_name || (requireCustomerId && !(bill.customer_details.contact_id || bill.customer_details.customer_id)
      && !hasManualCustomerFallback(bill))) missing.push('customer');
  if (!bill.payment_type) missing.push('payment method');
  if (!bill.line_items?.length || bill.line_items.some((item, index) => !item.name || (!sourceOnlyLines.includes(index)
      && (!Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.rate) || item.rate < 0)))) missing.push('line items with quantity and rate');
  if (requireAccounting && (bill.subtotal == null || bill.tax_amount == null)) missing.push('subtotal and tax');
  const tax = taxAllocation(bill, requireAccounting);
  if (tax.missingLines.length || tax.mismatch) missing.push('line-item tax allocation');
  return { missing, validation, tax, sourceOnlyLines };
}
function createBillWorkflow({ billStore, billExtractionService, zohoBooksClient, whatsappService = null, aiService = null, store = null, config = {}, logger = null } = {}) {
  function log(level, metadata) {
    try { logger?.[level]?.(metadata); } catch { /* Ignore logger failures */ }
  }
  function reply(session, text, extra = {}) {
    return { success: true, sessionId: session?.session_id, billId: session?.bill_id, state: session?.state, replyText: text, ...extra };
  }
  async function requestCurrency(session, bill, messageId) {
    await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_CURRENCY, bill_data: bill, last_message_id: messageId });
    return reply(session, CURRENCY_PROMPT, { state: WORKFLOW_STATES.WAITING_FOR_CURRENCY, bill });
  }
  async function requestOrganization(session, bill, messageId) {
    await billStore.updateBill(session.bill_id, { organization: bill.organization });
    await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_ORGANIZATION, bill_data: bill, customer_options: [], last_message_id: messageId });
    return reply(session, formatOrganizationSelectionPrompt(bill), { state: WORKFLOW_STATES.WAITING_FOR_ORGANIZATION, bill });
  }
  async function continueAfterOrganization(session, bill, messageId) {
    if (!bill.organization) return requestOrganization(session, bill, messageId);
    if (!bill.currency) return requestCurrency(session, bill, messageId);
    if (!bill.vendor_name) {
      await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill_data: bill, last_message_id: messageId });
      return reply(session, 'Vendor was not detected. Please send Vendor: followed by the vendor name.', { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill });
    }
    let vendorResolution;
    try { vendorResolution = await resolveVendor(bill); }
    catch {
      await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill_data: bill, last_message_id: messageId });
      return reply(session, 'I could not check the vendor in Zoho Books. Please try again.', { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill });
    }
    if ((vendorResolution.status === 'not_found' && bill.zoho_vendor_id)
        || (vendorResolution.status !== 'found' && vendorResolution.status !== 'not_found')) {
      await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill_data: bill, last_message_id: messageId });
      const text = vendorResolution.status === 'not_found' ? 'The reviewed vendor could not be verified in Zoho Books. Please check the vendor before saving.'
        : vendorResolution.status === 'inactive' ? 'The matching vendor is inactive in Zoho Books. Please check the vendor there or reply EDIT with a correction.'
        : vendorResolution.status === 'wrong_organization' ? 'Vendor does not belong to the selected organization. Please select the organization again.'
          : 'Multiple vendors match this name in Zoho Books. Please send Vendor TRN: followed by the vendor tax registration number, or reply EDIT with a correction.';
      return reply(session, text, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill });
    }
    bill.zoho_vendor_id = vendorResolution.vendor?.id || null;
    await billStore.updateBill(session.bill_id, { zoho_vendor_id: bill.zoho_vendor_id });
    const customer = bill.customer_details || {};
    if (typeof zohoBooksClient?.searchCustomer === 'function' && !hasManualCustomerFallback(bill)
        && (!(customer.contact_id || customer.customer_id) || customer.organization_id !== bill.organization.organizationId)) {
      const customerPrompt = await askForCustomer(session, bill);
      if (customerPrompt) return customerPrompt;
    }
    if (!bill.payment_type) {
      await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill_data: bill, last_message_id: messageId });
      return reply(session, `Before SAVE, send payment method: ${PAYMENT_METHODS.join(' / ')}`, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill });
    }
    const { missing, validation, tax, sourceOnlyLines } = billMissingFields(bill, { requireCustomerId: typeof zohoBooksClient?.searchCustomer === 'function', requireAccounting: typeof zohoBooksClient?.prepareBill === 'function' });
    if (tax.missingLines.length || tax.mismatch) {
      await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill_data: bill, last_message_id: messageId });
      const detail = tax.missingLines.length ? `Tax percentage missing for line ${tax.missingLines.join(', ')}.` : 'Line-item tax does not match the bill tax total.';
      return reply(session, `${detail} Send the percentage for each affected item, for example: Line 1 tax: 5%`, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill });
    }
    if (missing.length || !validation.valid) {
      await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill_data: bill, last_message_id: messageId });
      if (missing.includes('customer') && !customer.customer_name) return reply(session, CUSTOMER_DETAILS_PROMPT, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill });
      return reply(session, `Cannot review yet: ${missing.length ? `Please supply ${missing.join(', ')}.` : validation.issues[0].message} Reply EDIT with the missing or corrected details.`, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill });
    }
    await billStore.updateBillSession(session.session_id, { state: REVIEW, bill_data: bill, last_message_id: messageId });
    const review = formatInitialReviewPrompt(bill);
    const sourceLineNotice = sourceOnlyLines.length
      ? `\nUnpriced source line(s) ${sourceOnlyLines.map(index => index + 1).join(', ')} are shown for reference but will not be created as Zoho bill items.` : '';
    return reply(session, `${review}${sourceLineNotice}`, { state: REVIEW, bill });
  }
  async function resolveVendor(bill) {
    const organizationId = bill.organization.organizationId;
    const vendors = await zohoBooksClient.searchVendor({ searchText: bill.vendor_name, name: bill.vendor_name, organizationId });
    const name = vendorNameKey(bill.vendor_name);
    const nameMatches = (vendors || []).filter(vendor => name && [vendor.name, vendor.companyName].some(value => vendorNameKey(value) === name));
    const matchingTrn = bill.vendor_trn ? nameMatches.filter(vendor => vendorNameKey(vendor.trn) === vendorNameKey(bill.vendor_trn)) : [];
    const matches = matchingTrn.length ? matchingTrn : nameMatches;
    if (bill.vendor_trn && nameMatches.length && !matchingTrn.length) return { status: 'ambiguous' };
    if (matches.some(vendor => {
      const scope = vendor.organizationId || vendor.organization_id || vendor.raw?.organization_id;
      return scope && String(scope) !== organizationId;
    })) return { status: 'wrong_organization' };
    const active = matches.filter(vendor => String(vendor.status || 'active').toLowerCase() === 'active');
    if (active.length > 1) return { status: 'ambiguous' };
    if (active.length === 1 && active[0].id) return { status: 'found', vendor: active[0] };
    if (matches.length) return { status: 'inactive' };
    return { status: 'not_found' };
  }
  function organizationSelectionPrompt(session) {
    return formatOrganizationSelectionPrompt(session.bill_data || {});
  }
  async function applyOrganization(session, incoming) {
    const organization = parseOrganizationInput(incoming.text);
    if (!organization) return reply(session, organizationSelectionPrompt(session), { state: WORKFLOW_STATES.WAITING_FOR_ORGANIZATION, bill: session.bill_data });
    const bill = normalizeBillOrganization({ ...session.bill_data, organization }, session.bill_data);
    await billStore.updateBill(session.bill_id, { ...bill, status: 'PENDING_REVIEW' });
    await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill_data: bill, customer_options: [], last_message_id: incoming.messageId });
    return continueAfterOrganization(session, bill, incoming.messageId);
  }
  async function applyCurrency(session, incoming) {
    const currency = parseCurrencyInput(incoming.text);
    if (!currency) return reply(session, CURRENCY_PROMPT, { state: WORKFLOW_STATES.WAITING_FOR_CURRENCY, bill: session.bill_data });
    const bill = normalizeBillOrganization(validateBill({ ...session.bill_data, currency }).normalizedBill);
    if (!bill.organization) return requestOrganization(session, bill, incoming.messageId);
    const attachments = session.attachments || [];
    await billStore.updateBill(session.bill_id, { ...bill, attachments, status: 'PENDING_REVIEW' });
    await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill_data: bill, attachments, customer_options: [], last_message_id: incoming.messageId });
    return continueAfterOrganization(session, bill, incoming.messageId);
  }
  async function askForCustomer(session, bill, searchText = '', { manualInput = false, messageId = null } = {}) {
    if (!bill.organization?.organizationId) return requestOrganization(session, bill);
    if (typeof zohoBooksClient?.searchCustomer !== 'function') return null;
    const detailsPrompt = bill.customer_details?.customer_name ? '' : `${CUSTOMER_DETAILS_PROMPT}\n`;
    let customers;
    try {
      customers = await zohoBooksClient.searchCustomer({ searchText, organizationId: bill.organization?.organizationId });
    } catch {
      await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION, bill_data: bill, customer_options: [] });
      return reply(session, `${detailsPrompt}I could not load the Zoho Books customer list. Reply EDIT with the customer name, or try again.`, { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION, bill });
    }
    const options = (customers || []).map(customer => {
      const scope = customer.organizationId || customer.organization_id || customer.raw?.organization_id;
      if (scope && scope !== bill.organization.organizationId) return null;
      const normalized = normalizeCustomerRecord(customer);
      if (!isSafeContactId(normalized.contactId) || !normalized.displayName) return null;
      return {
        id: normalized.contactId,
        contactId: normalized.contactId,
        contactName: normalized.contactName,
        companyName: normalized.companyName,
        email: normalized.email,
        phone: normalized.phone,
        mobile: normalized.mobile,
        contactType: normalized.contactType,
        status: normalized.status,
        name: normalized.displayName.slice(0, 160),
        displayName: normalized.displayName.slice(0, 160),
        description: String(normalized.phone || normalized.mobile || normalized.email || '').slice(0, 72),
        organizationId: bill.organization?.organizationId,
      };
    }).filter(Boolean);
    const continueWithManualCustomer = async () => {
      const customerDetails = { ...bill.customer_details, customer_lookup_status: 'not_found', organization_id: bill.organization.organizationId };
      const manualBill = { ...bill, customer_details: customerDetails };
      await billStore.updateBill(session.bill_id, { customer_details: customerDetails });
      await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill_data: manualBill, customer_options: [], last_message_id: messageId });
      return continueAfterOrganization(session, manualBill, messageId);
    };
    if (!options.length) {
      if (manualInput && bill.customer_details?.customer_name) return continueWithManualCustomer();
      await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION, bill_data: bill, customer_options: [] });
      return reply(session, `${detailsPrompt}${searchText ? 'No matching Zoho Books customer was found. Reply with another customer name.' : 'No Zoho Books customers were found. Reply EDIT with the customer name.'}`, { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION, bill });
    }
    if (manualInput && bill.customer_details?.customer_name) {
      const name = customerNameKey(bill.customer_details.customer_name);
      const exact = options.filter(option => [option.contactName, option.companyName].some(value => customerNameKey(value) === name));
      if (exact.length === 1 && (!exact[0].contactType || exact[0].contactType === 'customer')
          && (!exact[0].status || exact[0].status.toLowerCase() === 'active')) {
        await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION, customer_options: options, bill_data: bill });
        return selectCustomer({ ...session, customer_options: options, bill_data: bill }, {
          interactiveId: `zoho-customer:${exact[0].contactId}`, messageId, manualInput: true,
        });
      }
      if (!exact.length) return continueWithManualCustomer();
    }
    const visibleOptions = options.slice(0, 10);
    await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION, customer_options: visibleOptions, bill_data: bill });
    return reply(session, `${detailsPrompt}${formatCustomerSelectionPrompt(visibleOptions)}`, {
      state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION,
      bill,
      replyInteractive: {
        header: 'Customer details', body: 'Select the customer from Zoho Books.', footer: organizationById(bill.organization.organizationId).displayName,
        button: 'Select customer', sections: [{ title: 'Zoho Books customers', rows: visibleOptions.map(option => ({ id: `zoho-customer:${option.contactId}`, title: option.name.slice(0, 24), description: option.description })) }],
      },
    });
  }
  async function selectCustomer(session, incoming) {
    const options = Array.isArray(session.customer_options) ? session.customer_options : [];
    const rawId = incoming.interactiveId || (options[Number(incoming.text) - 1] ? `zoho-customer:${options[Number(incoming.text) - 1].contactId || options[Number(incoming.text) - 1].id}` : '');
    const option = options.find(candidate => rawId === `zoho-customer:${candidate.contactId || candidate.id}` || rawId === (candidate.contactId || candidate.id));
    if (!option) return reply(session, 'Please select one of the customers shown in the Zoho Books list.', { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION });
    const selectedId = option.contactId || option.id;
    const organizationId = session.bill_data?.organization?.organizationId;
    if (!organizationId) return requestOrganization(session, session.bill_data, incoming.messageId);
    if (option.organizationId !== organizationId) return askForCustomer(session, session.bill_data);
    let selectedRecord = option;
    if (typeof zohoBooksClient?.getCustomer === 'function') {
      try {
        selectedRecord = await zohoBooksClient.getCustomer(selectedId, { organizationId });
      } catch {
        return reply(session, 'I could not load the selected Zoho Books customer. Please select it again or search by customer name.', { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION });
      }
    }
    const customer = normalizeCustomerRecord(selectedRecord);
    const selectedScope = selectedRecord.organizationId || selectedRecord.organization_id || selectedRecord.raw?.organization_id;
    if (customer.contactId !== selectedId || !customer.displayName || (selectedScope && selectedScope !== organizationId)) {
      return reply(session, 'The selected Zoho Books customer could not be verified. Please select it again.', { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION });
    }
    if (customer.contactType && customer.contactType !== 'customer') return reply(session, 'The selected Zoho Books customer could not be verified. Please select it again.', { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION });
    if (customer.status && customer.status.toLowerCase() !== 'active') return reply(session, 'The selected Zoho Books customer is inactive. Please select another customer.', { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION });
    // Zoho is authoritative, including missing values; do not retain OCR guesses.
    const currentDetails = { ...(session.bill_data?.customer_details || {}) };
    delete currentDetails.customer_source;
    delete currentDetails.customer_lookup_status;
    const manualDetails = incoming.manualInput ? currentDetails : null;
    const customerDetails = {
      ...currentDetails,
      customer_id: customer.contactId,
      contact_id: customer.contactId,
      organization_id: organizationId,
      customer_name: manualDetails?.customer_name || customer.displayName,
      contact_name: customer.contactName,
      company_name: customer.companyName,
      customer_contact_name: customer.contactName,
      customer_company_name: customer.companyName,
      customer_phone: manualDetails?.customer_phone || customer.phone,
      customer_mobile: customer.mobile,
      customer_email: manualDetails?.customer_email || customer.email,
      customer_contact_type: customer.contactType,
      customer_status: customer.status,
      ...(manualDetails ? { customer_source: 'manual' } : {}),
    };
    const bill = { ...session.bill_data, customer_details: customerDetails };
    await billStore.updateBill(session.bill_id, { ...bill, status: 'PENDING_REVIEW' });
    await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill_data: bill, customer_options: [], last_message_id: incoming.messageId });
    return continueAfterOrganization(session, bill, incoming.messageId);
  }
  async function readSingleInput(incoming) {
    const media = Boolean(incoming.mediaId || incoming.mediaBuffer || ['image', 'document', 'pdf', 'audio'].includes(incoming.messageType));
    if (!media) return { text: incoming.text || '', attachment: null, media: null, ocrError: null };
    let buffer = incoming.mediaBuffer;
    let mimeType = incoming.mediaMimeType;
    if (!buffer && incoming.mediaId && whatsappService?.downloadMedia) {
      try {
        const downloaded = await whatsappService.downloadMedia(incoming.mediaId);
        buffer = Buffer.isBuffer(downloaded) ? downloaded : downloaded?.buffer;
        mimeType = downloaded?.mimeType || mimeType;
      } catch (error) {
        throw pipelineError(PIPELINE_FAILURES.DOWNLOAD, error?.code || 'WHATSAPP_MEDIA_DOWNLOAD_FAILED');
      }
    }
    mimeType = normalizeMediaMimeType(mimeType);
    const kind = mediaKind(mimeType);
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw pipelineError(PIPELINE_FAILURES.DOWNLOAD, 'MEDIA_BYTES_UNAVAILABLE');
    if (!kind) throw pipelineError(PIPELINE_FAILURES.DOWNLOAD, 'MEDIA_TYPE_UNSUPPORTED');
    if (!store?.saveMediaFile) throw pipelineError(PIPELINE_FAILURES.STORAGE, 'MEDIA_STORAGE_UNAVAILABLE');
    const filename = incoming.mediaFilename || `bill-${randomUUID()}.${mimeType === 'application/pdf' ? 'pdf' : mimeType.split('/')[1] || 'bin'}`;
    const savePromise = Promise.resolve()
      .then(() => store.saveMediaFile({ messageId: incoming.messageId, mediaId: incoming.mediaId, buffer, mimeType, filename }))
      .catch(error => { throw pipelineError(PIPELINE_FAILURES.STORAGE, error?.code || 'MEDIA_PERSIST_FAILED'); });
    let ocrError = null;
    const ocrPromise = Promise.resolve().then(async () => {
      if (typeof aiService?.extractMediaText !== 'function') throw Object.assign(new Error(), { code: 'OCR_SERVICE_UNAVAILABLE' });
      const result = await aiService.extractMediaText({ buffer, mimeType, type: kind });
      if (typeof result !== 'string' || !result.trim()) throw Object.assign(new Error(), { code: 'OCR_EMPTY_RESULT' });
      return result;
    }).catch(error => {
      ocrError = error?.code || 'OCR_EXTRACTION_FAILED';
      log('warn', { event: 'books.bill_media_pipeline.ocr_failed', category: PIPELINE_FAILURES.EXTRACTION, reason: ocrError, messageId: incoming.messageId, mimeType });
      return '';
    });
    // Storage and OCR consume the same downloaded bytes but are independent.
    // Await both so the attachment remains durable while their latency overlaps.
    const [saved, ocrText] = await Promise.all([savePromise, ocrPromise]);
    const storageReference = typeof saved === 'string' ? saved : saved?.storageReference;
    if (!storageReference) throw pipelineError(PIPELINE_FAILURES.STORAGE, 'MEDIA_NOT_PERSISTED');
    const attachment = { storage_reference: storageReference, original_filename: filename, mime_type: mimeType, media_id: incoming.mediaId, message_id: incoming.messageId };
    return {
      text: [ocrText, incoming.text].filter((value) => typeof value === 'string' && value.trim()).join('\n'),
      attachment,
      media: { buffer, mimeType, kind, filename, messageId: incoming.messageId },
      ocrError,
    };
  }
  async function readInput(incoming) {
    const startedAt = Date.now();
    const items = Array.isArray(incoming.items) && incoming.items.length ? incoming.items : [incoming];
    const settled = await Promise.allSettled(items.map(readSingleInput));
    const text = [];
    const attachments = [];
    const media = [];
    const ocrErrors = [];
    const failedMessageIds = [];
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index];
      if (outcome.status === 'fulfilled') {
        if (outcome.value.text?.trim()) text.push(outcome.value.text.trim());
        if (outcome.value.attachment) attachments.push(outcome.value.attachment);
        if (outcome.value.media) media.push(outcome.value.media);
        if (outcome.value.ocrError) ocrErrors.push(outcome.value.ocrError);
      } else {
        failedMessageIds.push(items[index].messageId);
        const error = outcome.reason;
        log('error', {
          event: 'books.bill_media_pipeline.failed',
          category: error?.category || PIPELINE_FAILURES.DOWNLOAD,
          reason: error?.reason || error?.code || 'MEDIA_INPUT_FAILED',
          messageId: items[index].messageId,
        });
      }
    }
    if (failedMessageIds.length) throw settled.find((outcome) => outcome.status === 'rejected').reason;
    if (!text.length && !media.some((item) => ['image', 'document'].includes(item.kind))) {
      throw pipelineError(PIPELINE_FAILURES.EXTRACTION, ocrErrors[0] || 'NO_EXTRACTABLE_BILL_INPUT');
    }
    log('info', {
      event: 'books_media_ready',
      batch_size: items.length,
      media_count: media.length,
      duration_ms: Date.now() - startedAt,
    });
    return { text: text.join('\n'), attachment: attachments[0] || null, attachments, media, ocrErrors, failedMessageIds };
  }
  function groundedBill(extracted) {
    const grounded = { ...extracted.bill };
    for (const [field, evidence] of Object.entries(extracted.grounding || {})) {
      if (evidence === 'inferred' || evidence === 'ambiguous') grounded[field] = field === 'line_items' ? [] : null;
    }
    if (Object.prototype.hasOwnProperty.call(extracted.grounding || {}, 'organization')
        && extracted.grounding.organization !== 'explicit') grounded.organization = null;
    return normalizeBillOrganization(grounded);
  }
  async function extractBillFromInput(input, sourceType) {
    const directMedia = (input.media || []).filter((item) => ['image', 'document'].includes(item.kind));
    const weakText = isWeakBillText(input.text);
    const attempts = [];
    const tryText = async () => {
      if (!input.text?.trim()) return null;
      const result = await billExtractionService.extractBillFromText({ text: input.text, sourceType });
      attempts.push(result);
      return result;
    };
    const tryMedia = async () => {
      if (!directMedia.length || typeof billExtractionService.extractBillFromMedia !== 'function') return null;
      log('info', {
        event: 'books.bill_media_pipeline.vision_fallback',
        reason: input.ocrErrors?.length ? 'OCR_FAILED' : weakText ? 'OCR_TEXT_WEAK' : 'TEXT_EXTRACTION_FAILED',
        mediaCount: directMedia.length,
      });
      const result = await billExtractionService.extractBillFromMedia({ media: directMedia, caption: input.text || '', sourceType });
      attempts.push(result);
      return result;
    };

    if (!weakText || !directMedia.length) {
      const textResult = await tryText();
      if (textResult?.success && textResult.bill && hasBillInformation(textResult.bill)) return textResult;
    }
    const mediaResult = await tryMedia();
    if (mediaResult?.success && mediaResult.bill && hasBillInformation(mediaResult.bill)) return mediaResult;
    if (weakText && input.text?.trim() && directMedia.length) {
      const textResult = await tryText();
      if (textResult?.success && textResult.bill && hasBillInformation(textResult.bill)) return textResult;
    }

    if (attempts.some((result) => result?.success && result.bill)) {
      throw pipelineError(PIPELINE_FAILURES.INSUFFICIENT, 'NO_IDENTIFYING_OR_FINANCIAL_BILL_FIELDS');
    }
    if (attempts.length && attempts.every((result) => result?.error?.code === 'AI_MALFORMED_RESPONSE')) {
      throw pipelineError(PIPELINE_FAILURES.JSON, 'AI_MALFORMED_RESPONSE');
    }
    throw pipelineError(PIPELINE_FAILURES.EXTRACTION, attempts.find((result) => result?.error?.code)?.error.code || input.ocrErrors?.[0] || 'OCR_AND_VISION_FAILED');
  }
  async function processUnlocked(incoming) {
    if (!incoming.senderPhone) return reply(null, 'Sender phone is required.', { success: false });
    if (config.booksSenders && !config.booksSenders.has(incoming.senderPhone)) return reply(null, null, { success: false, error: { code: 'NOT_AUTHORIZED' } });
    const session = await billStore.getActiveBillSession(incoming.senderPhone);
    const cmd = command(incoming.text);
    const sourceItems = Array.isArray(incoming.items) && incoming.items.length ? incoming.items : [incoming];
    const media = sourceItems.some(item => Boolean(item.mediaId || item.mediaBuffer || ['image', 'document', 'pdf', 'audio'].includes(item.messageType)));
    if (session?.last_message_id === incoming.messageId && incoming.messageId) return reply(session, null, { idempotent: true });
    if (session) {
      const existing = await billStore.getBill(session.bill_id);
      if (session.state === SAVING || existing?.zoho_bill_id) {
        if (existing?.zoho_bill_id && cmd === 'SAVE') return finishCreated(session, existing);
        return reply(session, existing?.zoho_bill_id ? `Bill already created (ID: ${existing.zoho_bill_id}). Reply SAVE to retry any failed attachment or PDF delivery. No new bill will be created.` : 'The save outcome is unconfirmed. Your draft is retained and locked to prevent duplicates. Please ask an administrator to reconcile it in Zoho Books.');
      }
      if (session.state === WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION && !media) {
        const choice = String(incoming.text || '').trim();
        const hasDisplayedOptions = Boolean(session.customer_options?.length);
        if (incoming.interactiveId || (/^[+-]?\d+$/.test(choice) && (hasDisplayedOptions || !/^0\d{7,}$/.test(choice)))) {
          return selectCustomer(session, incoming);
        }
      }
      if (!media && cmd === 'DELETE') {
        await billStore.updateBill(session.bill_id, { status: 'CANCELLED', line_items: [], attachments: [], notes: null, organization: null, currency: null, currency_id: null, customer_details: null, zoho_vendor_id: null });
        await billStore.updateBillSession(session.session_id, { state: 'CANCELLED', bill_data: {}, customer_options: [], attachments: [], last_message_id: incoming.messageId });
        return reply(session, 'Pending bill deleted. Nothing was sent to Zoho Books. Please send the next bill.', { state: 'CANCELLED' });
      }
      if (session.state === WORKFLOW_STATES.WAITING_FOR_ORGANIZATION && !media) {
        if (cmd === 'EDIT' && incoming.text?.trim() !== '2') {
          await billStore.updateBillSession(session.session_id, { state: EDIT, last_message_id: incoming.messageId });
          return reply(session, 'Send the organization name or number (1 or 2), or another correction.', { state: EDIT });
        }
        return applyOrganization(session, incoming);
      }
      if (!media && cmd === 'SAVE') {
        const key = createHash('sha256').update(`${session.bill_data?.vendor_name || ''}\n${session.bill_data?.bill_number || ''}`.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex');
        const run = () => save(session, incoming.messageId);
        return store?.withContactLock ? store.withContactLock(`books-bill:${key}`, run) : run();
      }
      if (!media && cmd === 'EDIT') {
        await billStore.updateBillSession(session.session_id, { state: EDIT, last_message_id: incoming.messageId });
        return reply(session, 'Send corrections, a clearer image, another page of this same bill, or a voice note. Other fields will be preserved.', { state: EDIT });
      }
      if (session.state === WORKFLOW_STATES.WAITING_FOR_CURRENCY && !media) {
        return applyCurrency(session, incoming);
      }
      if (session.state === WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION && !media) {
        if (parseOrganizationInput(incoming.text)) return applyOrganization(session, incoming);
        if (/^(?:customer|client)(?:\s+(?:details|name))?\s*[:=-]/i.test(String(incoming.text || '').trim())) {
          const parsed = parseWorkerDetails(incoming.text);
          if (parsed.customer_details) {
            const bill = mergeWorkerDetails(session.bill_data, incoming.text, parsed);
            await billStore.updateBill(session.bill_id, { customer_details: bill.customer_details });
            await billStore.updateBillSession(session.session_id, { bill_data: bill, customer_options: [], last_message_id: incoming.messageId });
            return askForCustomer(session, bill, bill.customer_details.customer_name || '');
          }
        }
        const parsed = parseManualCustomerDetails(incoming.text);
        if (!parsed) return reply(session, CUSTOMER_DETAILS_PROMPT, { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION, bill: session.bill_data });
        const previous = session.bill_data?.customer_details || {};
        const customerDetails = {
          ...(parsed.customer_name && previous.customer_source !== 'manual' ? {} : previous), ...parsed,
          customer_id: null, contact_id: null, organization_id: session.bill_data.organization.organizationId,
          customer_source: 'manual', customer_lookup_status: null,
        };
        const bill = { ...session.bill_data, customer_details: customerDetails };
        await billStore.updateBill(session.bill_id, { customer_details: customerDetails });
        await billStore.updateBillSession(session.session_id, { bill_data: bill, customer_options: [], last_message_id: incoming.messageId });
        if (!customerDetails.customer_name) return reply(session, CUSTOMER_DETAILS_PROMPT, { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION, bill });
        if (typeof zohoBooksClient?.searchCustomer !== 'function') return continueAfterOrganization(session, bill, incoming.messageId);
        return askForCustomer(session, bill, customerDetails.customer_name, { manualInput: true, messageId: incoming.messageId });
      }
      if (session.state === WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO && !media && !session.bill_data?.customer_details?.customer_name
          && typeof zohoBooksClient?.searchCustomer !== 'function' && !Object.keys(parseWorkerDetails(incoming.text)).length) {
        const parsed = parseManualCustomerDetails(incoming.text);
        if (parsed) {
          const previous = session.bill_data?.customer_details || {};
          const customerDetails = { ...previous, ...parsed, customer_source: 'manual' };
          const bill = { ...session.bill_data, customer_details: customerDetails };
          await billStore.updateBill(session.bill_id, { customer_details: customerDetails });
          await billStore.updateBillSession(session.session_id, { bill_data: bill, last_message_id: incoming.messageId });
          return continueAfterOrganization(session, bill, incoming.messageId);
        }
      }
      const lineItemsWithTax = !media && !cmd && session.state === WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO
        ? parseLineTaxInput(incoming.text, session.bill_data) : null;
      if (lineItemsWithTax) {
        const bill = normalizeBillOrganization(validateBill({ ...session.bill_data, line_items: lineItemsWithTax }).normalizedBill);
        await billStore.updateBill(session.bill_id, { line_items: bill.line_items });
        await billStore.updateBillSession(session.session_id, { bill_data: bill, last_message_id: incoming.messageId });
        return continueAfterOrganization(session, bill, incoming.messageId);
      }
      if (!media && !cmd && Object.keys(parseWorkerDetails(incoming.text)).length) {
        const parsed = parseWorkerDetails(incoming.text);
        if (parsed.organization) return applyOrganization(session, incoming);
        if (parsed.payment_type_invalid) return reply(session, `Payment method must be one of: ${PAYMENT_METHODS.join(', ')}.`, { state: REVIEW, bill: session.bill_data });
        const bill = normalizeBillOrganization(mergeWorkerDetails(session.bill_data || {}, incoming.text, parsed));
        const attachments = session.attachments || [];
        await billStore.updateBill(session.bill_id, { ...bill, attachments, status: 'PENDING_REVIEW' });
        await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill_data: bill, attachments, last_message_id: incoming.messageId });
        return continueAfterOrganization(session, bill, incoming.messageId);
      }
      if (session.state !== EDIT && session.state !== WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO) return reply(session, media ? 'A bill is already pending. Reply EDIT to add a page or correction to this same bill. Otherwise SAVE or DELETE it before sending another bill.' : 'Reply SAVE, EDIT, or DELETE for this bill.');
      const editDetails = parseWorkerDetails(incoming.text);
      if (!media && editDetails.payment_type_invalid) return reply(session, `Payment method must be one of: ${PAYMENT_METHODS.join(', ')}.`, { state: EDIT });
      if (!media && session.state === EDIT && editDetails.currency) return applyCurrency(session, incoming);
      if (!media && session.state === EDIT && editDetails.organization) return applyOrganization(session, incoming);
      try {
        const input = await readInput(incoming);
        let edited;
        let directMediaExtraction = false;
        if (media && isWeakBillText(input.text) && input.media?.some((item) => ['image', 'document'].includes(item.kind))) {
          edited = await extractBillFromInput(input, incoming.messageType || 'media_edit');
          directMediaExtraction = true;
        } else {
          edited = media ? await billExtractionService.mergeAdditionalInfo({ currentBill: session.bill_data, additionalText: input.text }) : await billExtractionService.applyEditInstructions({ currentBill: session.bill_data, editInstruction: input.text });
        }
        if (!edited?.success || !edited.bill) throw new Error('EDIT_FAILED');
        // An incomplete model response must not erase unrelated existing facts.
        const updates = Object.fromEntries(Object.entries(edited.bill).filter(([field, value]) =>
          value != null && (field !== 'line_items' || value.length > 0)));
        const mentions = findOrganizationsInText(input.text);
        // Unrelated edits must not accept a model's unsolicited organization
        // change. New invoice evidence can update it or require clarification.
        updates.organization = mentions.length === 1 ? resolveOrganization({ ...mentions[0], confidence: 1 })
          : mentions.length > 1 ? null : (directMediaExtraction && groundedBill(edited).organization) || session.bill_data.organization;
        if (updates.vendor_name && vendorNameKey(updates.vendor_name) !== vendorNameKey(session.bill_data.vendor_name)) updates.zoho_vendor_id = null;
        const bill = normalizeBillOrganization(validateBill(mergeWorkerDetails({ ...session.bill_data, ...updates }, incoming.text)).normalizedBill, session.bill_data);
        const attachments = [...(session.attachments || []), ...(input.attachments || (input.attachment ? [input.attachment] : []))];
        await billStore.updateBill(session.bill_id, { ...bill, attachments, status: 'PENDING_REVIEW' });
        await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, bill_data: bill, attachments, customer_options: [], last_message_id: incoming.messageId });
        return continueAfterOrganization(session, bill, incoming.messageId);
      } catch (error) {
        log('error', { event: 'books.bill_media_pipeline.failed', category: error?.category || PIPELINE_FAILURES.EXTRACTION, reason: error?.reason || error?.code || 'EDIT_FAILED', messageId: incoming.messageId });
        return reply(session, 'I could not read or apply the correction. The existing bill is unchanged. Please resend clear details, or reply DELETE.');
      }
    }
    if (!media && (cmd || /^(hi|hello|hey|salaam|start|\?)[.!?]*$/i.test((incoming.text || '').trim()) || !(incoming.text || '').trim())) return reply(null, 'Please send the bill image, PDF, or bill details.');
    try {
      const input = await readInput(incoming);
      const extracted = await extractBillFromInput(input, incoming.messageType || 'text');
      const grounded = groundedBill(extracted);
      const bill = normalizeBillOrganization(validateBill(mergeWorkerDetails(mergeWorkerDetails(grounded, input.text, parseWorkerDetails(input.text, { allowShorthand: false, allowVendor: false })), input.text, parseWorkerDetails(input.text, { allowVendor: false }))).normalizedBill);
      const attachments = input.attachments || (input.attachment ? [input.attachment] : []);
      const draft = { session_id: randomUUID(), bill_id: randomUUID(), worker_phone: incoming.senderPhone, state: WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO, last_message_id: incoming.messageId, bill_data: bill, attachments };
      await billStore.createBillSession(draft);
      await billStore.saveBill({ ...bill, bill_id: draft.bill_id, session_id: draft.session_id, worker_phone: draft.worker_phone, source_message_id: incoming.messageId, attachments, status: 'PENDING_REVIEW' });
      if (!bill.organization) return requestOrganization(draft, bill, incoming.messageId);
      return continueAfterOrganization(draft, bill, incoming.messageId);
    } catch (error) {
      log('error', {
        event: 'books.bill_media_pipeline.failed',
        category: error?.category || PIPELINE_FAILURES.EXTRACTION,
        reason: error?.reason || error?.code || 'BILL_PIPELINE_FAILED',
        messageId: incoming.messageId,
      });
      return reply(null, 'I could not read or store this bill safely. Nothing was saved to Zoho Books. Please send a clearer image/PDF or the bill details as text.');
    }
  }
  async function save(session, messageId) {
    const validation = validateBill(session.bill_data);
    const bill = normalizeBillOrganization({ ...validation.normalizedBill, payment_type: normalizePaymentMethod(validation.normalizedBill.payment_type) });
    if (!bill.organization?.organizationId) {
      return requestOrganization(session, bill, messageId);
    }
    if (!bill.currency) {
      return requestCurrency(session, bill, messageId);
    }
    const customer = bill.customer_details || {};
    const customerId = customer.contact_id || customer.customer_id;
    if ((customerId && customer.organization_id !== bill.organization.organizationId)
        || (customer.organization_id && customer.organization_id !== bill.organization.organizationId)) {
      bill.customer_details = customer.project_site ? { project_site: customer.project_site } : null;
      await billStore.updateBill(session.bill_id, { customer_details: bill.customer_details });
      await billStore.updateBillSession(session.session_id, { state: REVIEW, bill_data: bill, customer_options: [] });
      const prompt = await askForCustomer(session, bill);
      return { ...(prompt || reply(session, '', { state: REVIEW, bill })), replyText: `The selected customer does not belong to the chosen Zoho Books organization. Please select the customer again.\n${prompt?.replyText || ''}` };
    }
    // Manually supplied legacy customer details remain supported when the
    // Contacts lookup is unavailable. A customer selected from Zoho always
    // carries the verified contact_id and it is forwarded to bill creation.
    const { missing, sourceOnlyLines } = billMissingFields(bill, { requireCustomerId: typeof zohoBooksClient?.searchCustomer === 'function', requireAccounting: typeof zohoBooksClient?.prepareBill === 'function' });
    if (session.state !== REVIEW || !validation.valid || missing.length) return continueAfterOrganization(session, bill, messageId);
    const accountingBill = sourceOnlyLines.length
      ? { ...bill, line_items: bill.line_items.filter((_, index) => !sourceOnlyLines.includes(index)) } : bill;
    if (!await billStore.claimBillSave(session.session_id, messageId)) return reply(session, 'This bill is already being saved. Please wait.');
    await billStore.updateBill(session.bill_id, { payment_type: bill.payment_type, customer_details: bill.customer_details, organization: bill.organization });
    const reviewFailure = async text => {
      await billStore.updateBillSession(session.session_id, { state: REVIEW });
      return reply(session, `${text}\nReply SAVE to retry, EDIT to correct, or DELETE.`, { state: REVIEW });
    };
    let vendor;
    try {
      const resolveAndCreateVendor = async () => {
        // Recheck inside the organization/vendor lock: a different bill may
        // have created this contact after the draft's initial review.
        const resolution = await resolveVendor(bill);
        if (resolution.status === 'ambiguous') return reviewFailure('Multiple vendors match this name in Zoho Books. Please send Vendor TRN: followed by the vendor tax registration number, or reply EDIT with a correction.');
        if (resolution.status === 'inactive') return reviewFailure('The matching vendor is inactive in Zoho Books. Please check the vendor there or reply EDIT with a correction.');
        if (resolution.status === 'wrong_organization') return reviewFailure('Vendor does not belong to the selected organization. Please select the organization again.');
        if (bill.zoho_vendor_id && resolution.vendor?.id !== bill.zoho_vendor_id) return reviewFailure('The reviewed vendor has changed in Zoho Books. Please check the vendor before saving.');
        vendor = resolution.vendor;
        const duplicate = await zohoBooksClient.checkDuplicateBill({ billNumber: bill.bill_number, vendorId: vendor?.id || null, organizationId: bill.organization.organizationId });
        if (duplicate?.found) return reviewFailure(formatDuplicateWarning({ billNumber: bill.bill_number, vendorName: bill.vendor_name, existingBillId: duplicate.bills?.[0]?.id }));
        if (!vendor) {
          if (typeof zohoBooksClient.createVendor !== 'function') return reviewFailure('Vendor not found or ambiguous. Please check the vendor in Zoho Books.');
          try {
            vendor = await zohoBooksClient.createVendor({ name: bill.vendor_name, organizationId: bill.organization.organizationId });
            if (!vendor?.id || (vendor.organizationId && vendor.organizationId !== bill.organization.organizationId)) throw new Error('VENDOR_CREATE_UNCONFIRMED');
            await billStore.updateBill(session.bill_id, { zoho_vendor_id: vendor.id });
            await billStore.updateBillSession(session.session_id, { bill_data: { ...bill, zoho_vendor_id: vendor.id } });
          } catch {
            await billStore.updateBill(session.bill_id, { zoho_error: 'VENDOR_CREATE_OUTCOME_UNCONFIRMED' });
            return reply(session, 'Zoho vendor creation could not be confirmed. Your draft is locked to prevent duplicate vendors or bills. Ask an administrator to reconcile it in Zoho Books.', { state: SAVING });
          }
        }
        return null;
      };
      const vendorKey = createHash('sha256').update(`${bill.organization.organizationId}\n${vendorNameKey(bill.vendor_name)}`).digest('hex');
      const vendorResult = store?.withContactLock
        ? await store.withContactLock(`books-vendor:${vendorKey}`, resolveAndCreateVendor)
        : await resolveAndCreateVendor();
      if (vendorResult) return vendorResult;
      if (zohoBooksClient.prepareBill) await zohoBooksClient.prepareBill(accountingBill, vendor, { organizationId: bill.organization.organizationId });
    } catch (error) {
      log('error', { event: 'books.bill_preflight_failed', code: error?.code || 'UNKNOWN', operation: error?.operation || null });
      return reviewFailure('Zoho vendor, currency, tax or duplicate validation failed. Nothing was created.');
    }
    await billStore.updateBill(session.bill_id, { status: 'CREATING', zoho_status: 'SYNCING', zoho_vendor_id: vendor.id });
    try {
      const detailNote = [`Payment method: ${bill.payment_type}`, `Customer: ${customer.customer_name}`, customerId ? `Zoho customer ID: ${customerId}` : null, customer.customer_phone ? `Customer phone: ${customer.customer_phone}` : null, customer.customer_source === 'manual' && customer.customer_email ? `Customer email: ${customer.customer_email}` : null, customer.project_site ? `Project/site: ${customer.project_site}` : null].filter(Boolean).join(' | ');
      const notes = [bill.notes, detailNote].filter(Boolean).join('\n');
      const created = await zohoBooksClient.createBill({ vendorId: vendor.id, billNumber: bill.bill_number, billDate: bill.bill_date, dueDate: bill.due_date, lineItems: accountingBill.line_items, total: bill.total_amount, currency: bill.currency, currencyId: accountingBill.currency_id, customerId: customerId || null, paymentType: bill.payment_type, notes, organizationId: bill.organization.organizationId });
      if (!created?.id) throw new Error('MISSING_ZOHO_ID');
      // Persist the returned ID BEFORE any attachment or outbound document work.
      await billStore.updateBill(session.bill_id, { zoho_bill_id: created.id, zoho_bill_url: zohoBooksClient.buildZohoBillUrl(created.id, bill.organization.organizationId), zoho_status: 'SYNCED', status: 'COMPLETED', organization: bill.organization });
    } catch (error) {
      if ([400, 401, 403, 422].includes(error.httpStatus) && error.providerCode) {
        await billStore.updateBill(session.bill_id, { status: 'PENDING_REVIEW', zoho_status: 'FAILED', zoho_error: 'ZOHO_REJECTED_BILL' });
        return reviewFailure('Zoho rejected this bill. Please check the accounting fields and permissions.');
      }
      await billStore.updateBill(session.bill_id, { zoho_error: 'CREATE_OUTCOME_UNCONFIRMED' });
      return reply(session, 'Zoho save could not be confirmed. Your draft is retained and locked to prevent duplicates. An administrator must reconcile the result before another save.', { state: SAVING });
    }
    return finishCreated(session, await billStore.getBill(session.bill_id));
  }
  async function finishCreated(session, record) {
    const id = record.zoho_bill_id;
    const organizationId = resolveOrganization(record.organization)?.organizationId;
    if (!organizationId) return reply(session, `Bill already created (ID: ${id}), but its saved organization is missing. Ask an administrator to reconcile it before retrying attachments or the PDF. No new bill will be created.`);
    // The persisted bill, not the possibly stale session, is authoritative.
    const attachments = structuredClone(record.attachments || session.attachments || []);
    const persistAttachments = async () => {
      await billStore.updateBill(session.bill_id, { attachments: structuredClone(attachments) });
      try { await billStore.updateBillSession(session.session_id, { attachments: structuredClone(attachments) }); }
      catch { /* The bill record is authoritative for the next SAVE. */ }
    };
    for (const attachment of attachments) {
      if (['uploaded', 'uploading', 'uncertain'].includes(attachment.zoho_upload_status)) continue;
      let buffer;
      try {
        const saved = await store?.getMediaFile(attachment.storage_reference);
        buffer = Buffer.isBuffer(saved) ? saved : saved?.buffer;
        if (!buffer) throw new Error('MEDIA_UNAVAILABLE');
      } catch {
        attachment.zoho_upload_status = 'failed';
        await persistAttachments();
        continue;
      }
      // Record intent before POST; a crash after this point needs reconciliation.
      attachment.zoho_upload_status = 'uploading';
      try { await persistAttachments(); }
      catch { return reply(session, `Bill already created (ID: ${id}), but attachment state could not be persisted. No upload was attempted. Ask an administrator to reconcile it.`); }
      let uploaded;
      try {
        uploaded = await zohoBooksClient.attachBillFile({ billId: id, buffer, filename: attachment.original_filename, mimeType: attachment.mime_type, organizationId });
      } catch (error) {
        // Only an explicit provider rejection proves that no upload occurred.
        attachment.zoho_upload_status = [400, 401, 403, 404, 422].includes(error?.httpStatus) ? 'failed' : 'uncertain';
        try { await persistAttachments(); } catch { /* 'uploading' on disk remains fail-closed. */ }
        continue;
      }
      attachment.zoho_upload_status = 'uploaded';
      if (uploaded?.attachmentId || uploaded?.id) attachment.zoho_attachment_id = uploaded.attachmentId || uploaded.id;
      try { await persistAttachments(); }
      catch {
        const persisted = await billStore.getBill(session.bill_id).catch(() => null);
        const saved = persisted?.attachments?.find(item => item.storage_reference === attachment.storage_reference);
        if (saved?.zoho_upload_status !== 'uploaded') {
          attachment.zoho_upload_status = 'uncertain';
          try { await persistAttachments(); } catch { /* 'uploading' on disk remains fail-closed. */ }
        }
      }
    }
    const attachmentsComplete = attachments.every(a => a.zoho_upload_status === 'uploaded');
    const attachmentNotice = attachmentsComplete ? '' : attachments.some(a => ['uncertain', 'uploading'].includes(a.zoho_upload_status))
      ? '\nAttachment upload failed or is unconfirmed. Ask an administrator to reconcile it; it will not be uploaded twice automatically.'
      : '\nAttachment upload failed. Reply SAVE to retry the attachment only; the bill will not be recreated.';
    const summary = formatSuccessReport({ bill: record, zohoBillId: id, zohoBillUrl: zohoBooksClient.buildZohoBillUrl(id, organizationId), attachmentStatus: attachmentsComplete ? attachments.length ? 'ATTACHED' : 'NONE' : 'FAILED' });
    if (['SENDING', 'UNKNOWN'].includes(record.pdf_delivery_status)) return reply(session, `${summary}\nPDF delivery is unconfirmed. Ask an administrator to check delivery; it will not be sent twice automatically.`);
    if (record.pdf_delivery_status === 'ACCEPTED') {
      if (attachmentsComplete) await billStore.completeBillSession(session.session_id);
      return reply(session, `${summary}\nThe PDF was accepted by WhatsApp.${attachmentNotice}`, { state: attachmentsComplete ? 'COMPLETED' : SAVING });
    }
    let document;
    try {
      document = await zohoBooksClient.getBillPdf(id, { organizationId });
      if (document.bill && (Math.abs(document.bill.total - record.total_amount) > 0.05 || document.bill.currency_code !== record.currency)) {
        await billStore.updateBill(session.bill_id, { pdf_delivery_status: 'RECORD_MISMATCH' });
        return reply(session, `${summary}\nThe saved record amount or currency differs from the reviewed bill. Please ask an administrator to reconcile it. No second bill will be created.`);
      }
      if (!Buffer.isBuffer(document?.buffer) || document.buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('INVALID_PDF');
    } catch {
      await billStore.updateBill(session.bill_id, { pdf_delivery_status: 'FETCH_FAILED' });
      return reply(session, `${summary}\nThe created bill PDF could not be retrieved. Reply SAVE to retry the PDF only; the bill will not be recreated.`);
    }
    await billStore.updateBill(session.bill_id, { pdf_delivery_status: 'SENDING' });
    let delivery;
    try { delivery = await whatsappService.sendDocument(session.worker_phone, { buffer: document.buffer, filename: `Zoho-Bill-${id}.pdf`, caption: `PDF copy of saved Zoho Books bill ${record.bill_number || id}` }); }
    catch (error) {
      const status = ['NOT_ATTEMPTED', 'ATTEMPTED_FAILED'].includes(error.deliveryState) ? 'FAILED' : 'UNKNOWN';
      await billStore.updateBill(session.bill_id, { pdf_delivery_status: status });
      return reply(session, `${summary}\nPDF delivery ${status === 'UNKNOWN' ? 'is unconfirmed; ask an administrator to check it' : 'failed; reply SAVE to retry the PDF only'}. The bill will not be recreated.`);
    }
    await billStore.updateBill(session.bill_id, { pdf_delivery_status: 'ACCEPTED', pdf_message_id: delivery?.messages?.[0]?.id || null });
    if (attachmentsComplete) await billStore.completeBillSession(session.session_id);
    return reply(session, `${summary}\nCreated bill PDF accepted by WhatsApp.${attachmentNotice}`, { state: attachmentsComplete ? 'COMPLETED' : SAVING, zohoBillId: id });
  }
  async function processMessage(incoming = {}) {
    const run = () => processUnlocked(incoming);
    return store?.withContactLock && incoming.senderPhone ? store.withContactLock(`books:${incoming.senderPhone}`, run) : run();
  }
  return { processMessage, parseYesNo, WORKFLOW_STATES };
}
module.exports = { createBillWorkflow, parseYesNo, parseWorkerDetails, parseCurrencyInput, CURRENCY_PROMPT, PAYMENT_METHODS, WORKFLOW_STATES };
