'use strict';

const axios = require('axios');
const { Agent } = require('node:https');

const httpsAgent = new Agent({ rejectUnauthorized: true, keepAlive: true });

class ZohoBooksError extends Error {
  constructor(code, message, { httpStatus = null, providerCode = null, operation = null } = {}) {
    super(message);
    this.name = 'ZohoBooksError';
    this.code = code;
    if (httpStatus) this.httpStatus = httpStatus;
    if (providerCode) this.providerCode = providerCode;
    if (operation) this.operation = operation;
  }
}

function sanitizeErrorMessage(message, secrets = []) {
  if (typeof message !== 'string') return 'Zoho Books request failed.';
  let clean = message;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.trim().length > 3) {
      clean = clean.replaceAll(secret.trim(), '[REDACTED]');
    }
  }
  return clean;
}

function normalizeDate(input) {
  const { date, issue } = require('./billValidator').normalizeDate(input, 'bill_date');
  if (issue || !date) throw new ZohoBooksError('INVALID_DATE', 'Bill date must be an unambiguous valid calendar date.');
  return date;
}

function createZohoBooksClient({
  env = process.env,
  http = axios,
  logger: _logger = null,
  clientId = env.ZOHO_BOOKS_CLIENT_ID,
  clientSecret = env.ZOHO_BOOKS_CLIENT_SECRET,
  refreshToken = env.ZOHO_BOOKS_REFRESH_TOKEN,
  organizationId = env.ZOHO_BOOKS_ORGANIZATION_ID,
  accountsUrl = env.ZOHO_BOOKS_ACCOUNTS_URL || 'https://accounts.zoho.com',
  baseUrl = env.ZOHO_BOOKS_BASE_URL || 'https://www.zohoapis.com/books/v3',
  timeout = Number(env.ZOHO_BOOKS_TIMEOUT_MS || 15000),
  domain = env.ZOHO_BOOKS_DOMAIN || 'books.zoho.com',
} = {}) {
  let cachedAccessToken = null;
  let tokenExpiresAt = 0;
  let pendingRefresh = null;

  const cleanClientId = typeof clientId === 'string' ? clientId.trim() : '';
  const cleanClientSecret = typeof clientSecret === 'string' ? clientSecret.trim() : '';
  const cleanRefreshToken = typeof refreshToken === 'string' ? refreshToken.trim() : '';
  const cleanOrganizationId = typeof organizationId === 'string' ? organizationId.trim() : '';
  const cleanAccountsUrl = typeof accountsUrl === 'string' ? accountsUrl.trim().replace(/\/+$/, '') : 'https://accounts.zoho.com';
  const cleanBaseUrl = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : 'https://www.zohoapis.com/books/v3';

  const secrets = [cleanClientSecret, cleanRefreshToken];

  function validateCredentials() {
    if (!cleanClientId || !cleanClientSecret || !cleanRefreshToken) {
      throw new ZohoBooksError(
        'ZOHO_BOOKS_CONFIG_ERROR',
        'Zoho Books credentials not configured. Set ZOHO_BOOKS_CLIENT_ID, ZOHO_BOOKS_CLIENT_SECRET, and ZOHO_BOOKS_REFRESH_TOKEN.'
      );
    }
    if (!cleanOrganizationId) {
      throw new ZohoBooksError(
        'ZOHO_BOOKS_CONFIG_ERROR',
        'Zoho Books organization ID not configured. Set ZOHO_BOOKS_ORGANIZATION_ID.'
      );
    }
  }

  async function refreshAccessToken() {
    validateCredentials();

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cleanClientId,
      client_secret: cleanClientSecret,
      refresh_token: cleanRefreshToken,
    }).toString();

    let response;
    try {
      response = await http.post(`${cleanAccountsUrl}/oauth/v2/token`, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout,
        httpsAgent,
      });
    } catch (err) {
      const status = err?.response?.status;
      const rawError = err?.response?.data?.error || err.message;
      const safeMsg = sanitizeErrorMessage(String(rawError), secrets);
      throw new ZohoBooksError('ZOHO_BOOKS_AUTH_ERROR', `Failed to refresh Zoho Books token: ${safeMsg}`, {
        httpStatus: status,
        operation: 'oauth_refresh',
      });
    }

    const data = response?.data;
    if (!data || !data.access_token) {
      const errDetail = data?.error || 'No access_token returned';
      throw new ZohoBooksError('ZOHO_BOOKS_AUTH_ERROR', `Zoho Books OAuth returned invalid response: ${errDetail}`, {
        operation: 'oauth_refresh',
      });
    }

    cachedAccessToken = data.access_token;
    secrets.push(cachedAccessToken);

    const expiresIn = Number(data.expires_in) || 3600;
    // Set expiry 60 seconds early to prevent edge-of-expiry request drops
    tokenExpiresAt = Date.now() + Math.max(0, (expiresIn - 60) * 1000);

    return cachedAccessToken;
  }

  async function getAccessToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && cachedAccessToken && Date.now() < tokenExpiresAt) {
      return cachedAccessToken;
    }
    if (pendingRefresh) {
      return pendingRefresh;
    }
    pendingRefresh = refreshAccessToken().finally(() => {
      pendingRefresh = null;
    });
    return pendingRefresh;
  }

  function invalidateToken() {
    cachedAccessToken = null;
    tokenExpiresAt = 0;
  }

  async function requestWithRetry(requestFn, operationName) {
    validateCredentials();

    let token = await getAccessToken();
    try {
      return await requestFn(token);
    } catch (firstErr) {
      const status = firstErr?.response?.status;
      const responseData = firstErr?.response?.data;
      const providerCode = responseData?.code;

      // 401 or token expired error codes (57 is typical Zoho OAuth invalid/expired token)
      const isAuthError = status === 401 || providerCode === 57;

      if (isAuthError) {
        invalidateToken();
        token = await getAccessToken({ forceRefresh: true });
        try {
          return await requestFn(token);
        } catch (retryErr) {
          handleRequestError(retryErr, operationName);
        }
      } else {
        handleRequestError(firstErr, operationName);
      }
    }
  }

  function handleRequestError(err, operation) {
    const status = err?.response?.status || null;
    const data = err?.response?.data;
    const providerCode = data?.code || null;
    const rawMsg = data?.message || data?.error || err.message || 'Unknown Zoho Books error';
    const cleanMsg = sanitizeErrorMessage(rawMsg, secrets);

    throw new ZohoBooksError('ZOHO_BOOKS_API_ERROR', `Zoho Books ${operation} failed: ${cleanMsg}`, {
      httpStatus: status,
      providerCode,
      operation,
    });
  }

  // =========================================================================
  // API METHODS
  // =========================================================================

  async function searchVendor({ name = '', searchText = '' } = {}) {
    const term = (searchText || name || '').trim();
    if (!term) {
      return [];
    }

    return requestWithRetry(async (token) => {
      const response = await http.get(`${cleanBaseUrl}/contacts`, {
        params: {
          organization_id: cleanOrganizationId,
          contact_type: 'vendor',
          search_text: term,
        },
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
        },
        timeout,
        httpsAgent,
      });

      const contacts = response?.data?.contacts || [];
      if (response?.data?.code !== undefined && response.data.code !== 0) throw new ZohoBooksError('VENDOR_LOOKUP_FAILED', 'Zoho rejected the vendor lookup.');
      return contacts.map((c) => ({
        id: String(c.contact_id || c.id),
        name: c.contact_name || c.vendor_name || c.company_name || '',
        companyName: c.company_name || null,
        email: c.email || null,
        phone: c.phone || c.mobile || null,
        trn: c.tax_registration_number || c.tax_treatment || c.gst_no || c.trn || null,
        status: c.status || null,
        raw: c,
      }));
    }, 'searchVendor');
  }

  async function searchCustomer({ searchText = '' } = {}) {
    const term = String(searchText || '').trim();
    return requestWithRetry(async (token) => {
      const response = await http.get(`${cleanBaseUrl}/contacts`, {
        params: { organization_id: cleanOrganizationId, contact_type: 'customer', per_page: 10, ...(term ? { search_text: term } : {}) },
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout,
        httpsAgent,
      });
      if (response?.data?.code !== undefined && response.data.code !== 0) throw new ZohoBooksError('CUSTOMER_LOOKUP_FAILED', 'Zoho rejected the customer lookup.');
      const mapped = (response?.data?.contacts || []).map(contact => ({
        id: String(contact.contact_id || contact.id || ''),
        name: contact.contact_name || contact.company_name || '',
        companyName: contact.company_name || null,
        email: contact.email || null,
        phone: contact.phone || contact.mobile || null,
        status: contact.status || null,
        raw: contact,
      })).filter(contact => contact.id && contact.name);
      if (!term) return mapped;
      const needle = term.toLowerCase();
      return mapped.filter(contact => [contact.name, contact.companyName, contact.phone, contact.email]
        .filter(Boolean).some(value => String(value).toLowerCase().includes(needle)));
    }, 'searchCustomer');
  }

  async function checkDuplicateBill({ billNumber, vendorId = null }) {
    if (!billNumber || typeof billNumber !== 'string' || !billNumber.trim()) {
      throw new ZohoBooksError('INVALID_INPUT', 'billNumber is required for duplicate check.');
    }

    const cleanBillNumber = billNumber.trim();

    const bills = [];
    for (let page = 1; page <= 100; page++) {
      const data = await getJson('/bills', { search_text: cleanBillNumber, page, per_page: 200 });
      if (!Array.isArray(data.bills)) throw new ZohoBooksError('DUPLICATE_CHECK_FAILED', 'Zoho returned an invalid bill list.');
      bills.push(...data.bills);
      if (!data.page_context?.has_more_page) break;
      if (page === 100) throw new ZohoBooksError('DUPLICATE_CHECK_INCOMPLETE', 'Bill search could not be completed safely.');
    }
    const matches = bills.filter(b => String(b.bill_number || '').trim().toLowerCase() === cleanBillNumber.toLowerCase()
      && (!vendorId || String(b.vendor_id) === String(vendorId)));
    return { found: matches.length > 0, bills: matches.map(b => ({
      id: String(b.bill_id || b.id), billNumber: b.bill_number, vendorId: String(b.vendor_id),
      vendorName: b.vendor_name, total: b.total, currencyCode: b.currency_code, date: b.date,
    })) };
  }

  async function createBill({
    vendorId,
    billNumber,
    billDate,
    dueDate = null,
    lineItems = [],
    currency = 'AED',
    currencyId = null,
    customerId = null,
    paymentType = null,
    notes = null,
    referenceNumber = null,
    attachment: _attachment = null,
  } = {}) {
    if (!vendorId) {
      throw new ZohoBooksError('INVALID_INPUT', 'vendorId is required to create a bill in Zoho Books.');
    }
    if (!billNumber || typeof billNumber !== 'string' || !billNumber.trim()) {
      throw new ZohoBooksError('INVALID_INPUT', 'billNumber is required to create a bill in Zoho Books.');
    }

    const formattedDate = normalizeDate(billDate);
    const formattedDueDate = dueDate ? normalizeDate(dueDate) : undefined;
    if (!Array.isArray(lineItems) || !lineItems.length || lineItems.some(item => !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.rate) || item.rate < 0)) {
      throw new ZohoBooksError('INVALID_INPUT', 'Every bill item requires an explicit quantity and rate.');
    }

    const items = Array.isArray(lineItems) && lineItems.length > 0
      ? lineItems.map((item) => ({
        account_id: item.account_id || item.accountId || undefined,
        description: item.description || item.name || 'Purchased Item',
        rate: typeof item.rate === 'number' ? item.rate : (typeof item.amount === 'number' ? item.amount : 0),
        quantity: typeof item.quantity === 'number' ? item.quantity : 1,
        tax_id: item.tax_id || item.taxId || undefined,
        tax_percentage: item.tax_percentage || item.tax || undefined,
        item_total: typeof item.amount === 'number' ? item.amount : undefined,
      }))
      : [
        {
          description: 'Purchased Item',
          rate: 0,
          quantity: 1,
        },
      ];

    const payload = {
      vendor_id: String(vendorId),
      bill_number: String(billNumber).trim(),
      date: formattedDate,
      due_date: formattedDueDate,
      line_items: items,
      ...(currencyId ? { currency_id: currencyId } : {}),
    };

    const paymentNote = paymentType ? `Payment method: ${String(paymentType).trim()}` : null;
    const customerNote = customerId ? `Zoho customer ID: ${String(customerId).trim()}` : null;
    const combinedNotes = [notes,
      paymentNote && !/payment method\s*:/i.test(String(notes || '')) ? paymentNote : null,
      customerNote && !/zoho customer id\s*:/i.test(String(notes || '')) ? customerNote : null,
    ].filter(Boolean).join('\n');
    if (combinedNotes) payload.notes = combinedNotes;
    if (referenceNumber) payload.reference_number = String(referenceNumber).trim();

    return requestWithRetry(async (token) => {
      const response = await http.post(`${cleanBaseUrl}/bills`, payload, {
        params: {
          organization_id: cleanOrganizationId,
        },
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/json',
        },
        timeout,
        httpsAgent,
      });

      const bill = response?.data?.bill || response?.data || {};
      const createdId = String(bill.bill_id || bill.id || '');
      if (response?.data?.code !== 0 || !createdId) throw new ZohoBooksError('ZOHO_BOOKS_INVALID_RESPONSE', 'Zoho did not confirm a created bill ID.');

      return {
        id: createdId,
        billNumber: bill.bill_number || billNumber,
        status: bill.status || 'open',
        total: bill.total || 0,
        vendorId: String(bill.vendor_id || vendorId),
        vendorName: bill.vendor_name || null,
        date: bill.date || formattedDate,
        dueDate: bill.due_date || formattedDueDate,
        currencyCode: bill.currency_code || currency || 'AED',
        raw: response.data,
      };
    }, 'createBill');
  }

  async function attachBillFile({ billId, buffer, filename, mimeType = 'application/pdf' } = {}) {
    if (!billId) {
      throw new ZohoBooksError('INVALID_INPUT', 'billId is required to attach file.');
    }
    if (!buffer || !Buffer.isBuffer(buffer)) {
      throw new ZohoBooksError('INVALID_INPUT', 'A file Buffer is required to attach file.');
    }
    if (!filename || typeof filename !== 'string') {
      throw new ZohoBooksError('INVALID_INPUT', 'filename is required to attach file.');
    }

    const form = new globalThis.FormData();
    const blob = new globalThis.Blob([buffer], { type: mimeType || 'application/octet-stream' });
    form.append('attachment', blob, filename);

    return requestWithRetry(async (token) => {
      const response = await http.post(`${cleanBaseUrl}/bills/${billId}/attachment`, form, {
        params: {
          organization_id: cleanOrganizationId,
        },
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
        },
        timeout: Math.max(timeout, 30000),
        httpsAgent,
      });

      const data = response?.data || {};
      if (data.code !== 0) throw new ZohoBooksError('ZOHO_BOOKS_ATTACHMENT_FAILED', 'Zoho did not confirm the attachment.');
      return {
        success: true,
        attachmentId: data?.attachment_id || data?.id || 'attached',
        message: data?.message || 'File attached successfully.',
        raw: data,
      };
    }, 'attachBillFile');
  }

  function buildZohoBillUrl(billId) {
    if (!billId) return null;
    return `https://${domain}/app/${cleanOrganizationId}#/bills/${billId}`;
  }

  async function getJson(path, params = {}) {
    return requestWithRetry(async token => {
      const response = await http.get(`${cleanBaseUrl}${path}`, { params: { organization_id: cleanOrganizationId, ...params }, headers: { Authorization: `Zoho-oauthtoken ${token}` }, timeout, httpsAgent, maxRedirects: 0 });
      if (response?.data?.code !== 0) throw new ZohoBooksError('ZOHO_BOOKS_INVALID_RESPONSE', 'Zoho did not confirm the read operation.');
      return response.data;
    }, 'read');
  }

  async function prepareBill(bill, vendor) {
    const currencies = await getJson('/settings/currencies');
    const currency = (currencies.currencies || []).find(item => item.currency_code === bill.currency);
    if (!currency?.currency_id) throw new ZohoBooksError('CURRENCY_NOT_FOUND', 'Currency is not configured in Zoho Books.');
    bill.currency_id = currency.currency_id;
    if (vendor.raw?.currency_id && String(vendor.raw.currency_id) !== String(currency.currency_id)) throw new ZohoBooksError('VENDOR_CURRENCY_MISMATCH', 'Vendor currency differs from the source bill.');
    const calculatedSubtotal = bill.line_items.reduce((sum, item) => sum + item.quantity * item.rate, 0);
    if (bill.line_items.some(item => item.amount != null && Math.abs(item.quantity * item.rate - item.amount) > 0.05)) throw new ZohoBooksError('LINE_AMOUNT_MISMATCH', 'A line amount differs from its quantity and rate.');
    if (bill.subtotal == null || bill.tax_amount == null || Math.abs(calculatedSubtotal - bill.subtotal) > 0.05) throw new ZohoBooksError('TOTAL_MISMATCH', 'Confirm subtotal, tax, quantity and rates before saving.');
    if (bill.tax_amount > 0) {
      const taxes = await getJson('/settings/taxes');
      // Do not infer item-level tax allocation from the total tax.
      let calculatedTax = 0;
      for (const item of bill.line_items) {
        const percentage = item.tax_percentage ?? item.tax;
        if (!Number.isFinite(percentage)) throw new ZohoBooksError('TAX_ALLOCATION_REQUIRED', 'Supply the tax percentage for each item.');
        const matches = (taxes.taxes || []).filter(tax => Number(tax.tax_percentage) === percentage && tax.tax_type === 'tax');
        if (matches.length !== 1) throw new ZohoBooksError('TAX_AMBIGUOUS', 'Tax mapping is missing or ambiguous.');
        item.tax_id = matches[0].tax_id;
        calculatedTax += item.quantity * item.rate * percentage / 100;
      }
      if (Math.abs(calculatedTax - bill.tax_amount) > 0.05) throw new ZohoBooksError('TAX_MISMATCH', 'Line tax differs from the source bill.');
    }
    return bill;
  }

  async function getBillPdf(billId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(billId || '')) throw new ZohoBooksError('INVALID_INPUT', 'A bill ID is required.');
    const data = await getJson(`/bills/${billId}`);
    if (String(data.bill?.bill_id) !== String(billId)) throw new ZohoBooksError('BILL_ID_MISMATCH', 'Zoho returned a different bill.');
    const { renderCreatedBillPdf } = require('./billPdf');
    const buffer = await renderCreatedBillPdf(data.bill, { fontPath: env.BILL_PDF_FONT_PATH });
    return { buffer, mimeType: 'application/pdf', source: 'generated_from_zoho_record', bill: data.bill };
  }

  return {
    getAccessToken,
    invalidateToken,
    searchVendor,
    searchCustomer,
    checkDuplicateBill,
    createBill,
    attachBillFile,
    buildZohoBillUrl,
    validateCredentials,
    prepareBill,
    getBillPdf,
  };
}

module.exports = {
  createZohoBooksClient,
  ZohoBooksError,
  normalizeDate,
  sanitizeErrorMessage,
};
