'use strict';

const axios = require('axios');
const { Agent } = require('node:https');
const { createBillAccountResolver } = require('./billAccountResolver');
const { customerBillNotes } = require('./customerDetails');
const { scopeReport } = require('../zoho/oauthScopes');
const { visitContactPages } = require('./contactPagination');
const { limitOrganizationRequests } = require('./organizationRequestLimit');

const httpsAgent = new Agent({ rejectUnauthorized: true, keepAlive: true });

class ZohoBooksError extends Error {
  constructor(code, message, { httpStatus = null, providerCode = null, providerMessage = null, operation = null, method = null, endpoint = null } = {}) {
    super(message);
    this.name = 'ZohoBooksError';
    this.code = code;
    if (httpStatus) this.httpStatus = httpStatus;
    if (providerCode !== null) this.providerCode = providerCode;
    if (providerMessage !== null) this.providerMessage = providerMessage;
    if (operation) this.operation = operation;
    if (method) this.method = method;
    if (endpoint) this.endpoint = endpoint;
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

// Provider messages can echo submitted values. Never retain the HTTP error,
// headers, response body or bill payload in a diagnostic event.
function sanitizeBillProviderMessage(message, secrets, payload) {
  if (typeof message !== 'string' || !message.trim()) return null;
  if (message.length > 8192) return '[Provider message omitted: exceeds diagnostic limit]';
  const privateValues = [];
  function collect(value) {
    if (typeof value === 'string' && value.trim()) {
      privateValues.push(value.trim());
      // Workflow notes contain labelled customer fields separated by pipes.
      for (const part of value.split(/[|\r\n]/)) {
        const field = part.match(/^\s*(?:Customer(?: [a-z ]+)?|Zoho customer ID|Project\/site)\s*:\s*(.+)/i);
        if (field) privateValues.push(field[1].trim());
      }
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  }
  collect(payload);
  let clean = message;
  for (const secret of secrets.filter(value => typeof value === 'string' && value)) {
    for (const variant of new Set([secret, encodeURIComponent(secret)])) clean = clean.replaceAll(variant, '[REDACTED]');
  }
  for (const value of [...new Set(privateValues.filter(value => typeof value === 'string' && value))].sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([value, encodeURIComponent(value)])) {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      clean = clean.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu'), '[REDACTED]');
    }
  }
  clean = clean
    .replace(/\b(?:Zoho-oauthtoken|Bearer|Basic)\s+\S+/gi, '[REDACTED]')
    .replace(/\b(?:access_token|refresh_token|client_secret|authorization|api_key|password)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]')
    .replace(/\b(?:https?:\/\/|mongodb(?:\+srv)?:\/\/)\S+/gi, '[REDACTED]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[REDACTED]')
    .replace(/\+?\d(?:[\d ().-]{5,}\d)/g, '[REDACTED]')
    .replace(/\b((?:vendor|customer|contact)(?:[ _]+(?:name|email|phone|mobile))?\s*[:=]\s*)[^;\r\n|]+/gi, '$1[REDACTED]')
    .replace(/\b((?:vendor|customer|contact)\s+)(?!(?:id|name|email|phone|mobile|is|was|has|does|must|should|cannot|can|could|not|details|information|provided|specified|selected|field|with|for|of|in|and|or)\b)[^;\r\n]+?(?=\s+(?:is|was|has|does|must|should|cannot|can|could|not)\b|[.;\r\n]|$)/gi, '$1[REDACTED]')
    .replace(/(["'`])([^"'`\r\n]+)\1/g, (match, quote, value) => {
      const field = value.replace(/^line_items(?:\[\d+\])?\./, '');
      return ['account_id', 'item_id', 'vendor_id', 'customer_id', 'organization_id', 'currency_id',
        'bill_number', 'date', 'due_date', 'line_items', 'description', 'quantity', 'rate',
        'tax_id', 'tax_percentage', 'item_total', 'tax_treatment', 'place_of_supply', 'location_id',
        'custom_fields', 'reference_number', 'notes'].includes(field) ? match : `${quote}[REDACTED]${quote}`;
    })
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean.length > 1024 ? `${clean.slice(0, 1024)} [truncated]` : clean;
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function isTaxInclusiveSourceAmount(item) {
  const net = item.quantity * item.rate;
  const percentage = item.tax_percentage ?? item.tax;
  return Number.isFinite(net) && Number.isFinite(item.amount) && Number.isFinite(percentage)
    && percentage > 0 && percentage <= 100 && Math.abs(net - item.amount) > 0.05
    && Math.abs(net * (1 + percentage / 100) - item.amount) <= 0.05;
}

function currencyPrecision(currency = 'AED') {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; }
  catch { return 2; }
}

function moneyUnits(value, precision = 2) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** precision;
  const number = Number(value);
  const rounded = Math.round((number + Math.sign(number) * Number.EPSILON * Math.max(1, Math.abs(number))) * factor);
  return Number.isSafeInteger(rounded) ? rounded : null;
}

// item_total is a response field, not a reliable writable amount override.
// Preserve a printed net line amount using its effective unit rate. A gross
// source amount must not be taxed a second time; retain its original net rate.
function sourceLineRate(item) {
  const calculated = item.quantity * item.rate;
  if (!Number.isFinite(item.amount) || isTaxInclusiveSourceAmount(item)) return item.rate;
  if (Math.abs(calculated - item.amount) > 0.050000001) {
    throw new ZohoBooksError('LINE_AMOUNT_MISMATCH', 'A line amount differs from its quantity and rate.');
  }
  return Number((item.amount / item.quantity).toFixed(8));
}

function normalizeCustomerContact(contact = {}) {
  const contactId = nullableText(contact.contact_id ?? contact.customer_id ?? contact.contactId ?? contact.id);
  if (!contactId) return null;

  const contactName = nullableText(contact.contact_name ?? contact.contactName);
  const companyName = nullableText(contact.company_name ?? contact.companyName);
  const email = nullableText(contact.email);
  const phone = nullableText(contact.phone);
  const mobile = nullableText(contact.mobile);
  const contactType = nullableText(contact.contact_type ?? contact.contactType);
  const status = nullableText(contact.status);
  const displayName = nullableText(contact.display_name ?? contact.displayName)
    || (companyName && contactName && companyName !== contactName ? `${companyName} (${contactName})` : companyName || contactName);

  return {
    // Canonical fields. These are kept separate because Zoho does not promise
    // that contact_name and company_name are the same value.
    contactId,
    contactName,
    companyName,
    email,
    phone,
    mobile,
    contactType,
    status,
    displayName,
    // Compatibility aliases for existing callers. The canonical ID remains
    // contactId and is never derived from a display position or name.
    id: contactId,
    name: displayName || '',
    raw: contact,
  };
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
  accountsUrl = env.ZOHO_BOOKS_ACCOUNTS_URL || 'https://accounts.zoho.com',
  baseUrl = env.ZOHO_BOOKS_BASE_URL || 'https://www.zohoapis.com/books/v3',
  timeout = Number(env.ZOHO_BOOKS_TIMEOUT_MS || 15000),
  domain = env.ZOHO_BOOKS_DOMAIN || 'books.zoho.com',
} = {}) {
  http = limitOrganizationRequests(http);
  let cachedAccessToken = null;
  let cachedPaymentScopeReport = null;
  let tokenExpiresAt = 0;
  let pendingRefresh = null;
  const pendingPaymentAccountLists = new Map();
  const pendingContactLookups = new Map();
  const vendorReviewCache = new Map();
  const vendorReviewCacheTtlMs = 60000;
  const vendorReviewCacheLimit = 50;

  const cleanClientId = typeof clientId === 'string' ? clientId.trim() : '';
  const cleanClientSecret = typeof clientSecret === 'string' ? clientSecret.trim() : '';
  const cleanRefreshToken = typeof refreshToken === 'string' ? refreshToken.trim() : '';
  const cleanAccountsUrl = typeof accountsUrl === 'string' ? accountsUrl.trim().replace(/\/+$/, '') : 'https://accounts.zoho.com';
  const cleanBaseUrl = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : 'https://www.zohoapis.com/books/v3';

  const secrets = [cleanClientSecret, cleanRefreshToken];
  const billAccounts = createBillAccountResolver({ env,
    readAccount: (accountId, organizationId) => getJson(`/chartofaccounts/${accountId}`, {}, organizationId),
  });

  function resolveOrganizationId(value = null) {
    const candidate = typeof value === 'string' ? value.trim() : '';
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(candidate)) {
      throw new ZohoBooksError('ZOHO_BOOKS_CONFIG_ERROR', 'A selected bill organization ID is required for this Zoho Books operation.');
    }
    return candidate;
  }

  function validateCredentials({ organizationId = null, requireOrganization = true } = {}) {
    if (!cleanClientId || !cleanClientSecret || !cleanRefreshToken) {
      throw new ZohoBooksError(
        'ZOHO_BOOKS_CONFIG_ERROR',
        'Zoho Books credentials not configured. Set ZOHO_BOOKS_CLIENT_ID, ZOHO_BOOKS_CLIENT_SECRET, and ZOHO_BOOKS_REFRESH_TOKEN.'
      );
    }
    if (requireOrganization) resolveOrganizationId(organizationId);
  }

  async function refreshAccessToken() {
    validateCredentials({ requireOrganization: false });

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
    // Scope metadata belongs to this access token and is refreshed with it.
    // Some Zoho responses omit it; absence is not evidence of a missing grant.
    cachedPaymentScopeReport = scopeReport(data.scope, ['ZohoBooks.vendorpayments.CREATE']);
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
    cachedPaymentScopeReport = null;
    tokenExpiresAt = 0;
  }

  async function requestWithRetry(requestFn, operationName, organizationId = null, diagnosticPayload = null) {
    validateCredentials({ organizationId });

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
          handleRequestError(retryErr, operationName, diagnosticPayload, organizationId);
        }
      } else {
        handleRequestError(firstErr, operationName, diagnosticPayload, organizationId);
      }
    }
  }

  function handleRequestError(err, operation, diagnosticPayload = null, organizationId = null) {
    if (operation === 'recordBillPayment') {
      if (err instanceof ZohoBooksError) throw err;
      const status = err?.response?.status;
      const providerCode = err?.response?.data?.code;
      const rejected = Number.isInteger(status) && status >= 400 && status < 500 && ![408, 409, 429].includes(status)
        || status === 200 && providerCode !== undefined && providerCode !== 0;
      throw new ZohoBooksError(rejected ? 'PAYMENT_REJECTED' : 'PAYMENT_OUTCOME_UNCONFIRMED',
        rejected ? 'Zoho rejected the payment record; no confirmed payment was returned.' : 'The payment outcome is unconfirmed; reconcile the existing bill before retrying.',
        { httpStatus: status || null, providerCode: providerCode ?? null, operation, method: 'POST', endpoint: '/vendorpayments' });
    }
    if (operation === 'createBill') {
      // A rejected HTTP-200 envelope is normalized here inside createBill.
      if (err instanceof ZohoBooksError && err.endpoint === '/bills' && err.method === 'POST') throw err;
      const status = err?.response?.status;
      const code = err?.response?.data?.code;
      const diagnosticSecrets = [...secrets, cleanClientId, organizationId,
        ...Object.entries(env).filter(([key]) => /TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL|MONGODB_URI/.test(key)).map(([, value]) => value)];
      let providerMessage = null;
      try { providerMessage = sanitizeBillProviderMessage(err?.response?.data?.message, diagnosticSecrets, diagnosticPayload); } catch { /* Omit text if sanitization fails. */ }
      const diagnostic = {
        httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
        providerCode: Number.isSafeInteger(code) || (typeof code === 'string' && /^-?\d{1,12}$/.test(code)) ? code : null,
        providerMessage,
        operation: 'createBill', method: 'POST', endpoint: '/bills',
      };
      try { _logger?.error?.({ event: 'zoho.books.bill_create_failed', ...diagnostic }); } catch { /* Logging must not change save/retry semantics. */ }
      throw new ZohoBooksError('ZOHO_BOOKS_API_ERROR',
        `Zoho Books createBill failed: ${diagnostic.providerMessage || 'Zoho did not confirm a created bill ID.'}`, diagnostic);
    }
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

  async function shareContactLookup({ organizationId, contactType, searchText = '', review = false }, lookup) {
    validateCredentials({ organizationId });
    const key = JSON.stringify([resolveOrganizationId(organizationId), contactType, searchText]);
    const useReviewCache = review === true && contactType === 'vendor';
    if (useReviewCache) {
      const cached = vendorReviewCache.get(key);
      if (cached?.expiresAt > Date.now()) return structuredClone(cached.contacts);
      vendorReviewCache.delete(key);
    }
    let pending = pendingContactLookups.get(key);
    if (!pending) {
      pending = { review: useReviewCache, promise: null };
      pending.promise = Promise.resolve().then(lookup).then(contacts => {
        // Cache only a complete review lookup that still owns its slot. Vendor
        // creation removes that ownership before and after the write, so an
        // older scan cannot repopulate the cache after either invalidation.
        if (pending.review && pendingContactLookups.get(key) === pending) {
          const now = Date.now();
          for (const [cachedKey, cached] of vendorReviewCache) {
            if (cached.expiresAt <= now) vendorReviewCache.delete(cachedKey);
          }
          vendorReviewCache.delete(key);
          vendorReviewCache.set(key, { contacts, expiresAt: now + vendorReviewCacheTtlMs });
          while (vendorReviewCache.size > vendorReviewCacheLimit) {
            vendorReviewCache.delete(vendorReviewCache.keys().next().value);
          }
        }
        return contacts;
      });
      pendingContactLookups.set(key, pending);
    } else if (useReviewCache) {
      pending.review = true;
    }
    try {
      // Ordinary callers share only simultaneous work; bill review may reuse
      // the completed vendor list briefly. Each caller always gets its own raw
      // contacts and normalized fields, since bill drafts can edit them.
      return structuredClone(await pending.promise);
    } finally {
      if (pendingContactLookups.get(key) === pending) pendingContactLookups.delete(key);
    }
  }

  async function searchVendor({ name = '', searchText = '', organizationId = null, fresh = false, review = false } = {}) {
    const term = (searchText || name || '').trim();
    if (!term) return [];
    // Vendor matching deliberately scans every vendor, regardless of the name.
    const lookup = () => requestWithRetry(async (token) => {
      const contacts = [];
      await visitContactPages({
        fetchPage: async page => (await http.get(`${cleanBaseUrl}/contacts`, {
          params: {
            organization_id: resolveOrganizationId(organizationId),
            contact_type: 'vendor',
            filter_by: 'Status.All',
            page,
            per_page: 200,
          },
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          timeout,
          httpsAgent,
        }))?.data,
        visitPage: data => {
          if (data?.code !== undefined && data.code !== 0) throw new ZohoBooksError('VENDOR_LOOKUP_FAILED', 'Zoho rejected the vendor lookup.');
          if (!Array.isArray(data?.contacts)) throw new ZohoBooksError('VENDOR_LOOKUP_FAILED', 'Zoho returned an invalid vendor list.');
          contacts.push(...data.contacts);
        },
        incompleteError: () => new ZohoBooksError('VENDOR_LOOKUP_INCOMPLETE', 'Zoho vendor lookup could not be completed safely.'),
      });
      const seen = new Set();
      return contacts.filter(c => !c.contact_type || c.contact_type === 'vendor').map((c) => ({
        id: String(c.contact_id || c.id),
        name: c.contact_name || c.vendor_name || c.company_name || '',
        companyName: c.company_name || null,
        email: c.email || null,
        phone: c.phone || c.mobile || null,
        trn: c.tax_registration_number || c.vat_reg_no || c.tax_reg_no || c.gst_no || c.trn || null,
        status: c.status || null,
        organizationId: c.organization_id ? String(c.organization_id) : null,
        raw: c,
      })).filter(vendor => {
        if (!vendor.id || vendor.id === 'undefined' || seen.has(vendor.id)) return false;
        seen.add(vendor.id);
        return true;
      });
    }, 'searchVendor', organizationId);
    // SAVE rechecks inside its vendor lock must begin a new scan, including
    // when another process may have created a vendor before acquiring the lock.
    return fresh === true ? lookup() : shareContactLookup({ organizationId, contactType: 'vendor', review }, lookup);
  }

  async function createVendor({ name, organizationId = null } = {}) {
    const contactName = nullableText(name);
    if (!contactName) throw new ZohoBooksError('INVALID_INPUT', 'Vendor name is required.');
    validateCredentials({ organizationId });
    const lookupKey = JSON.stringify([resolveOrganizationId(organizationId), 'vendor', '']);
    // A SAVE recheck must not join a scan begun before this contact mutation.
    // Clear at both boundaries, including uncertain/failed creation outcomes.
    // Existing awaiters retain their own promise and cannot clear a newer one.
    pendingContactLookups.delete(lookupKey);
    vendorReviewCache.delete(lookupKey);
    try {
      return await requestWithRetry(async token => {
        const response = await http.post(`${cleanBaseUrl}/contacts`, { contact_name: contactName, contact_type: 'vendor' }, {
          params: { organization_id: resolveOrganizationId(organizationId) },
          headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
          timeout,
          httpsAgent,
        });
        const contact = response?.data?.contact;
        const id = nullableText(contact?.contact_id);
        if (response?.data?.code !== 0 || !id || (contact.contact_type && contact.contact_type !== 'vendor')) {
          throw new ZohoBooksError('ZOHO_BOOKS_INVALID_RESPONSE', 'Zoho did not confirm a created vendor ID.');
        }
        return {
          id, name: contact.contact_name || contactName, companyName: contact.company_name || null,
          status: contact.status || null, organizationId, raw: contact,
        };
      }, 'createVendor', organizationId);
    } finally {
      pendingContactLookups.delete(lookupKey);
      vendorReviewCache.delete(lookupKey);
    }
  }

  async function searchCustomer({ searchText = '', organizationId = null } = {}) {
    const term = String(searchText || '').trim();
    return shareContactLookup({ organizationId, contactType: 'customer', searchText: term }, () => requestWithRetry(async (token) => {
      const contacts = [];
      await visitContactPages({
        fetchPage: async page => (await http.get(`${cleanBaseUrl}/contacts`, {
          params: {
            organization_id: resolveOrganizationId(organizationId),
            contact_type: 'customer',
            page,
            per_page: 200,
            ...(term ? { search_text: term } : {}),
          },
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          timeout,
          httpsAgent,
        }))?.data,
        visitPage: (data, page) => {
          if (data?.code !== undefined && data.code !== 0) throw new ZohoBooksError('CUSTOMER_LOOKUP_FAILED', 'Zoho rejected the customer lookup.');
          if (!Array.isArray(data?.contacts)) throw new ZohoBooksError('CUSTOMER_LOOKUP_FAILED', 'Zoho returned an invalid customer list.');
          const pageContacts = data.contacts;
          contacts.push(...pageContacts);
          _logger?.debug?.({
            event: 'zoho.books.customer_lookup.page',
            page,
            count: pageContacts.length,
            fields: [...new Set(pageContacts.flatMap(contact => Object.keys(contact || {})))].sort(),
          });
        },
        incompleteError: () => new ZohoBooksError('CUSTOMER_LOOKUP_INCOMPLETE', 'Zoho customer lookup could not be completed safely.'),
      });

      const seen = new Set();
      const mapped = contacts.map(normalizeCustomerContact).filter(contact => {
        if (!contact || seen.has(contact.contactId)) return false;
        seen.add(contact.contactId);
        return Boolean(contact.displayName);
      });
      if (!term) return mapped;
      const needle = term.toLowerCase();
      return mapped.filter(contact => [contact.contactName, contact.companyName, contact.displayName, contact.phone, contact.mobile, contact.email, contact.raw.customer_code, contact.raw.contact_number]
        .filter(Boolean).some(value => String(value).toLowerCase().includes(needle)));
    }, 'searchCustomer', organizationId));
  }

  async function getCustomer(contactId, { organizationId = null } = {}) {
    const cleanContactId = nullableText(contactId);
    if (!cleanContactId) throw new ZohoBooksError('INVALID_INPUT', 'contactId is required to fetch a Zoho Books customer.');

    return requestWithRetry(async (token) => {
      const response = await http.get(`${cleanBaseUrl}/contacts/${encodeURIComponent(cleanContactId)}`, {
        params: { organization_id: resolveOrganizationId(organizationId) },
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout,
        httpsAgent,
      });
      if (response?.data?.code !== undefined && response.data.code !== 0) throw new ZohoBooksError('CUSTOMER_LOOKUP_FAILED', 'Zoho rejected the customer lookup.');
      const contact = normalizeCustomerContact(response?.data?.contact || response?.data);
      if (!contact) throw new ZohoBooksError('CUSTOMER_LOOKUP_FAILED', 'Zoho returned an invalid customer record.');
      if (contact.contactId !== cleanContactId) throw new ZohoBooksError('CUSTOMER_ID_MISMATCH', 'Zoho returned a different customer than the one selected.');
      _logger?.debug?.({
        event: 'zoho.books.customer_lookup.detail',
        contactId: contact.contactId,
        fields: Object.keys(contact.raw || {}).sort(),
      });
      return contact;
    }, 'getCustomer', organizationId);
  }

  async function checkDuplicateBill({ billNumber, vendorId = null, organizationId = null }) {
    if (!billNumber || typeof billNumber !== 'string' || !billNumber.trim()) {
      throw new ZohoBooksError('INVALID_INPUT', 'billNumber is required for duplicate check.');
    }

    const cleanBillNumber = billNumber.trim();

    const bills = [];
    for (let page = 1; page <= 100; page++) {
      const data = await getJson('/bills', { search_text: cleanBillNumber, page, per_page: 200 }, organizationId);
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
    expectedTotal = null,
    subtotal = null,
    taxAmount = null,
    currency = 'AED',
    currencyId = null,
    customerId = null,
    customerDetails = null,
    paymentType = null,
    notes = null,
    referenceNumber = null,
    attachment: _attachment = null,
    organizationId = null,
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

    const accountId = await billAccounts.forCreate(lineItems, resolveOrganizationId(organizationId));
    const items = Array.isArray(lineItems) && lineItems.length > 0
      ? lineItems.map((item) => ({
        // Only an organization-scoped, verified backend default can supply
        // this accounting metadata; never trust IDs from invoice extraction.
        ...(accountId ? { account_id: accountId } : {}),
        // Zoho associates bill customers on line items. Never invent an ID
        // for a manual customer or enable billable/rebilling implicitly.
        ...(customerId ? { customer_id: String(customerId).trim() } : {}),
        description: item.description || item.name || 'Purchased Item',
        rate: sourceLineRate(item),
        quantity: typeof item.quantity === 'number' ? item.quantity : 1,
        tax_id: item.tax_id || item.taxId || undefined,
        tax_percentage: item.tax_percentage || item.tax || undefined,
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
      is_inclusive_tax: false,
      is_item_level_tax_calc: true,
      ...(customerId ? { customer_id: String(customerId).trim() } : {}),
      ...(currencyId ? { currency_id: currencyId } : {}),
    };

    const paymentNote = paymentType ? `Payment method: ${String(paymentType).trim()}` : null;
    const customerNote = customerId ? `Zoho customer ID: ${String(customerId).trim()}` : null;
    const combinedNotes = [notes,
      Number.isFinite(expectedTotal) ? `Source document total: ${currency} ${expectedTotal.toFixed(currencyPrecision(currency))}` : null,
      Number.isFinite(subtotal) && Number.isFinite(taxAmount) ? `Source document subtotal: ${subtotal.toFixed(currencyPrecision(currency))}; tax: ${taxAmount.toFixed(currencyPrecision(currency))}` : null,
      ...customerBillNotes(customerDetails || {}).filter(note => !String(notes || '').includes(note)),
      paymentNote && !/payment method\s*:/i.test(String(notes || '')) ? paymentNote : null,
      customerNote && !/zoho customer id\s*:/i.test(String(notes || '')) ? customerNote : null,
    ].filter(Boolean).join('\n');
    if (combinedNotes) payload.notes = combinedNotes;
    if (referenceNumber) payload.reference_number = String(referenceNumber).trim();

    return requestWithRetry(async (token) => {
      const response = await http.post(`${cleanBaseUrl}/bills`, payload, {
        params: {
          organization_id: resolveOrganizationId(organizationId),
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
      if (response?.data?.code !== 0 || !createdId) handleRequestError({ response }, 'createBill', payload, organizationId);

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
    }, 'createBill', organizationId, payload);
  }

  async function attachBillFile({ billId, buffer, filename, mimeType = 'application/pdf', organizationId = null } = {}) {
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
          organization_id: resolveOrganizationId(organizationId),
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
    }, 'attachBillFile', organizationId);
  }

  function buildZohoBillUrl(billId, organizationId = null) {
    if (!billId) return null;
    return `https://${domain}/app/${resolveOrganizationId(organizationId)}#/bills/${billId}`;
  }

  async function getJson(path, params = {}, organizationId = null) {
    return requestWithRetry(async token => {
      const response = await http.get(`${cleanBaseUrl}${path}`, { params: { ...params, organization_id: resolveOrganizationId(organizationId) }, headers: { Authorization: `Zoho-oauthtoken ${token}` }, timeout, httpsAgent, maxRedirects: 0 });
      if (response?.data?.code !== 0) throw new ZohoBooksError('ZOHO_BOOKS_INVALID_RESPONSE', 'Zoho did not confirm the read operation.');
      return response.data;
    }, 'read', organizationId);
  }

  async function prepareBill(bill, vendor, { organizationId = null } = {}) {
    billAccounts.clear(bill.line_items);
    // SAVE has just re-read this vendor in the selected organization. UAE
    // purchase VAT is not allowed for a non-VAT-registered vendor (71538).
    // Never infer registration or reverse charge from an invoice's 5% rate,
    // and never discard source VAT to make that conflicting bill acceptable.
    // Zoho inherits the vendor's treatment when POST /bills omits it.
    if (vendor.raw?.tax_treatment === 'vat_not_registered'
        && (bill.tax_amount > 0 || bill.line_items.some(item =>
          (item.tax_percentage ?? item.tax) > 0 || item.tax_id || item.taxId
          || item.tax_exemption_id || item.tax_exemption_code))) {
      throw new ZohoBooksError('VENDOR_VAT_TREATMENT_CONFLICT',
        'Source VAT conflicts with the vendor VAT treatment in Zoho Books. An administrator must verify the vendor tax setup; source VAT was not changed.',
        { operation: 'prepareBill' });
    }
    // These organization-scoped reads are independent. Settle all of them,
    // then retain the original currency -> amounts -> tax -> account error
    // order, regardless of which request finishes first. Nothing is written.
    const [currencyResult, taxResult, accountResult] = await Promise.allSettled([
      getJson('/settings/currencies', {}, organizationId),
      bill.tax_amount > 0 ? getJson('/settings/taxes', {}, organizationId) : Promise.resolve(null),
      Promise.resolve().then(() => billAccounts.prepare(bill.line_items, resolveOrganizationId(organizationId))),
    ]);
    try {
      if (currencyResult.status === 'rejected') throw currencyResult.reason;
      const currency = (currencyResult.value.currencies || []).find(item => item.currency_code === bill.currency);
      if (!currency?.currency_id) throw new ZohoBooksError('CURRENCY_NOT_FOUND', 'Currency is not configured in Zoho Books.');
      bill.currency_id = currency.currency_id;
      if (vendor.raw?.currency_id && String(vendor.raw.currency_id) !== String(currency.currency_id)) throw new ZohoBooksError('VENDOR_CURRENCY_MISMATCH', 'Vendor currency differs from the source bill.');
      const calculatedSubtotal = bill.line_items.reduce((sum, item) => sum + item.quantity * sourceLineRate(item), 0);
      if (bill.line_items.some(item => item.amount != null && Math.abs(item.quantity * item.rate - item.amount) > 0.05 && !isTaxInclusiveSourceAmount(item))) throw new ZohoBooksError('LINE_AMOUNT_MISMATCH', 'A line amount differs from its quantity and rate.');
      if (bill.subtotal == null || bill.tax_amount == null || Math.abs(calculatedSubtotal - bill.subtotal) > 0.05) throw new ZohoBooksError('TOTAL_MISMATCH', 'Confirm subtotal, tax, quantity and rates before saving.');
      if (bill.tax_amount > 0) {
        if (taxResult.status === 'rejected') throw taxResult.reason;
        const taxes = taxResult.value;
        // Do not infer item-level tax allocation from the total tax.
        let calculatedTax = 0;
        for (const item of bill.line_items) {
          const percentage = item.tax_percentage ?? item.tax;
          if (!Number.isFinite(percentage)) throw new ZohoBooksError('TAX_ALLOCATION_REQUIRED', 'Supply the tax percentage for each item.');
          const matches = (taxes.taxes || []).filter(tax => Number(tax.tax_percentage) === percentage && tax.tax_type === 'tax');
          if (matches.length !== 1) throw new ZohoBooksError('TAX_AMBIGUOUS', 'Tax mapping is missing or ambiguous.');
          item.tax_id = matches[0].tax_id;
          calculatedTax += item.quantity * sourceLineRate(item) * percentage / 100;
        }
        if (Math.abs(calculatedTax - bill.tax_amount) > 0.05) throw new ZohoBooksError('TAX_MISMATCH', 'Line tax differs from the source bill.');
      }
      // Resolve before the workflow records create intent, so an invalid mapping
      // follows the existing safe preflight failure/review path (no bill POST).
      if (accountResult.status === 'rejected') throw accountResult.reason;
      return bill;
    } catch (error) {
      // A successful parallel account read must not authorize createBill when
      // another required validation failed. All reads have settled by now.
      billAccounts.clear(bill.line_items);
      throw error;
    }
  }

  async function getBillPdf(billId, { organizationId = null } = {}) {
    if (!/^[a-zA-Z0-9_-]+$/.test(billId || '')) throw new ZohoBooksError('INVALID_INPUT', 'A bill ID is required.');
    const data = await getJson(`/bills/${billId}`, {}, organizationId);
    if (String(data.bill?.bill_id) !== String(billId)) throw new ZohoBooksError('BILL_ID_MISMATCH', 'Zoho returned a different bill.');
    const { renderCreatedBillPdf } = require('./billPdf');
    const { organizationById } = require('./organizations');
    const buffer = await renderCreatedBillPdf(data.bill, { fontPath: env.BILL_PDF_FONT_PATH,
      organizationName: organizationById(organizationId)?.displayName });
    return { buffer, mimeType: 'application/pdf', source: 'generated_from_zoho_record', bill: data.bill };
  }

  async function getBill(billId, { organizationId = null } = {}) {
    if (!/^[a-zA-Z0-9_-]+$/.test(billId || '')) throw new ZohoBooksError('INVALID_INPUT', 'A bill ID is required.');
    const data = await getJson(`/bills/${billId}`, {}, organizationId);
    const bill = data.bill;
    if (!bill || String(bill.bill_id) !== String(billId)) throw new ZohoBooksError('BILL_ID_MISMATCH', 'Zoho returned a different bill.');
    if (bill.organization_id != null && String(bill.organization_id) !== resolveOrganizationId(organizationId)) {
      throw new ZohoBooksError('BILL_ORGANIZATION_MISMATCH', 'Zoho returned a bill from a different organization.');
    }
    return { id: String(bill.bill_id), billNumber: bill.bill_number, vendorId: String(bill.vendor_id || ''),
      total: bill.total == null ? null : Number(bill.total), currencyCode: bill.currency_code || null,
      status: bill.status, balance: bill.balance == null ? null : Number(bill.balance),
      roundingAdjustment: Number(bill.adjustment || 0), raw: data };
  }

  // Called only AFTER the workflow has persisted the created ID. A failed
  // verification must resume this same bill, never repeat POST /bills.
  async function verifyBillTotal(billId, { organizationId = null, expectedTotal, expectedCurrency = null } = {}) {
    const precision = currencyPrecision(expectedCurrency || 'AED');
    const factor = 10 ** precision;
    const expected = moneyUnits(expectedTotal, precision);
    if (expected === null || expected < 0) throw new ZohoBooksError('INVALID_INPUT', 'A valid source total is required.');
    function validate(bill) {
      if (expectedCurrency && bill.currencyCode !== expectedCurrency) throw new ZohoBooksError('BILL_CURRENCY_MISMATCH', 'The saved bill currency differs from the source document.');
      if (moneyUnits(bill.total, precision) === null) throw new ZohoBooksError('BILL_TOTAL_UNCONFIRMED', 'Zoho did not return a saved bill total.');
    }
    let bill = await getBill(billId, { organizationId });
    validate(bill);
    const difference = expected - moneyUnits(bill.total, precision);
    if (difference !== 0) {
      // Correct only a demonstrable rounding difference. Never hide a material
      // extraction, currency, discount or tax-allocation error in adjustment.
      if (Math.abs(difference) > 5 || !Number.isFinite(bill.roundingAdjustment)
          || Math.abs(moneyUnits(bill.roundingAdjustment, precision) + difference) > 5) {
        throw new ZohoBooksError('BILL_TOTAL_MISMATCH', 'The saved bill total differs from the source document; administrator review is required.');
      }
      if (bill.status === 'paid' || (Number.isFinite(bill.balance) && moneyUnits(bill.balance, precision) !== moneyUnits(bill.total, precision))) {
        throw new ZohoBooksError('BILL_TOTAL_MISMATCH', 'The saved bill has payments or credits and cannot be automatically adjusted.');
      }
      const adjustment = (moneyUnits(bill.roundingAdjustment, precision) + difference) / factor;
      if (!bill.vendorId || !bill.billNumber) throw new ZohoBooksError('BILL_TOTAL_UNCONFIRMED', 'The saved bill identifiers needed for rounding reconciliation are missing.');
      // An absolute adjustment makes retries safe, even if the PUT response
      // was lost. Re-read before every attempt; never increment blindly.
      await requestWithRetry(async token => {
        const response = await http.put(`${cleanBaseUrl}/bills/${billId}`, {
          vendor_id: bill.vendorId, bill_number: bill.billNumber,
          adjustment, adjustment_description: 'Source document rounding reconciliation',
        }, { params: { organization_id: resolveOrganizationId(organizationId) },
          headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' }, timeout, httpsAgent });
        if (response?.data?.code !== 0) throw new ZohoBooksError('BILL_ADJUSTMENT_UNCONFIRMED', 'Zoho did not confirm the rounding adjustment.');
      }, 'reconcileBillTotal', organizationId);
      bill = await getBill(billId, { organizationId });
      validate(bill);
      if (moneyUnits(bill.total, precision) !== expected) throw new ZohoBooksError('BILL_TOTAL_MISMATCH', 'The saved bill still differs from the source document after rounding reconciliation.');
    }
    return bill;
  }

  async function paymentAccountContext(paymentType, organizationId) {
    const { normalizePaymentMethod } = require('./paymentMethods');
    const paymentMode = normalizePaymentMethod(paymentType);
    if (!paymentMode) throw new ZohoBooksError('PAYMENT_METHOD_REQUIRED', 'A supported payment method is required.');
    const selectedId = resolveOrganizationId(organizationId);
    await getAccessToken();
    if (cachedPaymentScopeReport?.metadataAvailable && cachedPaymentScopeReport.missing.length) {
      throw new ZohoBooksError('PAYMENT_SCOPE_REQUIRED',
        'Zoho authorization is missing permission to record vendor payments. An administrator must update the Books authorization.',
        { operation: 'paymentPreflight' });
    }
    const accountType = paymentMode === 'Cash' ? 'cash' : paymentMode === 'Credit Card' ? 'credit_card' : 'bank';
    return { paymentMode, selectedId, accountType };
  }

  function isValidPaymentAccount(account, accountId, selectedId, accountType) {
    return Boolean(account && /^\d{1,128}$/.test(accountId) && String(account.account_id) === accountId
      && account.is_active === true && account.account_type === accountType
      && (account.organization_id == null || String(account.organization_id) === selectedId));
  }

  async function readActivePaymentAccounts(selectedId) {
    const accounts = [];
    for (let page = 1; page <= 100; page += 1) {
      const data = await getJson('/chartofaccounts', { page, per_page: 200, filter_by: 'AccountType.Active' }, selectedId);
      if (!Array.isArray(data.chartofaccounts)) {
        throw new ZohoBooksError('PAYMENT_ACCOUNT_LOOKUP_FAILED', 'Zoho returned an invalid payment account list.');
      }
      accounts.push(...data.chartofaccounts);
      if (!data.page_context?.has_more_page) return accounts;
    }
    throw new ZohoBooksError('PAYMENT_ACCOUNT_LOOKUP_INCOMPLETE', 'Zoho payment account lookup could not be completed safely.');
  }

  async function listPaymentAccounts({ paymentType, organizationId = null } = {}) {
    const { selectedId, accountType } = await paymentAccountContext(paymentType, organizationId);
    // Cash, bank and card choices use the same active-account endpoint. Share
    // only an in-flight traversal within this organization, never a completed
    // result. Later choices and SAVE's account-detail validation remain fresh.
    let pending = pendingPaymentAccountLists.get(selectedId);
    if (!pending) {
      pending = readActivePaymentAccounts(selectedId);
      pendingPaymentAccountLists.set(selectedId, pending);
    }
    let activeAccounts;
    try { activeAccounts = await pending; }
    finally {
      if (pendingPaymentAccountLists.get(selectedId) === pending) pendingPaymentAccountLists.delete(selectedId);
    }
    const accounts = [];
    const seen = new Set();
    for (const account of activeAccounts) {
      const id = String(account?.account_id || '').trim();
      const name = nullableText(account?.account_name);
      if (!name || seen.has(id) || !isValidPaymentAccount(account, id, selectedId, accountType)) continue;
      seen.add(id);
      accounts.push({ id, name, type: accountType, organizationId: selectedId });
    }
    return accounts;
  }

  async function prepareBillPayment({ paymentType, organizationId = null, paymentAccountId = null } = {}) {
    const { readOrganizationIds } = require('./organizations');
    const { paymentMode, selectedId, accountType } = await paymentAccountContext(paymentType, organizationId);
    let accountId;
    if (paymentAccountId != null) {
      // A worker's choice takes precedence, but is never trusted without a fresh
      // detail read in this organization. Do not silently fall back on bad input.
      accountId = String(paymentAccountId).trim();
      if (!/^\d{1,128}$/.test(accountId)) throw new ZohoBooksError('PAYMENT_ACCOUNT_INVALID', 'Select a valid payment account for this organization.');
    } else {
      const matches = Object.entries(readOrganizationIds(env)).filter(([, id]) => id === selectedId);
      if (matches.length !== 1) throw new ZohoBooksError('PAYMENT_ACCOUNT_CONFIG_REQUIRED', 'Select a payment account for the selected organization and payment method.');
      const methodKey = paymentMode.toUpperCase().replace(/\s+/g, '_');
      const key = `ZOHO_BOOKS_${matches[0][0].toUpperCase()}_PAYMENT_${methodKey}_ACCOUNT_ID`;
      accountId = String(env[key] || '').trim();
      if (!/^\d{1,128}$/.test(accountId)) throw new ZohoBooksError('PAYMENT_ACCOUNT_CONFIG_REQUIRED', 'Select a payment account for the selected organization and payment method.');
    }
    const data = await getJson(`/chartofaccounts/${accountId}`, {}, selectedId);
    const account = data.chart_of_account;
    if (!isValidPaymentAccount(account, accountId, selectedId, accountType)) {
      throw new ZohoBooksError('PAYMENT_ACCOUNT_INVALID', 'The payment account is inactive, incompatible, or belongs to another organization.');
    }
    return { accountId, paymentMode, accountName: nullableText(account.account_name) || accountId };
  }

  // Records a payment ALREADY made by the worker; never initiates a transfer.
  // The caller owns the durable payment intent. A timeout is uncertain and
  // must not cause another POST; reconciliation uses GET /bills/{id} instead.
  async function recordBillPayment({ billId, vendorId, amount, paymentDate, paymentType,
    organizationId = null, referenceNumber = null, expectedCurrency = null, paymentAccountId = null } = {}) {
    const precision = currencyPrecision(expectedCurrency || 'AED');
    const units = moneyUnits(amount, precision);
    if (!vendorId || units === null || units <= 0 || typeof amount !== 'number') {
      throw new ZohoBooksError('INVALID_INPUT', 'A vendor and positive payment amount are required.');
    }
    const date = normalizeDate(paymentDate);
    // The caller has already persisted its payment intent. Read/auth failures
    // at this stage are safe to retry because no payment POST was attempted.
    // Keep this boundary separate from the post-write verification below.
    async function readBeforePayment(read) {
      try { return await read(); }
      catch (error) {
        if (['PAYMENT_ACCOUNT_CONFIG_REQUIRED', 'PAYMENT_ACCOUNT_INVALID', 'PAYMENT_METHOD_REQUIRED', 'PAYMENT_SCOPE_REQUIRED',
          'BILL_ID_MISMATCH', 'BILL_ORGANIZATION_MISMATCH'].includes(error?.code)) throw error;
        throw new ZohoBooksError('PAYMENT_PREFLIGHT_FAILED',
          'Payment validation could not be completed. No payment was submitted; retry the validation.',
          { operation: 'paymentPreflight' });
      }
    }
    // Read fresh bill and account details together, but keep bill validation
    // first. An already-paid bill needs no account and must never be paid again.
    const [billResult, accountResult] = await Promise.allSettled([
      readBeforePayment(() => getBill(billId, { organizationId })),
      readBeforePayment(() => prepareBillPayment({ paymentType, organizationId, paymentAccountId })),
    ]);
    if (billResult.status === 'rejected') throw billResult.reason;
    const before = billResult.value;
    if (before.vendorId !== String(vendorId)) throw new ZohoBooksError('PAYMENT_VENDOR_MISMATCH', 'The saved bill has a different vendor.');
    if (expectedCurrency && before.currencyCode !== expectedCurrency) throw new ZohoBooksError('BILL_CURRENCY_MISMATCH', 'The saved bill currency differs from the source document.');
    if (moneyUnits(before.total, precision) !== units) throw new ZohoBooksError('BILL_TOTAL_MISMATCH', 'The payment amount differs from the saved bill total.');
    if (before.status === 'paid' && moneyUnits(before.balance, precision) === 0) {
      return { id: null, status: 'paid', balance: 0, alreadyPaid: true, bill: before };
    }
    if (moneyUnits(before.balance, precision) !== units) throw new ZohoBooksError('PAYMENT_BALANCE_MISMATCH', 'The bill balance changed. Reconcile existing payments before retrying.');
    if (accountResult.status === 'rejected') throw accountResult.reason;
    const { accountId, paymentMode } = accountResult.value;
    const payload = { vendor_id: String(vendorId), amount: units / 10 ** precision, date,
      payment_mode: paymentMode, paid_through_account_id: accountId,
      reference_number: String(referenceNumber || `WA-BILL-${billId}`).slice(0, 100),
      bills: [{ bill_id: String(billId), amount_applied: units / 10 ** precision }] };
    const payment = await requestWithRetry(async token => {
      const response = await http.post(`${cleanBaseUrl}/vendorpayments`, payload, {
        params: { organization_id: resolveOrganizationId(organizationId) },
        headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' }, timeout, httpsAgent,
      });
      const result = response?.data?.vendorpayment || response?.data?.payment || response?.data;
      if (response?.data?.code !== undefined && response.data.code !== 0) {
        // Keep the provider envelope for authentication retry and distinguish
        // a confirmed rejection from a lost/invalid success response.
        throw Object.assign(new Error('Payment rejected'), { response });
      }
      if (response?.data?.code !== 0 || !result?.payment_id) throw new ZohoBooksError('PAYMENT_OUTCOME_UNCONFIRMED', 'Zoho did not confirm the recorded payment ID.');
      return result;
    }, 'recordBillPayment', organizationId);
    let after;
    try { after = await getBill(billId, { organizationId }); }
    catch {
      const error = new ZohoBooksError('PAYMENT_OUTCOME_UNCONFIRMED', 'Payment was recorded but its paid status could not be read.');
      error.paymentId = String(payment.payment_id);
      throw error;
    }
    if (after.status !== 'paid' || moneyUnits(after.balance, precision) !== 0
        || after.vendorId !== String(vendorId) || moneyUnits(after.total, precision) !== units
        || (expectedCurrency && after.currencyCode !== expectedCurrency)) {
      const error = new ZohoBooksError('PAYMENT_OUTCOME_UNCONFIRMED', 'Payment was recorded but Zoho has not confirmed a fully paid bill.');
      error.paymentId = String(payment.payment_id);
      throw error;
    }
    return { id: String(payment.payment_id), status: 'paid', balance: 0, bill: after };
  }

  return {
    getAccessToken,
    invalidateToken,
    searchVendor,
    createVendor,
    searchCustomer,
    getCustomer,
    checkDuplicateBill,
    createBill,
    attachBillFile,
    buildZohoBillUrl,
    validateCredentials,
    prepareBill,
    getBillPdf,
    getBill,
    verifyBillTotal,
    listPaymentAccounts,
    prepareBillPayment,
    recordBillPayment,
  };
}

module.exports = {
  createZohoBooksClient,
  ZohoBooksError,
  normalizeDate,
  sanitizeErrorMessage,
};
