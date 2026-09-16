'use strict';

const axios = require('axios');
const { ZohoError, configError, validateZohoUrl, requestOptions, apiError } = require('./zohoSupport');

function createZohoAuthService({ env = process.env, http = axios, now = Date.now } = {}) {
  let cachedToken = (typeof env.ZOHO_ACCESS_TOKEN === 'string' && env.ZOHO_ACCESS_TOKEN.trim() && !/\s/.test(env.ZOHO_ACCESS_TOKEN.trim()))
    ? env.ZOHO_ACCESS_TOKEN.trim()
    : undefined;
  let expiresAt = cachedToken ? now() + 3600000 : 0;
  let refreshing;
  let discoveredApiDomain;

  async function refresh() {
    if (!env.ZOHO_REFRESH_TOKEN && typeof require !== 'undefined') {
      try {
        require('dotenv').config({ quiet: true });
      } catch { /* ignore */ }
    }
    const baseUrl = validateZohoUrl(env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com', 'accounts');
    const options = requestOptions(env);
    for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN']) {
      if (typeof env[key] !== 'string' || !env[key].trim() || /\s/.test(env[key])) {
        throw configError(`Set a valid ${key} before using Zoho CRM.`);
      }
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      refresh_token: env.ZOHO_REFRESH_TOKEN,
    }).toString();
    let response;
    try {
      response = await http.request({
        ...options, method: 'POST', url: `${baseUrl}/oauth/v2/token`, data: body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch (error) {
      throw apiError(error?.response?.data, error?.response?.status,
        { auth: true, transport: !error?.response });
    }
    if (!Number.isInteger(response?.status) || response.status < 200 || response.status >= 300 || response?.data?.error) {
      throw apiError(response?.data, response?.status, { auth: true });
    }
    const token = response?.data?.access_token;
    const lifetime = Number(response?.data?.expires_in);
    if (typeof token !== 'string' || !token || /\s/.test(token) ||
        !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 86400) {
      throw new ZohoError('ZOHO_AUTH_RESPONSE', 'Zoho returned an invalid token response.');
    }
    // Credentials never choose a new destination from an untrusted response.
    // Check api_domain, when supplied, against the configured CRM origin.
    if (response.data.api_domain !== undefined) {
      let apiDomain;
      try { apiDomain = new URL(response.data.api_domain); } catch {
        throw new ZohoError('ZOHO_AUTH_RESPONSE', 'Zoho returned an invalid API domain.');
      }
      validateZohoUrl(`${apiDomain.origin}/crm/v8`, 'api');
      if (apiDomain.href !== `${apiDomain.origin}/` ||
          (env.ZOHO_API_BASE_URL && new URL(validateZohoUrl(env.ZOHO_API_BASE_URL, 'api')).origin !== apiDomain.origin)) {
        throw configError('ZOHO_API_BASE_URL must match the API domain for the Zoho OAuth account and environment.');
      }
      discoveredApiDomain = apiDomain.origin;
    }
    cachedToken = token;
    // Refresh early without making short-lived tokens immediately stale.
    expiresAt = now() + lifetime * 1000 - Math.min(60000, lifetime * 100);
    return token;
  }

  async function exchangeAuthorizationCode({
    code = env.ZOHO_AUTHORIZATION_CODE,
    clientId = env.ZOHO_CLIENT_ID,
    clientSecret = env.ZOHO_CLIENT_SECRET,
    redirectUri = env.ZOHO_REDIRECT_URI,
    accountsUrl = env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com',
  } = {}) {
    if (typeof code !== 'string' || !code.trim() || /\s/.test(code.trim())) {
      throw configError('A valid Zoho authorization code is required.');
    }
    if (typeof clientId !== 'string' || !clientId.trim() || /\s/.test(clientId.trim())) {
      throw configError('Set a valid ZOHO_CLIENT_ID before exchanging an authorization code.');
    }
    if (typeof clientSecret !== 'string' || !clientSecret.trim() || /\s/.test(clientSecret.trim())) {
      throw configError('Set a valid ZOHO_CLIENT_SECRET before exchanging an authorization code.');
    }
    const baseUrl = validateZohoUrl(accountsUrl, 'accounts');
    const options = requestOptions(env);
    const params = {
      grant_type: 'authorization_code',
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
      code: code.trim(),
    };
    if (redirectUri && typeof redirectUri === 'string' && redirectUri.trim()) {
      params.redirect_uri = redirectUri.trim();
    }
    const body = new URLSearchParams(params).toString();
    let response;
    try {
      response = await http.request({
        ...options, method: 'POST', url: `${baseUrl}/oauth/v2/token`, data: body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch (error) {
      throw apiError(error?.response?.data, error?.response?.status,
        { auth: true, transport: !error?.response });
    }
    if (!Number.isInteger(response?.status) || response.status < 200 || response.status >= 300 || response?.data?.error) {
      throw apiError(response?.data, response?.status, { auth: true });
    }
    const data = response?.data;
    const token = data?.access_token;
    const refreshToken = data?.refresh_token;
    const lifetime = Number(data?.expires_in);
    if (typeof token !== 'string' || !token || /\s/.test(token) ||
        !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 86400) {
      throw new ZohoError('ZOHO_AUTH_RESPONSE', 'Zoho returned an invalid token response.');
    }
    if (typeof refreshToken !== 'string' || !refreshToken || /\s/.test(refreshToken)) {
      throw new ZohoError('ZOHO_AUTH_RESPONSE', 'Zoho did not return a refresh token. The authorization code may already be consumed.');
    }
    let apiDomain = data?.api_domain;
    if (apiDomain !== undefined) {
      let parsedDomain;
      try { parsedDomain = new URL(apiDomain); } catch {
        throw new ZohoError('ZOHO_AUTH_RESPONSE', 'Zoho returned an invalid API domain.');
      }
      validateZohoUrl(`${parsedDomain.origin}/crm/v8`, 'api');
      apiDomain = parsedDomain.origin;
      discoveredApiDomain = apiDomain;
    }
    cachedToken = token;
    expiresAt = now() + lifetime * 1000 - Math.min(60000, lifetime * 100);
    return {
      accessToken: token,
      refreshToken,
      apiDomain: discoveredApiDomain,
      apiBaseUrl: discoveredApiDomain ? `${discoveredApiDomain}/crm/v8` : undefined,
      expiresIn: lifetime,
    };
  }

  function getAccessToken({ forceRefresh = false } = {}) {
    if (refreshing) return refreshing;
    if (!forceRefresh && cachedToken && now() < expiresAt) return Promise.resolve(cachedToken);
    refreshing = refresh().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  function invalidate(rejectedToken) {
    if (rejectedToken !== undefined && rejectedToken !== cachedToken) return;
    cachedToken = undefined;
    expiresAt = 0;
  }

  function getApiDomain() {
    return discoveredApiDomain;
  }

  function getApiBaseUrl() {
    return discoveredApiDomain ? `${discoveredApiDomain}/crm/v8` : undefined;
  }

  async function getAuthHealth() {
    const hasClientId = Boolean(env.ZOHO_CLIENT_ID && typeof env.ZOHO_CLIENT_ID === 'string' && env.ZOHO_CLIENT_ID.trim());
    const hasClientSecret = Boolean(env.ZOHO_CLIENT_SECRET && typeof env.ZOHO_CLIENT_SECRET === 'string' && env.ZOHO_CLIENT_SECRET.trim());
    const hasRefreshToken = Boolean(env.ZOHO_REFRESH_TOKEN && typeof env.ZOHO_REFRESH_TOKEN === 'string' && env.ZOHO_REFRESH_TOKEN.trim());
    const hasAccessToken = Boolean(cachedToken || (env.ZOHO_ACCESS_TOKEN && typeof env.ZOHO_ACCESS_TOKEN === 'string' && env.ZOHO_ACCESS_TOKEN.trim()));

    if (!hasClientId || !hasClientSecret || !hasRefreshToken) {
      return {
        status: 'unconfigured',
        configured: false,
        authenticated: false,
        hasClientId,
        hasClientSecret,
        hasRefreshToken,
        hasAccessToken,
      };
    }

    try {
      await getAccessToken();
      return {
        status: 'authenticated',
        configured: true,
        authenticated: true,
        tokenCached: Boolean(cachedToken),
        expiresInSeconds: Math.max(0, Math.round((expiresAt - now()) / 1000)),
        apiDomain: discoveredApiDomain || null,
      };
    } catch (error) {
      return {
        status: 'error',
        configured: true,
        authenticated: false,
        code: error.code || 'ZOHO_AUTH_FAILED',
        providerCode: error.providerCode || null,
        message: error.message || 'Zoho authentication failed.',
      };
    }
  }

  return { getAccessToken, invalidate, exchangeAuthorizationCode, getApiDomain, getApiBaseUrl, getAuthHealth };
}

module.exports = { createZohoAuthService };
