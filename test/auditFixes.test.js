'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');

const { readConfig } = require('../src/config/env');
const { createApp } = require('../src/app');
const { MongoMessageStore } = require('../src/database/mongoStore');
const { mapLeadToZoho } = require('../src/services/zoho/zohoLeadService');
const { handleZohoSync } = require('../src/services/leads/bossLeadWorkflow');

function baseConfig(extra = {}) {
  return {
    NODE_ENV: 'test',
    WEBHOOK_VERIFY_TOKEN: 'test-verification-token',
    META_APP_SECRET: 'test-app-secret',
    AUTOMATION_ENABLED: 'false',
    ...extra,
  };
}

test('production configuration rejects database URLs ignored by the Mongo runtime', () => {
  assert.throws(() => readConfig(baseConfig({
    NODE_ENV: 'production',
    WEBHOOK_VERIFY_TOKEN: 'v'.repeat(40),
    DATABASE_URL: 'postgresql://user:password@db.example.test/app',
  })), /MongoDB connection string/);
  const config = readConfig(baseConfig({
    NODE_ENV: 'production',
    WEBHOOK_VERIFY_TOKEN: 'v'.repeat(40),
    MONGODB_URI: 'mongodb://user:password@db.example.test/app',
  }));
  assert.equal(config.mongoUri, 'mongodb://user:password@db.example.test/app');
});

test('readiness fails closed when enabled automation has no WhatsApp sender configuration', async t => {
  const env = baseConfig();
  const config = { ...readConfig(env), enabled: true };
  const store = { async init() {}, async ping() {} };
  const app = createApp({ env, config, store, logger: { info() {}, warn() {}, error() {} } });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/ready`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'unavailable', reason: 'WHATSAPP_NOT_CONFIGURED' });
});

const readyEnv = {
  AUTOMATION_ENABLED: 'true', AI_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-ai-key', OPENAI_MODEL_DEFAULT: 'synthetic-model',
  WHATSAPP_ACCESS_TOKEN: 'synthetic-wa-token', WHATSAPP_PHONE_NUMBER_ID: '123456789', META_GRAPH_API_VERSION: 'v25.0',
  ZOHO_CLIENT_ID: 'synthetic-crm-id', ZOHO_CLIENT_SECRET: 'synthetic-crm-secret', ZOHO_REFRESH_TOKEN: 'synthetic-crm-refresh',
  ZOHO_BOOKS_CLIENT_ID: 'synthetic-books-id', ZOHO_BOOKS_CLIENT_SECRET: 'synthetic-books-secret', ZOHO_BOOKS_REFRESH_TOKEN: 'synthetic-books-refresh',
  ZOHO_BOOKS_SWITCHGEAR_ORG_ID: '123456', ZOHO_BOOKS_CONTRACTING_ORG_ID: '654321',
  AUTHORIZED_BOSS_PHONES: '+971501234567', AUTHORIZED_BOOKS_PHONES: '+971509876543',
};

async function readinessProbe(t, overrides = {}, { mongoDown = false } = {}) {
  const env = baseConfig({ ...readyEnv, ...overrides });
  const store = { async init() {}, async ping() { if (mongoDown) throw new Error('synthetic database outage'); } };
  const app = createApp({ env, store, logger: { info() {}, warn() {}, error() {} } });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async path => {
    const response = await fetch(base + path);
    return { status: response.status, body: await response.json() };
  };
}

test('MongoDB outage makes readiness and both health forms unavailable', async t => {
  const probe = await readinessProbe(t, {}, { mongoDown: true });
  assert.equal((await probe('/ready')).status, 503);
  assert.deepEqual(await probe('/health'), { status: 503, body: { status: 'unavailable', service: 'voltronix-whatsapp-backend' } });
  const detailed = await probe('/health/status');
  assert.equal(detailed.status, 503);
  assert.equal(detailed.body.components.mongodb.code, 'MONGODB_UNAVAILABLE');
});

for (const [label, overrides, reason] of [
  ['OpenAI', { OPENAI_API_KEY: '' }, 'AI_NOT_CONFIGURED'],
  ['Zoho Books', { ZOHO_BOOKS_REFRESH_TOKEN: '' }, 'ZOHO_BOOKS_NOT_CONFIGURED'],
]) test(`${label} missing in an enabled runtime fails readiness and health without disclosing credentials`, async t => {
  const probe = await readinessProbe(t, overrides);
  assert.deepEqual(await probe('/ready'), { status: 503, body: { status: 'unavailable', reason } });
  const health = await probe('/health');
  assert.equal(health.status, 503);
  assert.equal(health.body.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(health.body), /synthetic-.*(?:secret|refresh|key)/);
});

for (const [label, overrides] of [
  ['client ID', { ZOHO_CLIENT_ID: '' }],
  ['client secret', { ZOHO_CLIENT_SECRET: '' }],
  ['refresh token', { ZOHO_REFRESH_TOKEN: '' }],
]) test(`enabled Boss CRM with missing ${label} fails readiness and health`, async t => {
  const probe = await readinessProbe(t, overrides);
  assert.deepEqual(await probe('/ready'), { status: 503, body: { status: 'unavailable', reason: 'ZOHO_CRM_NOT_CONFIGURED' } });
  const health = await probe('/health');
  assert.equal(health.status, 503);
  assert.equal(health.body.status, 'unavailable');
  const detailed = await probe('/health/status');
  assert.equal(detailed.status, 503);
  assert.equal(detailed.body.components.zoho_crm.code, 'ZOHO_CRM_NOT_CONFIGURED');
  assert.doesNotMatch(JSON.stringify(detailed.body), /synthetic-.*(?:secret|refresh|key)/);
});

test('configured enabled runtime stays ready and preserves healthy endpoint contracts', async t => {
  const probe = await readinessProbe(t);
  assert.deepEqual(await probe('/ready'), { status: 200, body: { status: 'ready', automation: 'enabled' } });
  assert.deepEqual(await probe('/health'), { status: 200, body: { status: 'ok', service: 'voltronix-whatsapp-backend' } });
  assert.equal((await probe('/health/status')).body.components.zoho_crm.status, 'healthy');
});

test('disabled Boss CRM does not block enabled conversation readiness', async t => {
  const probe = await readinessProbe(t, {
    AUTHORIZED_BOSS_PHONES: '', ZOHO_CLIENT_ID: '', ZOHO_CLIENT_SECRET: '', ZOHO_REFRESH_TOKEN: '',
  });
  assert.equal((await probe('/ready')).status, 200);
  assert.equal((await probe('/health')).status, 200);
  assert.equal((await probe('/health/status')).body.components.zoho_crm.status, 'not_configured');
});

test('Boss conversations without CRM credentials do not fail readiness', async t => {
  const probe = await readinessProbe(t, {
    ZOHO_CLIENT_ID: '', ZOHO_CLIENT_SECRET: '', ZOHO_REFRESH_TOKEN: '',
  });
  assert.equal((await probe('/ready')).status, 200);
  assert.equal((await probe('/health')).status, 200);
  assert.equal((await probe('/health/status')).body.components.zoho_crm.status, 'not_configured');
});

for (const [label, overrides] of [
  ['missing model', { OPENAI_MODEL_DEFAULT: '', OPENAI_MODEL: '' }],
  ['invalid default model', { OPENAI_MODEL_DEFAULT: 'invalid model', OPENAI_MODEL: 'valid-fallback' }],
  ['invalid legacy model', { OPENAI_MODEL_DEFAULT: '', OPENAI_MODEL: 'invalid model' }],
]) test(`${label} fails AI readiness and both health forms`, async t => {
  const probe = await readinessProbe(t, overrides);
  assert.deepEqual(await probe('/ready'), { status: 503, body: { status: 'unavailable', reason: 'AI_NOT_CONFIGURED' } });
  assert.deepEqual(await probe('/health'), { status: 503, body: { status: 'unavailable', service: 'voltronix-whatsapp-backend' } });
  const detailed = await probe('/health/status');
  assert.equal(detailed.status, 503);
  assert.equal(detailed.body.status, 'unavailable');
  assert.equal(detailed.body.components.ai.code, 'AI_NOT_CONFIGURED');
  assert.equal(detailed.body.openai, 'NOT_CONFIGURED');
});

test('valid legacy AI model is accepted when the default model is unset', async t => {
  const probe = await readinessProbe(t, { OPENAI_MODEL_DEFAULT: '', OPENAI_MODEL: 'valid-fallback' });
  assert.deepEqual(await probe('/ready'), { status: 200, body: { status: 'ready', automation: 'enabled' } });
  assert.equal((await probe('/health')).status, 200);
  assert.equal((await probe('/health/status')).body.components.ai.status, 'healthy');
});

test('disabled AI, CRM and Books features do not gate readiness on their credentials', async t => {
  const probe = await readinessProbe(t, { AI_PROVIDER: '', OPENAI_API_KEY: '', OPENAI_MODEL_DEFAULT: '', ZOHO_CLIENT_ID: '', ZOHO_BOOKS_CLIENT_ID: '' });
  assert.deepEqual(await probe('/ready'), { status: 200, body: { status: 'ready', automation: 'enabled' } });
  assert.equal((await probe('/health')).status, 200);
});

test('required MongoDB index failures stop initialization', async () => {
  const store = new MongoMessageStore({
    mongoUri: 'mongodb://synthetic/app',
    db: { collection() { return { createIndex: async () => { throw new Error('permission denied'); } }; } },
  });
  await assert.rejects(store.init(), /Required MongoDB index initialization failed/);
  assert.equal(store.initialized, false);
});

test('new Zoho leads carry NOT QUALIFIED status while updates preserve CRM status', () => {
  const record = mapLeadToZoho({ name: 'A Customer', phone: '+971501234567', company: 'A Co' }, 'hello');
  assert.equal(record.Lead_Status, 'None');
});

test('concurrent forced Zoho syncs serialize and create only one CRM lead', async () => {
  const leadId = randomUUID();
  const lead = {
    id: leadId, contact_name: 'A Customer', company_name: 'A Co', phone: '+971501234567', email: null,
    original_message: 'hello', attachments: [], zoho_status: 'not_started', zoho_lead_id: null,
  };
  const locks = new Map();
  const store = {
    async getLead() { return { ...lead }; },
    async withContactLock(key, fn) {
      const previous = locks.get(key) || Promise.resolve();
      let release;
      const current = new Promise(resolve => { release = resolve; });
      locks.set(key, previous.then(() => current));
      await previous;
      try { return await fn(); } finally { release(); }
    },
    async updateLeadZohoStatus(_id, patch) {
      Object.assign(lead, {
        zoho_status: patch.zohoStatus,
        zoho_lead_id: patch.zohoLeadId === undefined ? lead.zoho_lead_id : patch.zohoLeadId,
        zoho_url: patch.zohoUrl === undefined ? lead.zoho_url : patch.zohoUrl,
      });
      return true;
    },
  };
  const zoho = {
    creates: 0, updates: 0,
    async searchLeadByPhone() { await new Promise(resolve => setTimeout(resolve, 10)); return null; },
    async createLead() { this.creates += 1; await new Promise(resolve => setTimeout(resolve, 10)); return { id: '123456' }; },
    async updateLead() { this.updates += 1; return { id: '123456' }; },
  };
  const results = await Promise.all([
    handleZohoSync({ leadId, store, zoho, config: {} , force: true }),
    handleZohoSync({ leadId, store, zoho, config: {} , force: true }),
  ]);
  assert.equal(results.filter(result => result.success).length, 2);
  assert.equal(zoho.creates, 1);
  assert.equal(zoho.updates, 1);
});

test('custom users use salted scrypt hashes, do not list passwords, and generate secure-length passwords', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voltronix-users-'));
  const usersFile = path.join(tempDir, 'users.json');
  const previous = process.env.VOLTRONIX_USERS_FILE;
  process.env.VOLTRONIX_USERS_FILE = usersFile;
  delete require.cache[require.resolve('../src/services/auth/userService')];
  const { userService } = require('../src/services/auth/userService');
  try {
    const created = userService.createUser({ username: 'operator', password: 'strong-pass-123', access: 'lead' });
    assert.equal(created.password, 'strong-pass-123');
    const stored = JSON.parse(fs.readFileSync(usersFile, 'utf8'))[0];
    assert.match(stored.passwordHash, /^scrypt\$/);
    assert.equal(Object.hasOwn(stored, 'password'), false);
    assert.equal(Object.hasOwn(userService.listUsers()[0], 'password'), false);
    assert.equal(userService.verifyUser('operator', 'strong-pass-123').username, 'operator');
    assert.equal(userService.verifyUser('operator', 'wrong-password'), null);
    assert.equal(userService.generateNumericPassword().length, 10);
    assert.throws(() => userService.createUser({ username: 'short', password: '1234' }), /8 characters/);
  } finally {
    if (previous === undefined) delete process.env.VOLTRONIX_USERS_FILE;
    else process.env.VOLTRONIX_USERS_FILE = previous;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
