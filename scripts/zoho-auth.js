'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createZohoAuthService } = require('../src/services/zoho/zohoAuthService');
const { CRM_SCOPES } = require('../src/services/zoho/oauthScopes');
const { printVerification } = require('./verify-zoho-scopes');

const envPath = path.resolve(__dirname, '..', '.env');

function updateEnvFile(updates) {
  // Explicit --exchange only. Never print the code, access token or refresh token.
  let content = fs.readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp('^#?\\s*' + key + '=.*$', 'm');
    const newLine = key + '=' + value;
    content = regex.test(content) ? content.replace(regex, () => newLine) : content.trimEnd() + '\n' + newLine + '\n';
    process.env[key] = value;
  }
  content = content.replace(/^\s*ZOHO_AUTH(?:ORIZATION)?_CODE=.*$/gm, '# Authorization code consumed.');
  fs.writeFileSync(envPath, content, 'utf8');
}

async function run() {
  if (!process.argv.includes('--exchange')) return printVerification(['crm']);
  const code = process.env.ZOHO_AUTHORIZATION_CODE || process.env.ZOHO_AUTH_CODE;
  if (!code) {
    console.error('Set ZOHO_AUTHORIZATION_CODE privately, then run npm run zoho:auth -- --exchange.');
    console.error('Generate a Self Client code with: ' + CRM_SCOPES.join(','));
    process.exitCode = 1;
    return;
  }
  const auth = createZohoAuthService();
  const result = await auth.exchangeAuthorizationCode({ code });
  updateEnvFile({ ZOHO_REFRESH_TOKEN: result.refreshToken, ...(result.apiBaseUrl ? { ZOHO_API_BASE_URL: result.apiBaseUrl } : {}) });
  console.log('OAuth code exchanged and refresh token saved privately. No CRM records were written.');
  return printVerification(['crm']);
}

if (require.main === module) {
  require('dotenv').config({ path: envPath, quiet: true });
  run().catch(() => {
    console.error('Zoho OAuth verification/exchange failed. Check the code expiry, client, data center and granted scopes.');
    process.exitCode = 1;
  });
}

module.exports = { run };
