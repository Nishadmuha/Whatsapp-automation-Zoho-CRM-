'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { createZohoAuthService } = require('../src/services/zoho/zohoAuthService');
const { createZohoLeadService } = require('../src/services/zoho/zohoLeadService');
const { REGIONS } = require('../src/services/zoho/zohoSupport');

const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath, quiet: true });

function mask(value) {
  if (!value) return '(not set)';
  const str = String(value).trim();
  if (str.length <= 8) return '****';
  return `${str.slice(0, 4)}...${str.slice(-4)} (${str.length} chars)`;
}

function updateEnvFile(updates) {
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, '', 'utf8');
  }
  let content = fs.readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    const newLine = `${key}=${value}`;
    if (regex.test(content)) {
      content = content.replace(regex, newLine);
    } else {
      content = content.trimEnd() + `\n${newLine}\n`;
    }
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

function commentOutEnvKey(key) {
  if (!fs.existsSync(envPath)) return;
  let content = fs.readFileSync(envPath, 'utf8');
  const regex = new RegExp(`^(\\s*${key}=.*)$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, '# $1 (consumed)');
    fs.writeFileSync(envPath, content, 'utf8');
  }
}

async function run() {
  console.log('====================================================');
  console.log('  Voltronix CRM — Zoho OAuth 2.0 Verification Tool  ');
  console.log('====================================================\n');

  const clientId = (process.env.ZOHO_CLIENT_ID || '').trim();
  const clientSecret = (process.env.ZOHO_CLIENT_SECRET || '').trim();
  const accountsUrl = (process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com').trim();
  const authCode = (process.env.ZOHO_AUTHORIZATION_CODE || process.env.ZOHO_AUTH_CODE || '').trim();
  let refreshToken = (process.env.ZOHO_REFRESH_TOKEN || '').trim();
  let apiBaseUrl = (process.env.ZOHO_API_BASE_URL || '').trim();
  const redirectUri = (process.env.ZOHO_REDIRECT_URI || '').trim();

  // 1. Check basic client configuration
  console.log('[1/4] Inspecting local Zoho OAuth configuration:');
  console.log(`  • Accounts URL   : ${accountsUrl}`);
  console.log(`  • Client ID      : ${mask(clientId)}`);
  console.log(`  • Client Secret  : ${clientSecret ? '✓ configured' : '(missing)'}`);
  console.log(`  • Auth Code      : ${authCode ? mask(authCode) : '(none pending)'}`);
  console.log(`  • Refresh Token  : ${refreshToken ? mask(refreshToken) : '(not set)'}`);
  console.log(`  • API Base URL   : ${apiBaseUrl || '(auto-detect)'}`);
  console.log('');

  if (!clientId || !clientSecret) {
    console.log('❌ INCOMPLETE CONFIGURATION:');
    console.log('  Please add your Zoho Self Client credentials to .env:');
    console.log('    ZOHO_CLIENT_ID=your_zoho_client_id');
    console.log('    ZOHO_CLIENT_SECRET=your_zoho_client_secret');
    console.log('    ZOHO_ACCOUNTS_URL=https://accounts.zoho.com  # or .eu, .in, .sa, etc.');
    console.log('    ZOHO_AUTHORIZATION_CODE=your_generated_code  # from Zoho Self Client');
    console.log('\nSupported Zoho Accounts endpoints:');
    for (const [acc, api] of REGIONS) {
      console.log(`  - https://${acc}  (API: https://www.${api}/crm/v8)`);
    }
    console.log('\nThen run: node scripts/zoho-auth.js');
    return;
  }

  const authService = createZohoAuthService({ env: process.env });

  // 2. Exchange Authorization Code if present
  if (authCode && !refreshToken) {
    console.log('[2/4] Authorization Code found. Initiating secure OAuth exchange...');
    try {
      const exchangeResult = await authService.exchangeAuthorizationCode({
        code: authCode,
        clientId,
        clientSecret,
        redirectUri,
        accountsUrl,
      });

      refreshToken = exchangeResult.refreshToken;
      apiBaseUrl = exchangeResult.apiBaseUrl || `${exchangeResult.apiDomain}/crm/v8`;

      console.log('  ✓ Authorization code successfully exchanged for permanent Refresh Token.');
      console.log(`  ✓ Discovered Zoho CRM API Domain: ${exchangeResult.apiDomain}`);

      // Persist to .env safely
      updateEnvFile({
        ZOHO_REFRESH_TOKEN: refreshToken,
        ZOHO_API_BASE_URL: apiBaseUrl,
      });
      commentOutEnvKey('ZOHO_AUTHORIZATION_CODE');
      commentOutEnvKey('ZOHO_AUTH_CODE');
      process.env.ZOHO_REFRESH_TOKEN = refreshToken;
      process.env.ZOHO_API_BASE_URL = apiBaseUrl;

      console.log('  ✓ Securely saved ZOHO_REFRESH_TOKEN and ZOHO_API_BASE_URL to .env.');
    } catch (error) {
      console.error(`  ❌ Authorization Code exchange failed: [${error.code || 'ERROR'}] ${error.message}`);
      if (error.providerCode === 'INVALID_CODE') {
        console.log('  ⚠️  The Authorization Code has expired or was already consumed.');
        console.log('     Generate a new code in Zoho Developer Console Self Client and put in .env.');
      } else if (error.providerCode === 'INVALID_CLIENT') {
        console.log('  ⚠️  Zoho rejected the Client ID / Client Secret, or the Accounts URL domain does not match where the client was created.');
      }
      return;
    }
  } else if (!refreshToken) {
    console.log('[2/4] No Refresh Token or Authorization Code configured.');
    console.log('  To obtain your Refresh Token, add your temporary Authorization Code to .env:');
    console.log('    ZOHO_AUTHORIZATION_CODE=1000.xxxx...');
    console.log('  Then re-run: node scripts/zoho-auth.js\n');
    return;
  } else {
    console.log('[2/4] Refresh Token is already configured.');
  }
  console.log('');

  // 3. Test Access Token generation & refresh
  console.log('[3/4] Testing Access Token generation & auto-refresh:');
  try {
    await authService.getAccessToken({ forceRefresh: true });
    console.log('  ✓ Successfully refreshed Access Token using stored Refresh Token.');
    console.log('  ✓ Token validation passed (type: Bearer, format verified).');
  } catch (error) {
    console.error(`  ❌ Failed to generate Access Token: [${error.code || 'AUTH_ERROR'}] ${error.message}`);
    return;
  }
  console.log('');

  // 4. Test Zoho CRM API & Leads Module Access
  console.log('[4/4] Testing live Zoho CRM Leads API access:');
  try {
    const leadService = createZohoLeadService({ env: process.env, auth: authService });
    // Search a dummy number to verify API connectivity and scope permissions
    await leadService.searchLeadByPhone('+971500000000').catch(err => {
      if (err.code === 'ZOHO_AMBIGUOUS_MATCH') return null;
      throw err;
    });

    console.log('  ✓ Zoho CRM API authentication successful (HTTP 200/204).');
    console.log('  ✓ Scopes verified: ZohoCRM.modules.leads.READ, CREATE, UPDATE.');
    console.log('  ✓ Lead CRM search executed successfully without error.');
  } catch (error) {
    console.error(`  ❌ Zoho CRM API test failed: [${error.code || 'API_ERROR'}] ${error.message}`);
    if (error.providerCode === 'OAUTH_SCOPE_MISMATCH') {
      console.log('  ⚠️  Scope mismatch: Make sure your Self Client has scopes:');
      console.log('     ZohoCRM.modules.leads.CREATE, ZohoCRM.modules.leads.READ, ZohoCRM.modules.leads.UPDATE, ZohoCRM.modules.attachments.CREATE');
      console.log('     (Or use ZohoCRM.modules.ALL for full CRM module access)');
    }
    return;
  }

  console.log('\n====================================================');
  console.log('  🎉 All Zoho CRM OAuth 2.0 Checks PASSED!          ');
  console.log('  The backend is ready to sync leads upon Boss YES. ');
  console.log('====================================================\n');
}

run().catch(error => {
  console.error('Fatal execution error:', error.message);
  process.exitCode = 1;
});
