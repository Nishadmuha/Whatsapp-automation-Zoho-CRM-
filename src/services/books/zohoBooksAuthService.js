'use strict';

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const { Agent } = require('node:https');

const httpsAgent = new Agent({ rejectUnauthorized: true, keepAlive: true });

class ZohoBooksAuthError extends Error {
  constructor(code, message, { httpStatus = null, providerError = null, operation = null } = {}) {
    super(message);
    this.name = 'ZohoBooksAuthError';
    this.code = code;
    if (httpStatus) this.httpStatus = httpStatus;
    if (providerError) this.providerError = providerError;
    if (operation) this.operation = operation;
  }
}

function redactSecrets(text, secrets = []) {
  if (typeof text !== 'string') return '';
  let clean = text;
  for (const s of secrets) {
    if (typeof s === 'string' && s.trim().length >= 4) {
      clean = clean.replaceAll(s.trim(), '[REDACTED]');
    }
  }
  return clean;
}

function createZohoBooksAuthService({
  env = process.env,
  http = axios,
  clientId = env.ZOHO_BOOKS_CLIENT_ID,
  clientSecret = env.ZOHO_BOOKS_CLIENT_SECRET,
  refreshToken = env.ZOHO_BOOKS_REFRESH_TOKEN,
  accessToken = env.ZOHO_BOOKS_ACCESS_TOKEN,
  accountsUrl = env.ZOHO_BOOKS_ACCOUNTS_URL || 'https://accounts.zoho.com',
  timeout = Number(env.ZOHO_BOOKS_TIMEOUT_MS || 15000),
  envFilePath = path.resolve(process.cwd(), '.env'),
} = {}) {
  let cleanClientId = (clientId || '').trim();
  let cleanClientSecret = (clientSecret || '').trim();
  let cleanRefreshToken = (refreshToken || '').trim();
  let cachedAccessToken = (accessToken || '').trim() || null;
  let tokenExpiresAt = cachedAccessToken ? Date.now() + 3600000 : 0;
  let inflightRefresh = null;
  const cleanAccountsUrl = (accountsUrl || 'https://accounts.zoho.com').trim().replace(/\/+$/, '');

  function getKnownSecrets() {
    return [cleanClientSecret, cleanRefreshToken, cachedAccessToken].filter(Boolean);
  }

  function setTokens({ newAccessToken, newRefreshToken, expiresIn } = {}) {
    if (typeof newAccessToken === 'string' && newAccessToken.trim()) {
      cachedAccessToken = newAccessToken.trim();
      const lifeSec = Number(expiresIn) || 3600;
      tokenExpiresAt = Date.now() + Math.max(0, (lifeSec - 60) * 1000);
    }
    if (typeof newRefreshToken === 'string' && newRefreshToken.trim()) {
      cleanRefreshToken = newRefreshToken.trim();
    }
  }

  function updateEnvFile(updates = {}) {
    if (!fs.existsSync(envFilePath)) return false;
    let content = fs.readFileSync(envFilePath, 'utf8');

    for (const [key, val] of Object.entries(updates)) {
      if (val === undefined) continue;
      const regex = new RegExp(`^#?\\s*${key}=.*$`, 'm');
      const newLine = `${key}=${val}`;
      if (regex.test(content)) {
        content = content.replace(regex, newLine);
      } else {
        content = content.trimEnd() + `\n${newLine}\n`;
      }
      process.env[key] = String(val);
    }

    fs.writeFileSync(envFilePath, content, 'utf8');
    return true;
  }

  async function exchangeAuthorizationCode({
    code,
    overrideClientId,
    overrideClientSecret,
    redirectUri,
    overrideAccountsUrl,
  } = {}) {
    const activeClientId = (overrideClientId || cleanClientId).trim();
    const activeClientSecret = (overrideClientSecret || cleanClientSecret).trim();
    const activeAccountsUrl = (overrideAccountsUrl || cleanAccountsUrl).trim().replace(/\/+$/, '');
    const activeCode = (code || '').trim();

    const currentSecrets = [activeClientSecret, activeCode, cleanRefreshToken, cachedAccessToken].filter(Boolean);

    if (!activeClientId) {
      throw new ZohoBooksAuthError('MISSING_CLIENT_ID', 'ZOHO_BOOKS_CLIENT_ID is required for code exchange.', {
        operation: 'exchangeAuthorizationCode',
      });
    }
    if (!activeClientSecret) {
      throw new ZohoBooksAuthError('MISSING_CLIENT_SECRET', 'ZOHO_BOOKS_CLIENT_SECRET is required for code exchange.', {
        operation: 'exchangeAuthorizationCode',
      });
    }
    if (!activeCode) {
      throw new ZohoBooksAuthError('MISSING_AUTH_CODE', 'Authorization code is required for exchange.', {
        operation: 'exchangeAuthorizationCode',
      });
    }

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: activeClientId,
      client_secret: activeClientSecret,
      code: activeCode,
    });

    if (redirectUri && typeof redirectUri === 'string' && redirectUri.trim()) {
      params.append('redirect_uri', redirectUri.trim());
    }

    let response;
    try {
      response = await http.post(`${activeAccountsUrl}/oauth/v2/token`, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout,
        httpsAgent,
      });
    } catch (err) {
      const status = err?.response?.status;
      const rawData = err?.response?.data;
      const rawMsg = rawData?.error || rawData?.message || err.message;
      const safeMsg = redactSecrets(String(rawMsg), currentSecrets);
      throw new ZohoBooksAuthError('CODE_EXCHANGE_HTTP_FAILED', `Failed to exchange authorization code: ${safeMsg}`, {
        httpStatus: status,
        providerError: typeof rawData?.error === 'string' ? rawData.error : null,
        operation: 'exchangeAuthorizationCode',
      });
    }

    const data = response?.data;
    if (data?.error) {
      const safeErr = redactSecrets(String(data.error), currentSecrets);
      throw new ZohoBooksAuthError('CODE_EXCHANGE_REJECTED', `Zoho rejected authorization code: ${safeErr}`, {
        httpStatus: response.status,
        providerError: data.error,
        operation: 'exchangeAuthorizationCode',
      });
    }

    if (!data?.access_token) {
      throw new ZohoBooksAuthError('INVALID_TOKEN_RESPONSE', 'Zoho returned response without access_token.', {
        operation: 'exchangeAuthorizationCode',
      });
    }

    const newAccessToken = data.access_token;
    const newRefreshToken = data.refresh_token || null;
    const expiresIn = Number(data.expires_in) || 3600;
    const apiDomain = data.api_domain || null;

    setTokens({ newAccessToken, newRefreshToken, expiresIn });

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn,
      apiDomain,
      tokenType: data.token_type || 'Bearer',
    };
  }

  async function refreshAccessToken({
    overrideClientId,
    overrideClientSecret,
    overrideRefreshToken,
    overrideAccountsUrl,
  } = {}) {
    const activeClientId = (overrideClientId || cleanClientId).trim();
    const activeClientSecret = (overrideClientSecret || cleanClientSecret).trim();
    const activeRefreshToken = (overrideRefreshToken || cleanRefreshToken).trim();
    const activeAccountsUrl = (overrideAccountsUrl || cleanAccountsUrl).trim().replace(/\/+$/, '');

    const currentSecrets = [activeClientSecret, activeRefreshToken, cachedAccessToken].filter(Boolean);

    if (!activeClientId || !activeClientSecret) {
      throw new ZohoBooksAuthError(
        'MISSING_CREDENTIALS',
        'ZOHO_BOOKS_CLIENT_ID and ZOHO_BOOKS_CLIENT_SECRET are required for token refresh.',
        { operation: 'refreshAccessToken' }
      );
    }
    if (!activeRefreshToken) {
      throw new ZohoBooksAuthError(
        'MISSING_REFRESH_TOKEN',
        'ZOHO_BOOKS_REFRESH_TOKEN is required for token refresh.',
        { operation: 'refreshAccessToken' }
      );
    }

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: activeClientId,
      client_secret: activeClientSecret,
      refresh_token: activeRefreshToken,
    });

    let response;
    try {
      response = await http.post(`${activeAccountsUrl}/oauth/v2/token`, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout,
        httpsAgent,
      });
    } catch (err) {
      const status = err?.response?.status;
      const rawData = err?.response?.data;
      const rawMsg = rawData?.error || rawData?.message || err.message;
      const safeMsg = redactSecrets(String(rawMsg), currentSecrets);
      throw new ZohoBooksAuthError('TOKEN_REFRESH_HTTP_FAILED', `Failed to refresh token: ${safeMsg}`, {
        httpStatus: status,
        providerError: typeof rawData?.error === 'string' ? rawData.error : null,
        operation: 'refreshAccessToken',
      });
    }

    const data = response?.data;
    if (data?.error) {
      const safeErr = redactSecrets(String(data.error), currentSecrets);
      throw new ZohoBooksAuthError('TOKEN_REFRESH_REJECTED', `Zoho rejected token refresh: ${safeErr}`, {
        httpStatus: response.status,
        providerError: data.error,
        operation: 'refreshAccessToken',
      });
    }

    if (!data?.access_token) {
      throw new ZohoBooksAuthError('INVALID_REFRESH_RESPONSE', 'Zoho returned response without access_token.', {
        operation: 'refreshAccessToken',
      });
    }

    const newAccessToken = data.access_token;
    const expiresIn = Number(data.expires_in) || 3600;
    const apiDomain = data.api_domain || null;

    setTokens({ newAccessToken, expiresIn });

    return {
      accessToken: newAccessToken,
      expiresIn,
      apiDomain,
      tokenType: data.token_type || 'Bearer',
    };
  }

  async function getAccessToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && cachedAccessToken && Date.now() < tokenExpiresAt) {
      return cachedAccessToken;
    }

    if (inflightRefresh) {
      return inflightRefresh;
    }

    inflightRefresh = (async () => {
      try {
        const result = await refreshAccessToken();
        return result.accessToken;
      } finally {
        inflightRefresh = null;
      }
    })();

    return inflightRefresh;
  }

  function invalidateAccessToken() {
    cachedAccessToken = null;
    tokenExpiresAt = 0;
  }

  return {
    exchangeAuthorizationCode,
    refreshAccessToken,
    getAccessToken,
    setTokens,
    invalidateAccessToken,
    updateEnvFile,
    getKnownSecrets,
  };
}

module.exports = {
  createZohoBooksAuthService,
  ZohoBooksAuthError,
  redactSecrets,
};
