'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { temporaryStore } = require('./helpers');

const run = promisify(execFile);
const serverPath = path.resolve(__dirname, '../src/server.js');

function isolatedEnv(databaseUrl, overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test', HOST: '127.0.0.1', AUTOMATION_ENABLED: 'false',
    NODE_TLS_REJECT_UNAUTHORIZED: '1', DATABASE_URL: databaseUrl, MONGODB_URI: '',
    PORT: '5000', WEBHOOK_VERIFY_TOKEN: randomBytes(32).toString('hex'),
    WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', WHATSAPP_APP_SECRET: '',
    META_APP_SECRET: '', ALLOWED_SENDER_PHONES: '', BOSS_SENDER_PHONES: '', AUTHORIZED_BOSS_PHONES: '', ADMIN_USERNAME: '', ADMIN_PASSWORD: '', LOG_LEVEL: 'info',
    META_GRAPH_API_VERSION: '', WHATSAPP_API_VERSION: '', AI_PROVIDER: '',
    OPENAI_API_KEY: '', OPENAI_MODEL: '', GEMINI_API_KEY: '', GEMINI_MODEL: '',
    ZOHO_CLIENT_ID: '', ZOHO_CLIENT_SECRET: '', ZOHO_REFRESH_TOKEN: '', ZOHO_ACCOUNTS_URL: '', ZOHO_API_BASE_URL: '',
    ...overrides,
  };
}

test('an occupied port fails startup without announcing a running server', async (t) => {
  const { databaseUrl } = await temporaryStore(t);
  const occupied = net.createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    occupied.close((error) => (error ? reject(error) : resolve()));
  }));
  const port = occupied.address().port;

  await assert.rejects(run(process.execPath, [serverPath], {
    env: isolatedEnv(databaseUrl, { PORT: String(port) }),
    timeout: 10_000,
  }), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.killed, false);
    assert.match(error.stderr, new RegExp(`Port ${port} is already in use`));
    assert.doesNotMatch(error.stdout, /Server running on:|Voltronix WhatsApp Backend|Local test mode:/);
    return true;
  });
});

test('missing verification token or production signature secret fails startup without exposing values', async (t) => {
  const { databaseUrl } = await temporaryStore(t);
  const privateSentinel = randomBytes(32).toString('hex');
  for (const configuration of [
    { WEBHOOK_VERIFY_TOKEN: '', META_APP_SECRET: privateSentinel, expected: /WEBHOOK_VERIFY_TOKEN/ },
    { NODE_ENV: 'production', WEBHOOK_VERIFY_TOKEN: privateSentinel, META_APP_SECRET: '', expected: /META_APP_SECRET/ },
  ]) {
    const { expected, ...overrides } = configuration;
    await assert.rejects(run(process.execPath, [serverPath], {
      env: isolatedEnv(databaseUrl, overrides), timeout: 10_000,
    }), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.killed, false);
      assert.match(error.stderr, expected);
      assert.equal((error.stdout + error.stderr).includes(privateSentinel), false);
      assert.doesNotMatch(error.stdout, /server_listening/);
      return true;
    });
  }
});

test('webhook-only server starts and receives messages without initializing external automation services', async (t) => {
  const { store, databaseUrl } = await temporaryStore(t);
  const sourceDirectory = path.resolve(__dirname, '../src');
  const script = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const path = require('node:path');
    const net = require('node:net');
    const { once } = require('node:events');
    const root = process.argv[1];
    const blockedFactories = new Map([
      ['services/ai/aiService.js', 'createAiService'],
      ['services/zoho/zohoLeadService.js', 'createZohoLeadService'],
      ['services/whatsapp/whatsappService.js', 'createWhatsAppService'],
      ['services/leads/leadProcessor.js', 'createLeadProcessor'],
    ].map(([file, name]) => [path.join(root, file), name]));
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      const factory = blockedFactories.get(Module._resolveFilename(request, parent, isMain));
      if (factory) return { [factory]() { throw new Error('Unexpected external automation initialization'); } };
      return originalLoad.apply(this, arguments);
    };
    (async () => {
      const reserved = net.createServer();
      reserved.listen(0, '127.0.0.1');
      await once(reserved, 'listening');
      process.env.PORT = String(reserved.address().port);
      await new Promise((resolve, reject) => reserved.close((error) => error ? reject(error) : resolve()));
      const { startServer } = require(path.join(root, 'server.js'));
      const server = await startServer();
      try {
        if (!server.listening) await once(server, 'listening');
        const base = 'http://127.0.0.1:' + server.address().port;
        assert.deepEqual(await (await fetch(base + '/health')).json(), { status: 'ok', service: 'voltronix-whatsapp-backend' });
        const query = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': process.env.WEBHOOK_VERIFY_TOKEN, 'hub.challenge': 'local-startup-challenge' });
        const verified = await fetch(base + '/webhook?' + query);
        assert.equal(verified.status, 200);
        assert.equal(await verified.text(), 'local-startup-challenge');
        const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
          messaging_product: 'whatsapp', messages: [{ id: 'wamid.webhook-only-startup', from: '971551234567', type: 'text',
            text: { body: 'A local startup test message' }, timestamp: String(Math.floor(Date.now() / 1000)) }],
        } }] }] };
        const received = await fetch(base + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(received.status, 200);
      } finally {
        server.closeAllConnections();
        await server.shutdown();
      }
    })().catch((error) => { console.error(error.message); process.exitCode = 1; });
  `;
  const result = await run(process.execPath, ['-e', script, sourceDirectory], {
    env: isolatedEnv(databaseUrl), timeout: 15_000,
  });
  assert.match(result.stdout, /server_listening/);
  assert.match(result.stdout, /WhatsApp message received/);
  assert.doesNotMatch(result.stdout + result.stderr, /Unexpected external automation initialization/);
  const message = await store.getMessage('wamid.webhook-only-startup');
  assert.equal(message.processing_status, 'RECEIVED');
  assert.equal(message.attempts, 0);
  assert.equal(await store.getReply('wamid.webhook-only-startup'), null);
});

test('enabled startup sends one fixed reply through the outbox without loading AI or Zoho', async (t) => {
  const { store, databaseUrl } = await temporaryStore(t);
  const sourceDirectory = path.resolve(__dirname, '../src');
  await store.enqueueMany([{
    whatsapp_message_id: 'wamid.before-fixed-startup', sender_phone: '+971551234567', message_type: 'text',
    message_text: 'Previously received message', received_at: new Date().toISOString(), authenticated: true,
  }]);
  const script = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const path = require('node:path');
    const net = require('node:net');
    const { once } = require('node:events');
    const { createHmac } = require('node:crypto');
    const root = process.argv[1];
    const forbiddenDirectories = ['ai', 'zoho'].map((name) => path.join(root, 'services', name) + path.sep);
    const forbiddenProcessor = path.join(root, 'services/leads/leadProcessor.js');
    const whatsappModule = path.join(root, 'services/whatsapp/whatsappService.js');
    let forbiddenLoads = 0;
    let whatsappFactories = 0;
    const sendCalls = [];
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      const filename = Module._resolveFilename(request, parent, isMain);
      if (filename === forbiddenProcessor || forbiddenDirectories.some((directory) => filename.startsWith(directory))) {
        forbiddenLoads++;
        throw new Error('Unexpected deferred AI or CRM module load');
      }
      const loaded = originalLoad.apply(this, arguments);
      if (filename !== whatsappModule) return loaded;
      return { ...loaded, createWhatsAppService() {
        whatsappFactories++;
        return { async sendTextMessage(to, text) {
          sendCalls.push({ to, text });
          return { messages: [{ id: 'wamid.fixed-startup-reply' }] };
        } };
      } };
    };
    (async () => {
      const { AUTO_REPLY_TEXT } = require(path.join(root, 'services/whatsapp/autoReply.js'));
      const expectedText = 'Thanks for contacting Voltronix Contracting LLC. How can we help you?';
      assert.equal(AUTO_REPLY_TEXT, expectedText);
      const reserved = net.createServer();
      reserved.listen(0, '127.0.0.1');
      await once(reserved, 'listening');
      process.env.PORT = String(reserved.address().port);
      await new Promise((resolve, reject) => reserved.close((error) => error ? reject(error) : resolve()));
      const { startServer } = require(path.join(root, 'server.js'));
      const server = await startServer();
      try {
        if (!server.listening) await once(server, 'listening');
        const base = 'http://127.0.0.1:' + server.address().port;
        assert.deepEqual(await (await fetch(base + '/ready')).json(), { status: 'ready', automation: 'enabled' });
        const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
          messaging_product: 'whatsapp', metadata: { phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID },
          messages: [{ id: 'wamid.fixed-reply-startup', from: '971551234567', type: 'text',
            text: { body: 'A signed customer test message' }, timestamp: String(Math.floor(Date.now() / 1000)) }],
        } }] }] });
        const signature = 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
        const post = () => fetch(base + '/webhook', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature }, body });
        const responses = await Promise.all([post(), post(), post()]);
        for (const response of responses) assert.equal(response.status, 200);
        const deadline = Date.now() + 5000;
        while (sendCalls.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(sendCalls, [{ to: '+971551234567', text: expectedText }]);
        assert.equal(whatsappFactories, 1);
        assert.equal(forbiddenLoads, 0);
      } finally {
        server.closeAllConnections();
        await server.shutdown();
      }
      assert.deepEqual(sendCalls, [{ to: '+971551234567', text: expectedText }]);
      assert.equal(forbiddenLoads, 0);
    })().catch((error) => { console.error(error.message); process.exitCode = 1; });
  `;
  const result = await run(process.execPath, ['-e', script, sourceDirectory], {
    env: isolatedEnv(databaseUrl, {
      AUTOMATION_ENABLED: 'true', WORKER_POLL_MS: '50', META_APP_SECRET: randomBytes(32).toString('hex'),
      WHATSAPP_ACCESS_TOKEN: 'mock-startup-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890', META_GRAPH_API_VERSION: 'v25.0',
    }),
    timeout: 15_000,
  });
  assert.match(result.stdout, /server_listening/);
  assert.doesNotMatch(result.stdout + result.stderr, /Unexpected deferred AI or CRM module load/);
  const stored = await store.getMessage('wamid.fixed-reply-startup');
  assert.equal(stored.authenticated, true);
  assert.equal(stored.processing_status, 'SUCCESS');
  assert.equal(stored.attempts, 0);
  const reply = await store.getReply('wamid.fixed-reply-startup');
  assert.equal(reply.status, 'SENT');
  assert.equal(reply.provider_message_id, 'wamid.fixed-startup-reply');
  const previous = await store.getMessage('wamid.before-fixed-startup');
  assert.equal(previous.processing_status, 'RECEIVED');
  assert.equal(previous.attempts, 0);
  assert.equal(await store.getReply('wamid.before-fixed-startup'), null);
});

for (const authenticationFailure of [false, true]) {
  test(authenticationFailure
    ? 'enabled conversation startup contains an AI authentication failure without sending or breaking the webhook'
    : 'enabled conversation startup generates and sends one AI reply without claiming old receipts or loading CRM', async (t) => {
    const { store, databaseUrl } = await temporaryStore(t);
    const sourceDirectory = path.resolve(__dirname, '../src');
    await store.enqueueMany([{
      whatsapp_message_id: 'wamid.before-conversation-startup', sender_phone: '+971551234567', message_type: 'text',
      message_text: 'Previously received message without a conversation flow', received_at: new Date().toISOString(), authenticated: true,
    }]);
    const script = `
      const assert = require('node:assert/strict');
      const Module = require('node:module');
      const path = require('node:path');
      const net = require('node:net');
      const { once } = require('node:events');
      const { createHmac } = require('node:crypto');
      const root = process.argv[1];
      const authenticationFailure = ${JSON.stringify(authenticationFailure)};
      const expectedInput = 'Can Voltronix help maintain an office air conditioner?';
      const expectedReply = 'Yes, Voltronix can help with office AC maintenance. What issue are you experiencing?';
      const forbiddenDirectories = ['leads', 'zoho'].map((name) => path.join(root, 'services', name) + path.sep);
      const aiModule = path.join(root, 'services/ai/aiService.js');
      const whatsappModule = path.join(root, 'services/whatsapp/whatsappService.js');
      let forbiddenLoads = 0;
      let aiFactories = 0;
      let whatsappFactories = 0;
      const generationCalls = [];
      const sendCalls = [];
      const originalLoad = Module._load;
      Module._load = function (request, parent, isMain) {
        const filename = Module._resolveFilename(request, parent, isMain);
        if (forbiddenDirectories.some((directory) => filename.startsWith(directory))) {
          forbiddenLoads++;
          throw new Error('Unexpected lead or CRM module load in conversation startup');
        }
        const loaded = originalLoad.apply(this, arguments);
        if (filename === aiModule) return { ...loaded, createAiService() {
          aiFactories++;
          return { async generateReply(text) {
            generationCalls.push(text);
            assert.equal(text, expectedInput);
            if (authenticationFailure) throw Object.assign(new Error('synthetic-private-auth-message'), {
              code: 'AI_AUTHENTICATION_ERROR', retryable: false,
            });
            return expectedReply;
          } };
        } };
        if (filename === whatsappModule) return { ...loaded, createWhatsAppService() {
          whatsappFactories++;
          return { async sendTextMessage(to, text) {
            sendCalls.push({ to, text });
            assert.equal(text, expectedReply);
            return { messages: [{ id: 'wamid.conversation-startup-reply' }] };
          } };
        } };
        return loaded;
      };
      (async () => {
        const reserved = net.createServer();
        reserved.listen(0, '127.0.0.1');
        await once(reserved, 'listening');
        process.env.PORT = String(reserved.address().port);
        await new Promise((resolve, reject) => reserved.close((error) => error ? reject(error) : resolve()));
        const { startServer } = require(path.join(root, 'server.js'));
        const { createMessageStore } = require(path.join(root, 'database'));
        const server = await startServer();
        const inspection = createMessageStore({ databaseUrl: process.env.DATABASE_URL });
        try {
          await inspection.init();
          if (!server.listening) await once(server, 'listening');
          const base = 'http://127.0.0.1:' + server.address().port;
          assert.deepEqual(await (await fetch(base + '/ready')).json(), { status: 'ready', automation: 'enabled' });
          const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
            messaging_product: 'whatsapp', metadata: { phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID },
            messages: [{ id: 'wamid.conversation-startup', from: '971551234567', type: 'text',
              text: { body: expectedInput }, timestamp: String(Math.floor(Date.now() / 1000)) }],
          } }] }] });
          const signature = 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
          const post = () => fetch(base + '/webhook', { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature }, body });
          const responses = await Promise.all([post(), post(), post()]);
          for (const response of responses) assert.equal(response.status, 200);
          const deadline = Date.now() + 5000;
          let completed = false;
          while (Date.now() < deadline) {
            const message = await inspection.getMessage('wamid.conversation-startup');
            const reply = await inspection.getReply('wamid.conversation-startup');
            completed = authenticationFailure ? message?.processing_status === 'FAILED' : reply?.status === 'SENT';
            if (completed) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.equal(completed, true, 'The conversation worker must persist the expected outcome.');
          assert.equal((await post()).status, 200);
          assert.equal((await fetch(base + '/health')).status, 200);
          assert.deepEqual(await (await fetch(base + '/ready')).json(), { status: 'ready', automation: 'enabled' });
          await new Promise((resolve) => setTimeout(resolve, 150));
          assert.deepEqual(generationCalls, [expectedInput]);
          assert.deepEqual(sendCalls, authenticationFailure ? [] : [{ to: '+971551234567', text: expectedReply }]);
          assert.equal(aiFactories, 1);
          assert.equal(whatsappFactories, 1);
          assert.equal(forbiddenLoads, 0);
        } finally {
          server.closeAllConnections();
          await server.shutdown();
          await inspection.close();
        }
        assert.deepEqual(generationCalls, [expectedInput]);
        assert.deepEqual(sendCalls, authenticationFailure ? [] : [{ to: '+971551234567', text: expectedReply }]);
        assert.equal(forbiddenLoads, 0);
      })().catch((error) => { console.error(error.message); process.exitCode = 1; });
    `;
    const result = await run(process.execPath, ['-e', script, sourceDirectory], {
      env: isolatedEnv(databaseUrl, {
        AUTOMATION_ENABLED: 'true', WORKER_POLL_MS: '50', META_APP_SECRET: randomBytes(32).toString('hex'),
        WHATSAPP_ACCESS_TOKEN: 'mock-conversation-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890', META_GRAPH_API_VERSION: 'v25.0',
        AI_PROVIDER: 'openai', OPENAI_API_KEY: 'mock-conversation-openai-key', OPENAI_MODEL: 'mock-conversation-model',
      }),
      timeout: 15_000,
    });
    assert.match(result.stdout, /server_listening/);
    assert.doesNotMatch(result.stdout + result.stderr, /Unexpected lead or CRM module load|synthetic-private-auth-message/);
    const stored = await store.getMessage('wamid.conversation-startup');
    assert.equal(stored.authenticated, true);
    assert.equal(stored.processing_flow, 'conversation');
    assert.equal(stored.processing_status, authenticationFailure ? 'FAILED' : 'SUCCESS');
    assert.equal(stored.attempts, 1);
    assert.ok(stored.processed_at);
    assert.equal(stored.next_attempt_at, null);
    assert.equal(stored.extracted_lead_data, null);
    assert.equal(stored.zoho_lead_id, null);
    const reply = await store.getReply('wamid.conversation-startup');
    if (authenticationFailure) assert.equal(reply, null);
    else {
      assert.equal(reply.status, 'SENT');
      assert.equal(reply.provider_message_id, 'wamid.conversation-startup-reply');
      assert.equal(reply.text, 'Yes, Voltronix can help with office AC maintenance. What issue are you experiencing?');
    }
    const previous = await store.getMessage('wamid.before-conversation-startup');
    assert.equal(previous.processing_status, 'RECEIVED');
    assert.equal(previous.processing_flow, null);
    assert.equal(previous.attempts, 0);
    assert.equal(await store.getReply('wamid.before-conversation-startup'), null);
  });
}
