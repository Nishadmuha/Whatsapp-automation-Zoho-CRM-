'use strict';
const { normalizeSenderPhone } = require('../utils/phone');

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Set ${key} before starting the backend.`);
  return value;
}

function integer(value, fallback, min, max, name) {
  const text = String(value || fallback);
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return Number(text);
}

function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  if (env.AUTOMATION_ENABLED && !['true', 'false'].includes(env.AUTOMATION_ENABLED)) {
    throw new Error('AUTOMATION_ENABLED must be true or false.');
  }
  const enabled = env.AUTOMATION_ENABLED === 'true';
  const aiProvider = (env.AI_PROVIDER || '').trim().toLowerCase();
  if (enabled && aiProvider && aiProvider !== 'openai') {
    throw new Error('Set AI_PROVIDER=openai for conversational replies, or leave it blank for fixed replies.');
  }
  const verifyToken = required(env, 'WEBHOOK_VERIFY_TOKEN');
  if (verifyToken === 'change_this_to_a_random_secret') throw new Error('Replace WEBHOOK_VERIFY_TOKEN with a random secret.');
  const appSecret = (env.META_APP_SECRET || env.WHATSAPP_APP_SECRET || '').trim();
  if ((production || enabled) && !appSecret) {
    throw new Error('Set META_APP_SECRET (legacy WHATSAPP_APP_SECRET) for production or automation.');
  }
  if (production && env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('TLS certificate validation cannot be disabled in production.');
  }
  const rawDbUrl = env.DATABASE_URL !== undefined ? env.DATABASE_URL : (env.MONGODB_URI !== undefined ? env.MONGODB_URI : 'file:./data/messages.sqlite');
  if (production && (rawDbUrl.startsWith('file:') || (env.DATABASE_URL && env.DATABASE_URL.startsWith('file:')))) {
    throw new Error('SQLite database files cannot be used in production.');
  }
  if (production && verifyToken.length < 32) throw new Error('WEBHOOK_VERIFY_TOKEN must have at least 32 characters in production.');
  const mongoUri = (env.MONGODB_URI || (env.DATABASE_URL && /^mongodb(?:\+srv)?:\/\//.test(env.DATABASE_URL) ? env.DATABASE_URL : '')).trim();
  if (production && !mongoUri && !env.DATABASE_URL) throw new Error('Set MONGODB_URI to a valid MongoDB connection string in production.');
  const databaseUrl = rawDbUrl;
  const databaseName = (env.MONGODB_DB_NAME || env.MONGO_DB_NAME || 'voltronix_crm').trim();
  const allowedSenders = (env.ALLOWED_SENDER_PHONES || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowedSenders.some((s) => !/^\+?[1-9]\d{6,14}$/.test(s))) {
    throw new Error('ALLOWED_SENDER_PHONES must be comma-separated international phone numbers.');
  }
  // An explicitly blank canonical setting revokes the legacy list as well.
  const bossKey = env.AUTHORIZED_BOSS_PHONES !== undefined ? 'AUTHORIZED_BOSS_PHONES' : 'BOSS_SENDER_PHONES';
  const bossValues = (env[bossKey] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const bossSenders = bossValues.map(normalizeSenderPhone);
  if (bossSenders.some((s) => !s) || (bossKey === 'BOSS_SENDER_PHONES'
      && bossValues.some((s) => !/^\+?[1-9]\d{6,14}$/.test(s)))) {
    throw new Error(`${bossKey} must contain comma-separated valid sender phone numbers.`);
  }
  const booksKey = env.AUTHORIZED_BOOKS_PHONES !== undefined ? 'AUTHORIZED_BOOKS_PHONES' : 'BOOKS_WORKER_PHONES';
  const booksValues = (env[booksKey] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const booksSenders = booksValues.map(normalizeSenderPhone);
  if (booksSenders.some((s) => !s) || (booksKey === 'BOOKS_WORKER_PHONES'
      && booksValues.some((s) => !/^\+?[1-9]\d{6,14}$/.test(s)))) {
    throw new Error(`${booksKey} must contain comma-separated valid sender phone numbers.`);
  }
  const adminUsername = (env.ADMIN_USERNAME || '').trim();
  const adminPassword = env.ADMIN_PASSWORD || '';
  const adminApiToken = env.ADMIN_API_TOKEN || '';
  if (adminApiToken && (typeof adminApiToken !== 'string' || adminApiToken.length < 32 || adminApiToken.length > 256 || /[^\x21-\x7e]/.test(adminApiToken))) {
    throw new Error('ADMIN_API_TOKEN must contain 32 to 256 visible ASCII characters without spaces.');
  }
  if (Boolean(adminUsername) !== Boolean(adminPassword)) {
    throw new Error('Set both ADMIN_USERNAME and ADMIN_PASSWORD to enable dashboard login.');
  }
  if (adminUsername && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(adminUsername)) {
    throw new Error('ADMIN_USERNAME must contain 1 to 64 letters, numbers, dots, underscores or hyphens.');
  }
  if (adminPassword && (!adminPassword.trim() || adminPassword.length < 8 || adminPassword.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(adminPassword))) {
    throw new Error('ADMIN_PASSWORD must contain 8 to 256 characters without control characters.');
  }
  const booksUsername = (env.BOOKS_USERNAME || '').trim();
  const booksPassword = env.BOOKS_PASSWORD || '';
  const adminBooksAccess = env.ADMIN_BOOKS_ACCESS !== 'false';
  if (Boolean(booksUsername) !== Boolean(booksPassword)) {
    throw new Error('Set both BOOKS_USERNAME and BOOKS_PASSWORD to enable Zoho Books login.');
  }
  if (booksUsername && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(booksUsername)) {
    throw new Error('BOOKS_USERNAME must contain 1 to 64 letters, numbers, dots, underscores or hyphens.');
  }
  if (booksPassword && (!booksPassword.trim() || booksPassword.length < 8 || booksPassword.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(booksPassword))) {
    throw new Error('BOOKS_PASSWORD must contain 8 to 256 characters without control characters.');
  }
  const phoneNumberId = (env.WHATSAPP_PHONE_NUMBER_ID || env.PHONE_NUMBER_ID || '').trim();
  if (phoneNumberId && !/^\d+$/.test(phoneNumberId)) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID must be numeric when configured.');
  }
  const graphVersion = (env.META_GRAPH_API_VERSION || env.WHATSAPP_API_VERSION || '').trim();
  if (enabled) {
    const { readWhatsAppSendConfig } = require('../services/whatsapp/whatsappService');
    readWhatsAppSendConfig(env);
  }
  return {
    production, enabled, aiProvider, verifyToken, appSecret, mongoUri, databaseUrl, databaseName, phoneNumberId, graphVersion, adminUsername, adminPassword, adminApiToken,
    booksUsername, booksPassword, adminBooksAccess,
    allowedSenders: new Set(allowedSenders.map((s) => `+${s.replace(/^\+/, '')}`)),
    bossSenders: new Set(bossSenders),
    bossReplyQuietMs: integer(env.BOSS_REPLY_QUIET_MS, 5000, 1, 60000, 'BOSS_REPLY_QUIET_MS'),
    messageBatchQuietMs: integer(env.MESSAGE_BATCH_QUIET_MS, env.BOSS_REPLY_QUIET_MS || 5000, 100, 60000, 'MESSAGE_BATCH_QUIET_MS'),
    booksSenders: new Set(booksSenders),
    port: integer(env.PORT, 5000, 1, 65535, 'PORT'),
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    pollMs: integer(env.WORKER_POLL_MS, 1000, 50, 60000, 'WORKER_POLL_MS'),
    leaseMs: integer(env.WORKER_LEASE_MS, 120000, 30000, 600000, 'WORKER_LEASE_MS'),
    maxAttempts: integer(env.PROCESSING_MAX_ATTEMPTS, 3, 1, 10, 'PROCESSING_MAX_ATTEMPTS'),
    rateLimit: integer(env.WEBHOOK_RATE_LIMIT, 600, 1, 100000, 'WEBHOOK_RATE_LIMIT'),
    trustProxy: integer(env.TRUST_PROXY_HOPS, '0', 0, 3, 'TRUST_PROXY_HOPS'),
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

module.exports = { readConfig };
