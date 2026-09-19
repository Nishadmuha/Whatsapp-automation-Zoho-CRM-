'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const axios = require('axios');
const { Agent } = require('node:https');
const {
  createZohoBooksAuthService,
  redactSecrets,
} = require('../src/services/books/zohoBooksAuthService');

const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath, quiet: true });

const httpsAgent = new Agent({ rejectUnauthorized: true, keepAlive: true });

function mask(value) {
  if (!value) return '(not set)';
  const str = String(value).trim();
  if (str.length <= 8) return '****';
  return `${str.slice(0, 4)}...${str.slice(-4)} (${str.length} chars)`;
}

async function callOrganizationEndpoint({ baseUrl, organizationId, accessToken, secrets }) {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const url = `${cleanBase}/organizations/${organizationId}`;

  try {
    const res = await axios.get(url, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
      timeout: 15000,
      httpsAgent,
    });

    const status = res.status;
    const body = res.data || {};
    const code = body.code !== undefined ? body.code : 0;
    const message = body.message || 'success';
    const orgName = body.organization?.name || body.organizations?.[0]?.name || null;

    return {
      success: true,
      httpStatus: status,
      code,
      message,
      orgName,
      raw: body,
    };
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data || {};
    const code = data.code !== undefined ? data.code : null;
    const rawMsg = data.message || data.error || err.message || 'Unknown error';
    const message = redactSecrets(String(rawMsg), secrets);

    return {
      success: false,
      httpStatus: status,
      code,
      message,
      raw: data,
    };
  }
}

async function run() {
  console.log('====================================================');
  console.log('   Voltronix — Zoho Books Connection & OAuth Test   ');
  console.log('====================================================\n');

  const clientId = (process.env.ZOHO_BOOKS_CLIENT_ID || '').trim();
  const clientSecret = (process.env.ZOHO_BOOKS_CLIENT_SECRET || '').trim();
  const organizationId = (process.env.ZOHO_BOOKS_ORGANIZATION_ID || '802911060').trim();
  let accessToken = (process.env.ZOHO_BOOKS_ACCESS_TOKEN || '').trim();
  let refreshToken = (process.env.ZOHO_BOOKS_REFRESH_TOKEN || '').trim();
  const accountsUrl = (process.env.ZOHO_BOOKS_ACCOUNTS_URL || 'https://accounts.zoho.com').trim().replace(/\/+$/, '');
  const apiBaseUrl = (process.env.ZOHO_BOOKS_BASE_URL || process.env.ZOHO_BOOKS_API_BASE_URL || 'https://www.zohoapis.com/books/v3').trim().replace(/\/+$/, '');

  // Check if an auth code was passed via argument e.g. node testZohoBooksConnection.js --code 1000.xxx
  let authCodeArg = null;
  const codeIdx = process.argv.indexOf('--code');
  if (codeIdx !== -1 && process.argv[codeIdx + 1]) {
    authCodeArg = process.argv[codeIdx + 1].trim();
  } else if (process.env.ZOHO_BOOKS_AUTHORIZATION_CODE) {
    authCodeArg = process.env.ZOHO_BOOKS_AUTHORIZATION_CODE.trim();
  }

  const allSecrets = [clientSecret, refreshToken, accessToken, authCodeArg].filter(Boolean);

  console.log('[1/4] Checking environment configuration:');
  console.log(`  • Accounts URL     : ${accountsUrl}`);
  console.log(`  • API Base URL     : ${apiBaseUrl}`);
  console.log(`  • Organization ID  : ${organizationId ? organizationId : '❌ (missing)'}`);
  console.log(`  • Client ID        : ${clientId ? mask(clientId) : '❌ (missing)'}`);
  console.log(`  • Client Secret    : ${clientSecret ? '✓ configured' : '❌ (missing)'}`);
  console.log(`  • Access Token     : ${accessToken ? mask(accessToken) : '(not set)'}`);
  console.log(`  • Refresh Token    : ${refreshToken ? mask(refreshToken) : '(not set)'}`);
  if (authCodeArg) {
    console.log(`  • Auth Code Arg    : ${mask(authCodeArg)}`);
  }
  console.log('');

  // Validate minimum required client credentials
  if (!clientId || !clientSecret) {
    console.log('❌ MISSING CREDENTIALS:');
    console.log('  Please ensure ZOHO_BOOKS_CLIENT_ID and ZOHO_BOOKS_CLIENT_SECRET are set in .env.');
    process.exit(1);
  }

  if (!organizationId) {
    console.log('❌ MISSING ORGANIZATION ID:');
    console.log('  Please ensure ZOHO_BOOKS_ORGANIZATION_ID is set in .env (e.g. 802911060).');
    process.exit(1);
  }

  const authService = createZohoBooksAuthService({
    clientId,
    clientSecret,
    refreshToken,
    accessToken,
    accountsUrl,
    envFilePath: envPath,
  });

  // Step 2: If an authorization code is available and no refresh token exists, attempt exchange
  const isAuthCodeInAccessToken = !refreshToken && accessToken && accessToken.startsWith('1000.') && accessToken.length >= 65;
  const codeToExchange = authCodeArg || (isAuthCodeInAccessToken ? accessToken : null);

  if (codeToExchange && !refreshToken) {
    console.log('[2/4] Authorization code detected without refresh token. Attempting code exchange...');
    try {
      const exchangeResult = await authService.exchangeAuthorizationCode({
        code: codeToExchange,
        overrideClientId: clientId,
        overrideClientSecret: clientSecret,
        overrideAccountsUrl: accountsUrl,
      });

      console.log('  ✓ Authorization code successfully exchanged for tokens!');
      accessToken = exchangeResult.accessToken;
      if (exchangeResult.refreshToken) {
        refreshToken = exchangeResult.refreshToken;
      }

      // Persist to .env
      const updates = {
        ZOHO_BOOKS_ACCESS_TOKEN: accessToken,
      };
      if (refreshToken) {
        updates.ZOHO_BOOKS_REFRESH_TOKEN = refreshToken;
      }
      authService.updateEnvFile(updates);
      console.log('  ✓ Updated .env with new access token and refresh token.');
    } catch (exchangeErr) {
      console.log(`  ⚠️ Authorization code exchange failed: ${exchangeErr.message}`);
      console.log(`     Provider error: ${exchangeErr.providerError || 'none'}`);
      console.log('     Note: Authorization codes expire in 2-10 minutes and can only be used once.');
    }
    console.log('');
  } else {
    console.log('[2/4] Skipping code exchange (not requested or refresh token already configured).\n');
  }

  // Step 3: Test connection with current access token
  console.log('[3/4] Testing Zoho Books API access:');
  console.log(`  GET ${apiBaseUrl}/organizations/${organizationId}`);

  let testResult = null;
  if (accessToken) {
    testResult = await callOrganizationEndpoint({
      baseUrl: apiBaseUrl,
      organizationId,
      accessToken,
      secrets: allSecrets,
    });
  } else {
    console.log('  • No access token currently available to test.');
  }

  // Check if token was expired / unauthorized
  const isUnauthorized = !testResult || !testResult.success || testResult.httpStatus === 401 || testResult.code === 57;

  if (isUnauthorized && refreshToken) {
    console.log('\n  ⚠️ Access token is expired or unauthorized.');
    console.log('[4/4] Attempting OAuth token refresh using ZOHO_BOOKS_REFRESH_TOKEN...');

    try {
      const refreshResult = await authService.refreshAccessToken({
        overrideClientId: clientId,
        overrideClientSecret: clientSecret,
        overrideRefreshToken: refreshToken,
        overrideAccountsUrl: accountsUrl,
      });

      console.log('  ✓ Token refresh successful! (New token obtained)');
      accessToken = refreshResult.accessToken;

      // Update .env
      authService.updateEnvFile({
        ZOHO_BOOKS_ACCESS_TOKEN: accessToken,
      });

      console.log('  ✓ Re-testing Zoho Books organization endpoint with refreshed token...');
      testResult = await callOrganizationEndpoint({
        baseUrl: apiBaseUrl,
        organizationId,
        accessToken,
        secrets: [clientSecret, refreshToken, accessToken],
      });
    } catch (refreshErr) {
      console.log(`  ❌ Token refresh failed: ${refreshErr.message}`);
      console.log(`     Provider error: ${refreshErr.providerError || 'none'}`);
    }
  } else if (isUnauthorized && !refreshToken) {
    console.log('\n[4/4] Token refresh cannot be attempted because ZOHO_BOOKS_REFRESH_TOKEN is not set.');
  } else {
    console.log('\n[4/4] Token refresh step skipped (initial API call succeeded).\n');
  }

  // Summary Report
  console.log('\n====================================================');
  console.log('                 TEST RESULT SUMMARY                ');
  console.log('====================================================');

  if (testResult) {
    console.log(`HTTP Status          : ${testResult.httpStatus}`);
    console.log(`Zoho Response Code   : ${testResult.code !== null ? testResult.code : 'N/A'}`);
    console.log(`Zoho Response Message: ${testResult.message}`);
    if (testResult.orgName) {
      console.log(`Organization Name    : ${testResult.orgName}`);
    }
    console.log(`Organization ${organizationId} Accessible: ${testResult.success ? 'YES ✓' : 'NO ❌'}`);

    if (testResult.httpStatus === 401 || testResult.code === 57) {
      console.log('\n⚠️ DIAGNOSIS & REMEDIATION FOR HTTP 401 (CODE 57):');
      console.log('  • Cause: "You are not authorized to perform this operation" (Code 57).');
      console.log('  • Possible reasons:');
      console.log('    1. Scope mismatch: When generating the code in Zoho API Console (Self Client),');
      console.log('       the scope MUST include "ZohoBooks.settings.READ" or "ZohoBooks.fullaccess.all".');
      console.log('    2. Organization ID mismatch: The authenticated Zoho user account does not have access');
      console.log('       to organization ID 802911060.');
      console.log('    3. Region / Data Center mismatch: If your Books organization is located in EU, IN, AU, etc.,');
      console.log('       both ZOHO_BOOKS_ACCOUNTS_URL and ZOHO_BOOKS_API_BASE_URL must match that region.');
      console.log('    4. Expired / invalid authorization code: The authorization code provided was either expired');
      console.log('       (older than 5-10 minutes) or already consumed, so no valid refresh token exists yet.');
      console.log('  • DO NOT repeatedly generate tokens without verifying the above 4 items in Zoho API Console.');
    }
  } else {
    console.log('No API request was executed because no valid token or credentials were present.');
  }
  console.log('====================================================\n');
}

run().catch((err) => {
  console.error('Fatal error in Zoho Books test script:', err.message);
  process.exit(1);
});
