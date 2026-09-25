'use strict';

const path = require('node:path');
const axios = require('axios');
const { createZohoAuthService } = require('../src/services/zoho/zohoAuthService');
const { createZohoLeadService } = require('../src/services/zoho/zohoLeadService');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');
const { validateZohoUrl, safeProviderCode } = require('../src/services/zoho/zohoSupport');
const { CRM_SCOPES, BOOKS_SCOPES, scopeReport } = require('../src/services/zoho/oauthScopes');

function safeFailure(error) {
  return {
    status: 'FAIL',
    httpStatus: error.httpStatus || error.response?.status || null,
    code: safeProviderCode({ code: error.providerCode })
      || (Number.isInteger(error.providerCode) ? error.providerCode : null)
      || (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED'].includes(error.code) ? error.code : 'VERIFICATION_FAILED'),
  };
}

async function verifyService(service, env, http) {
  const crm = service === 'crm';
  const required = crm ? CRM_SCOPES : BOOKS_SCOPES;
  const prefix = crm ? 'ZOHO_' : 'ZOHO_BOOKS_';
  const keys = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', ...(crm ? [] : ['ORGANIZATION_ID'])];
  const missingConfig = keys.map(key => prefix + key).filter(key => !String(env[key] || '').trim());
  const result = { scopes: scopeReport(undefined, required), checks: {}, missingConfig, writesTested: false };
  if (missingConfig.length) {
    result.checks.authentication = { status: 'FAIL', code: 'MISSING_CONFIGURATION' };
    return result;
  }

  let accounts, base;
  try {
    accounts = validateZohoUrl(env[prefix + 'ACCOUNTS_URL'] || 'https://accounts.zoho.com', 'accounts');
    base = crm ? validateZohoUrl(env.ZOHO_API_BASE_URL || 'https://www.zohoapis.com/crm/v8', 'api')
      : String(env.ZOHO_BOOKS_BASE_URL || 'https://www.zohoapis.com/books/v3').replace(/\/+$/, '');
    if (!crm) {
      const url = new URL(base);
      validateZohoUrl(`${url.origin}/crm/v8`, 'api');
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/books/v3') throw Error('INVALID_URL');
    }
  } catch {
    result.checks.authentication = { status: 'FAIL', code: 'INVALID_ZOHO_URL' };
    return result;
  }

  // Defence in depth: the diagnostic transport can ONLY refresh or GET the
  // listed endpoints. Even accidentally calling a production write is blocked.
  async function request(options) {
    const method = String(options.method || 'GET').toUpperCase();
    const tokenRequest = method === 'POST' && options.url === `${accounts}/oauth/v2/token`
      && new URLSearchParams(options.data).get('grant_type') === 'refresh_token';
    const endpoint = options.url.startsWith(base + '/') ? options.url.slice(base.length) : '';
    const allowedRead = method === 'GET' && (crm
      ? /^\/Leads(?:\/search|\/\d{1,40}\/Attachments)?$/.test(endpoint)
      : ['/contacts', '/bills', '/settings/currencies', '/settings/taxes'].includes(endpoint));
    if (!tokenRequest && !allowedRead) throw Error('READ_ONLY_VERIFICATION_BLOCKED_REQUEST');
    const response = await http.request({ ...options, timeout: 15000, maxRedirects: 0 });
    if (tokenRequest) result.scopes = scopeReport(response?.data?.scope, required);
    return response;
  }
  const transport = {
    request,
    get: (url, options) => request({ ...options, method: 'GET', url }),
    post: (url, data, options) => request({ ...options, method: 'POST', url, data }),
  };
  async function check(name, fn) {
    try { result.checks[name] = { status: 'PASS', ...await fn() }; }
    catch (error) { result.checks[name] = safeFailure(error); }
  }
  const runtimeEnv = { ...env, ZOHO_ACCESS_TOKEN: '', [prefix + 'ACCOUNTS_URL']: accounts,
    [crm ? 'ZOHO_API_BASE_URL' : 'ZOHO_BOOKS_BASE_URL']: base };
  const client = crm ? createZohoAuthService({ env: runtimeEnv, http: transport })
    : createZohoBooksClient({ env: runtimeEnv, http: transport });
  let token;
  await check('authentication', async () => { token = await client.getAccessToken({ forceRefresh: true }); });
  if (!token) return result;

  async function get(endpoint, params = {}) {
    const response = await transport.get(`${base}${endpoint}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { ...(crm ? {} : { organization_id: env.ZOHO_BOOKS_ORGANIZATION_ID }), ...params },
    });
    if (response.status === 204) return {};
    if (response.status < 200 || response.status >= 300 || (crm ? response.data?.status === 'error' : response.data?.code !== 0)) {
      const error = Error('READ_FAILED');
      error.httpStatus = response.status;
      error.providerCode = response.data?.code;
      throw error;
    }
    return response.data;
  }
  if (crm) {
    const leads = createZohoLeadService({ env: runtimeEnv, http: transport, auth: client });
    await check('leadSearch', async () => { await leads.searchLeadByEmail('oauth-read-only-check@example.invalid'); });
    let leadId;
    await check('leadRead', async () => {
      const data = await get('/Leads', { fields: 'id', per_page: 1 });
      leadId = data.data?.[0]?.id;
      return { recordsReturned: data.data?.length || 0 };
    });
    if (typeof leadId === 'string' && /^\d{1,40}$/.test(leadId)) {
      await check('attachmentRead', async () => {
        const data = await get(`/Leads/${leadId}/Attachments`, { fields: 'id', per_page: 1 });
        return { recordsReturned: data.data?.length || 0 };
      });
    } else result.checks.attachmentRead = { status: 'SKIPPED', reason: 'No lead available for read-only attachment check.' };
  } else {
    await check('customers', async () => {
      const customers = await client.searchCustomer({ organizationId: env.ZOHO_BOOKS_ORGANIZATION_ID });
      return {
        recordsReturned: customers.length,
        withIdAndName: customers.filter(c => c.id && c.name).length,
        withPhone: customers.filter(c => c.phone).length,
        withEmail: customers.filter(c => c.email).length,
      };
    });
    for (const [name, endpoint] of [['billRead', '/bills'], ['currencyRead', '/settings/currencies'], ['taxRead', '/settings/taxes']]) {
      await check(name, async () => { await get(endpoint, { per_page: 1 }); });
    }
  }
  return result;
}

async function verifyZohoScopes({ env = process.env, http = axios, services = ['crm', 'books'] } = {}) {
  const report = { readOnly: true };
  for (const service of services) {
    if (!['crm', 'books'].includes(service)) throw Error('Unknown Zoho service');
    report[service] = await verifyService(service, env, http);
  }
  return report;
}

async function printVerification(services = ['crm', 'books']) {
  const report = await verifyZohoScopes({ services });
  console.log(JSON.stringify(report, null, 2));
  console.log('No CRM/Books records written. Read checks do not prove CREATE/UPDATE permissions or live WhatsApp delivery.');
  if (services.some(service => report[service].scopes.missing?.length || report[service].scopes.excess.length
      || !report[service].scopes.metadataAvailable
      || Object.values(report[service].checks).some(check => check.status === 'FAIL'))) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
  printVerification().catch(() => { console.error('Zoho verification failed. No credentials were printed.'); process.exitCode = 1; });
}

module.exports = { verifyZohoScopes, printVerification };
