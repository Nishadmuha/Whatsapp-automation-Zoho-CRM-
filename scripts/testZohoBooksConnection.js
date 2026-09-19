'use strict';

const path = require('node:path');
const { createZohoBooksAuthService } = require('../src/services/books/zohoBooksAuthService');
const { BOOKS_SCOPES } = require('../src/services/zoho/oauthScopes');
const { printVerification } = require('./verify-zoho-scopes');

const envPath = path.resolve(__dirname, '..', '.env');

async function run() {
  // Verification uses the actual Contacts integration, not an unrelated
  // organization/settings permission probe. It never rewrites .env.
  if (!process.argv.includes('--exchange')) return printVerification(['books']);
  const code = process.env.ZOHO_BOOKS_AUTHORIZATION_CODE;
  if (!code) {
    console.error('Set ZOHO_BOOKS_AUTHORIZATION_CODE privately, then run npm run zoho:books:test -- --exchange.');
    console.error('Generate a Self Client code with: ' + BOOKS_SCOPES.join(','));
    process.exitCode = 1;
    return;
  }
  const auth = createZohoBooksAuthService({ envFilePath: envPath });
  const result = await auth.exchangeAuthorizationCode({ code });
  if (!result.refreshToken) throw Error('Zoho did not return an offline refresh token.');
  if (!auth.updateEnvFile({ ZOHO_BOOKS_REFRESH_TOKEN: result.refreshToken, ZOHO_BOOKS_AUTHORIZATION_CODE: '' })) {
    throw Error('Private .env file is missing.');
  }
  console.log('OAuth code exchanged and refresh token saved privately. No Books records were written.');
  return printVerification(['books']);
}

if (require.main === module) {
  require('dotenv').config({ path: envPath, quiet: true });
  run().catch(() => {
    console.error('Zoho Books OAuth verification/exchange failed. Check the code expiry, client, data center, organization and granted scopes.');
    process.exitCode = 1;
  });
}

module.exports = { run };
