'use strict';

const { Agent } = require('node:https');

const httpsAgent = new Agent({ rejectUnauthorized: true });
const REGIONS = [
  ['accounts.zoho.com', 'zohoapis.com'],
  ['accounts.zoho.eu', 'zohoapis.eu'],
  ['accounts.zoho.in', 'zohoapis.in'],
  ['accounts.zoho.com.au', 'zohoapis.com.au'],
  ['accounts.zoho.com.cn', 'zohoapis.com.cn'],
  ['accounts.zoho.jp', 'zohoapis.jp'],
  ['accounts.zoho.sa', 'zohoapis.sa'],
  ['accounts.zohocloud.ca', 'zohoapis.ca'],
];
const ACCOUNTS_HOSTS = new Set(REGIONS.map(([accounts]) => accounts));
const API_HOSTS = new Set(REGIONS.flatMap(([, domain]) =>
  ['www', 'sandbox', 'developer'].map((prefix) => `${prefix}.${domain}`)));
const SAFE_PROVIDER_CODES = new Set([
  'INVALID_TOKEN', 'INVALID_OAUTHTOKEN', 'OAUTH_SCOPE_MISMATCH', 'AUTHENTICATION_FAILURE',
  'AUTHORIZATION_FAILED', 'NO_PERMISSION', 'INVALID_DATA', 'INVALID_MODULE',
  'INVALID_URL_PATTERN', 'MANDATORY_NOT_FOUND', 'DUPLICATE_DATA', 'DUPLICATE_LINKING_DATA',
  'RECORD_LOCKED', 'NOT_APPROVED', 'ALREADY_MODIFIED', 'LIMIT_REACHED', 'LIMIT_EXCEEDED',
  'TOO_MANY_REQUESTS', 'INTERNAL_ERROR', 'INVALID_REQUEST', 'INVALID_REQUEST_METHOD',
  'INVALID_QUERY', 'INVALID_CLIENT', 'INVALID_CODE', 'INVALID_SCOPE', 'INVALID_GRANT',
  'INVALID_CLIENT_SECRET', 'ACCESS_DENIED', 'INVALID_RESPONSE', 'MULTIPLE_OR_MULTI_ERRORS',
  'FILE_SIZE_EXCEEDED', 'INVALID_FILE_TYPE', 'NOT_SUPPORTED', 'UNSUPPORTED_FILE_TYPE', 'FILE_NOT_FOUND',
]);

class ZohoError extends Error {
  constructor(code, message, { httpStatus, retryable = false, uncertain = false, providerCode } = {}) {
    super(message);
    this.name = 'ZohoError';
    this.code = code;
    this.retryable = retryable;
    this.uncertain = uncertain;
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) {
      this.httpStatus = httpStatus;
    }
    if (SAFE_PROVIDER_CODES.has(providerCode)) this.providerCode = providerCode;
  }
}

function configError(message) {
  return new ZohoError('ZOHO_CONFIG', message);
}

function validateZohoUrl(value, kind) {
  let parsed;
  try { parsed = new URL(value); } catch { throw configError(`Set a valid ${kind === 'accounts' ? 'ZOHO_ACCOUNTS_URL' : 'ZOHO_API_BASE_URL'}.`); }
  const hosts = kind === 'accounts' ? ACCOUNTS_HOSTS : API_HOSTS;
  const validPath = kind === 'accounts'
    ? /^\/$/.test(parsed.pathname)
    : /^\/crm\/v[1-9]\d*\/?$/.test(parsed.pathname);
  if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname) || parsed.port ||
      parsed.username || parsed.password || parsed.search || parsed.hash || !validPath) {
    throw configError(`The Zoho ${kind} URL must use an official regional HTTPS endpoint${kind === 'api' ? ' ending in /crm/v{version}' : ''}.`);
  }
  return parsed.href.replace(/\/$/, '');
}

function requestOptions(env, overrides = {}) {
  const timeout = overrides.timeout !== undefined ? Number(overrides.timeout) : Number(env.ZOHO_TIMEOUT_MS || 15000);
  const maxTimeout = overrides.timeout !== undefined ? 120000 : 60000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > maxTimeout) {
    throw configError('ZOHO_TIMEOUT_MS must be between 1000 and 60000 milliseconds.');
  }
  return {
    timeout, httpsAgent, maxRedirects: 0,
    maxContentLength: overrides.maxContentLength !== undefined ? overrides.maxContentLength : 2 * 1024 * 1024,
    maxBodyLength: overrides.maxBodyLength !== undefined ? overrides.maxBodyLength : 128 * 1024,
    validateStatus: () => true,
    ...overrides,
  };
}

function safeProviderCode(data) {
  const candidate = typeof data?.code === 'string' ? data.code : data?.error;
  const normalized = typeof candidate === 'string' ? candidate.toUpperCase() : undefined;
  return SAFE_PROVIDER_CODES.has(normalized) ? normalized : undefined;
}

function apiError(data, status, { mutation = false, auth = false, transport = false } = {}) {
  const providerCode = safeProviderCode(data);
  const transient = transport || status === 429 || status >= 500 || providerCode === 'INTERNAL_ERROR';
  return new ZohoError(auth ? 'ZOHO_AUTH' : 'ZOHO_API',
    auth ? 'Zoho authentication failed.' : 'Zoho CRM request failed.', {
      providerCode, httpStatus: status,
      retryable: transient && !mutation,
      uncertain: mutation && (transport || !Number.isInteger(status) || status >= 500 || providerCode === 'INTERNAL_ERROR'),
    });
}

function getApiDomainForAccounts(accountsUrl) {
  try {
    const parsed = new URL(accountsUrl);
    const match = REGIONS.find(([acc]) => acc === parsed.hostname);
    if (match) return `https://www.${match[1]}`;
  } catch { /* ignored */ }
  return 'https://www.zohoapis.com';
}

module.exports = {
  ZohoError, configError, validateZohoUrl, requestOptions, safeProviderCode, apiError,
  REGIONS, getApiDomainForAccounts,
};
