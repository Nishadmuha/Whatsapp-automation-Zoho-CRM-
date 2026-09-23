'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { temporaryStore } = require('./helpers');

const run = promisify(execFile);

for (const extractionFails of [false, true]) {
test(extractionFails
  ? 'boss extraction failure leaves customer AI running and sends a truthful failure confirmation'
  : 'one server collects and confirms boss leads while customers retain their existing AI replies', async t => {
  const { store, databaseUrl } = await temporaryStore(t);
  await store.enqueueMany([{
    whatsapp_message_id: 'wamid.legacy-boss-startup', sender_phone: '+971551234567', message_type: 'text',
    message_text: 'Previously received boss message', received_at: new Date().toISOString(), authenticated: true,
  }]);
  const script = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const path = require('node:path');
    const { once } = require('node:events');
    const { createHmac } = require('node:crypto');
    const root = process.argv[1];
    const extractionFails = ${extractionFails};
    const bossText = 'Desert Build LLC: Sara needs AC maintenance in Dubai. Customer phone 0501234567.';
    const customerText = 'Do you offer office maintenance?';
    const normalReply = 'Thank you. How can Voltronix help with your request?';
    const result = { is_lead: true, lead: {
      company_name: 'Desert Build LLC', contact_name: 'Sara', phone: '0501234567', email: null,
      project_name: null, project_location: 'Dubai', product_or_service: 'AC maintenance',
      requirement: null, quantity: null, deadline: null, notes: null,
    } };
    const forbiddenDirectories = ['zoho'].map(name => path.join(root, 'services', name) + path.sep);
    const forbiddenProcessor = path.join(root, 'services/leads/leadProcessor.js');
    const aiModule = path.join(root, 'services/ai/aiService.js');
    const whatsappModule = path.join(root, 'services/whatsapp/whatsappService.js');
    const configModule = path.join(root, 'config/env.js');
    let aiFactories = 0;
    let whatsappFactories = 0;
    let forbiddenLoads = 0;
    const generationCalls = [];
    const extractionCalls = [];
    const sendCalls = [];
    let readStore;
    let releaseExtraction;
    const extractionGate = new Promise(resolve => { releaseExtraction = resolve; });
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      const filename = Module._resolveFilename(request, parent, isMain);
      if (filename === forbiddenProcessor || forbiddenDirectories.some(directory => filename.startsWith(directory))) {
        forbiddenLoads++;
        throw new Error('Unexpected legacy lead or Zoho module load');
      }
      const loaded = originalLoad.apply(this, arguments);
      // Let the OS bind an unused port atomically, without a reserve/release
      // race against other test servers running in parallel.
      if (filename === configModule) return { ...loaded,
        readConfig: (...args) => ({ ...loaded.readConfig(...args), port: 0 }) };
      if (filename === aiModule) return { ...loaded, createAiService() {
        aiFactories++;
        return {
          async generateReply(text) {
            generationCalls.push(text);
            assert.equal(text, customerText, 'Boss lead text must never enter conversational generation.');
            return normalReply;
          },
          async extractLeadEnquiry(text) {
            extractionCalls.push(text);
            assert.equal(text, bossText);
            await extractionGate;
            if (extractionFails) throw Object.assign(new Error('synthetic-private-extraction-error'), {
              code: 'AI_AUTHENTICATION_ERROR', retryable: false,
            });
            return result;
          },
        };
      } };
      if (filename === whatsappModule) return { ...loaded, createWhatsAppService() {
        whatsappFactories++;
        return { async sendTextMessage(to, text) {
          sendCalls.push({ to, text });
          if (/Processing the lead/.test(text)) return { messages: [{ id: 'wamid.ack-' + sendCalls.length }] };
          if (to === '+971551234567') {
            const rows = await readStore.listLeads({ page: 1, pageSize: 10 });
            if (text.startsWith('Lead saved successfully')) {
              assert.equal(rows.total, 1);
              assert.equal(rows.items[0].original_message, bossText);
              assert.equal(rows.items[0].zoho_status, 'not_started');
              assert.equal(await readStore.getActiveLeadSession(to), null);
            } else {
              assert.equal(rows.total, 0, 'A confirmation request or extraction error cannot create a lead.');
              const draft = await readStore.getActiveLeadSession(to);
              assert.equal(draft.original_message, bossText);
              assert.equal(draft.state, extractionFails ? 'collecting' : 'awaiting_confirmation');
              if (extractionFails) assert.doesNotMatch(text, /saved internally|saved successfully/i);
              else assert.equal(text, 'I have the available information for this lead. Is everything complete and ready to save?');
            }
          } else assert.equal(text, normalReply);
          return { messages: [{ id: 'wamid.normal-reply-' + sendCalls.length }] };
        } };
      } };
      return loaded;
    };
    (async () => {
      const { startServer } = require(path.join(root, 'server.js'));
      const { createMessageStore } = require(path.join(root, 'database'));
      const server = await startServer();
      const inspection = createMessageStore({ databaseUrl: process.env.DATABASE_URL });
      readStore = inspection;
      try {
        await inspection.init();
        if (!server.listening) await once(server, 'listening');
        const base = 'http://127.0.0.1:' + server.address().port;
        const timestamp = String(Math.floor(Date.now() / 1000));
        const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
          messaging_product: 'whatsapp', metadata: { phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID },
          messages: [
            { id: 'wamid.new-boss-startup', from: '971551234567', type: 'text', text: { body: bossText }, timestamp },
            { id: 'wamid.new-customer-startup', from: '971561234567', type: 'text', text: { body: customerText }, timestamp },
          ],
        } }] }] });
        const signature = 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
        const post = () => fetch(base + '/webhook', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature }, body });
        const responses = await Promise.all([post(), post(), post()]);
        responses.forEach(response => assert.equal(response.status, 200));
        const replyDeadline = Date.now() + 5000;
        let conversationsComplete = false;
        while (Date.now() < replyDeadline) {
          const extraction = await inspection.getLeadExtraction('wamid.new-boss-startup');
          const bossReply = await inspection.getReply('wamid.new-boss-startup');
          const customerReply = await inspection.getReply('wamid.new-customer-startup');
          conversationsComplete = extractionCalls.length === 1 && extraction?.processing_status === 'PROCESSING'
            && bossReply === null && customerReply?.status === 'SENT';
          if (conversationsComplete) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(conversationsComplete, true, 'Customer reply must be SENT and boss reply absent while extraction is pending.');
        assert.equal((await inspection.getLeadExtraction('wamid.new-boss-startup')).result, null);
        assert.equal((await fetch(base + '/health')).status, 200);
        assert.deepEqual(await (await fetch(base + '/ready')).json(), { status: 'ready', automation: 'enabled' });
        releaseExtraction();
        const deadline = Date.now() + 5000;
        let complete = false;
        while (Date.now() < deadline) {
          const extraction = await inspection.getLeadExtraction('wamid.new-boss-startup');
          const bossReply = await inspection.getReply('wamid.new-boss-startup');
          const customerReply = await inspection.getReply('wamid.new-customer-startup');
          complete = extraction?.processing_status === (extractionFails ? 'FAILED' : 'SUCCESS')
            && bossReply?.status === 'SENT' && customerReply?.status === 'SENT';
          if (complete) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(complete, true, 'Both conversations and the independent boss extraction must complete.');
        assert.equal((await post()).status, 200);
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.deepEqual(generationCalls, [customerText]);
        assert.deepEqual(extractionCalls, [bossText]);
        assert.equal(sendCalls.filter(call => /Processing the lead/.test(call.text)).length, 1);
        assert.deepEqual(sendCalls.filter(call => !/Processing the lead/.test(call.text)).map(call => call.to).sort(), ['+971551234567', '+971561234567']);
        if (!extractionFails) {
          const confirmation = JSON.parse(body);
          confirmation.entry[0].changes[0].value.messages = [{ id: 'wamid.confirm-boss-startup', from: '971551234567',
            type: 'text', text: { body: 'Yes' }, timestamp }];
          const confirmBody = JSON.stringify(confirmation);
          const confirmSignature = 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET).update(confirmBody).digest('hex');
          for (let duplicate = 0; duplicate < 2; duplicate++) assert.equal((await fetch(base + '/webhook', { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': confirmSignature }, body: confirmBody })).status, 200);
          const saveDeadline = Date.now() + 5000;
          while ((await inspection.getReply('wamid.confirm-boss-startup'))?.status !== 'SENT' && Date.now() < saveDeadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.equal((await inspection.getReply('wamid.confirm-boss-startup')).status, 'SENT');
          assert.equal((await inspection.listLeads()).total, 1);
        }
        assert.equal(aiFactories, 1, 'Conversation and extraction workers share the existing AI service.');
        assert.equal(whatsappFactories, 1);
        assert.equal(forbiddenLoads, 0);
        assert.equal(await inspection.getLeadExtraction('wamid.new-customer-startup'), null);
        assert.equal(await inspection.getLeadExtraction('wamid.legacy-boss-startup'), null);
        assert.equal(await inspection.getReply('wamid.legacy-boss-startup'), null);
        assert.equal((await inspection.getMessage('wamid.legacy-boss-startup')).processing_status, 'RECEIVED');
        assert.equal((await fetch(base + '/health')).status, 200);
        assert.deepEqual(await (await fetch(base + '/ready')).json(), { status: 'ready', automation: 'enabled' });
      } finally {
        releaseExtraction();
        server.closeAllConnections();
        await server.shutdown();
        await inspection.close();
      }
      assert.equal(generationCalls.length, 1);
      assert.equal(extractionCalls.length, 1);
      assert.equal(sendCalls.filter(call => !/Processing the lead/.test(call.text)).length, extractionFails ? 2 : 3);
      assert.equal(forbiddenLoads, 0);
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  const outcome = await run(process.execPath, ['-e', script, path.resolve(__dirname, '../src')], {
    env: {
      ...process.env,
      NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '5000', NODE_TLS_REJECT_UNAUTHORIZED: '1',
      AUTOMATION_ENABLED: 'true', DATABASE_URL: databaseUrl, MONGODB_URI: '', WORKER_POLL_MS: '50', WORKER_LEASE_MS: '30000',
      BOSS_REPLY_QUIET_MS: '100',
      PROCESSING_MAX_ATTEMPTS: '3', WEBHOOK_VERIFY_TOKEN: randomBytes(32).toString('hex'),
      META_APP_SECRET: randomBytes(32).toString('hex'), WHATSAPP_APP_SECRET: '',
      WHATSAPP_ACCESS_TOKEN: 'mock-boss-startup-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890',
      META_GRAPH_API_VERSION: 'v25.0', WHATSAPP_API_VERSION: '',
      ALLOWED_SENDER_PHONES: '', BOSS_SENDER_PHONES: '', AUTHORIZED_BOSS_PHONES: '+971551234567', ADMIN_USERNAME: '', ADMIN_PASSWORD: '',
      AI_PROVIDER: 'openai', OPENAI_API_KEY: 'mock-boss-startup-openai-key', OPENAI_MODEL: 'mock-boss-startup-model',
      GEMINI_API_KEY: '', GEMINI_MODEL: '', AI_TIMEOUT_MS: '20000', AI_MAX_OUTPUT_TOKENS: '4096',
      ZOHO_CLIENT_ID: '', ZOHO_CLIENT_SECRET: '', ZOHO_REFRESH_TOKEN: '', ZOHO_ACCOUNTS_URL: '', ZOHO_API_BASE_URL: '',
      LOG_LEVEL: 'info',
    },
    timeout: 45_000,
  });
  assert.match(outcome.stdout, /server_listening/);
  assert.doesNotMatch(outcome.stdout + outcome.stderr,
    /Unexpected legacy lead or Zoho module load|Desert Build LLC|mock-boss-startup-openai-key|synthetic-private-extraction-error/);
  const extraction = await store.getLeadExtraction('wamid.new-boss-startup');
  assert.equal(extraction.processing_status, extractionFails ? 'FAILED' : 'SUCCESS');
  assert.equal(extraction.attempts, 1);
  assert.equal(extraction.next_attempt_at, null);
  assert.ok(extraction.processed_at);
  if (extractionFails) {
    assert.equal(extraction.result.is_lead, false);
    assert.equal(extraction.error_message, 'AI_AUTHENTICATION_ERROR');
  } else {
    assert.equal(extraction.result.lead.phone, '+971501234567');
    assert.equal(extraction.result.lead.company_name, 'Desert Build LLC');
  }
  for (const id of ['wamid.new-boss-startup', 'wamid.new-customer-startup']) {
    const message = await store.getMessage(id);
    assert.equal(message.processing_status, id === 'wamid.new-boss-startup' ? extractionFails ? 'FAILED' : 'NEEDS_INFORMATION' : 'SUCCESS');
    assert.equal(message.extracted_lead_data, null);
    assert.equal(message.zoho_lead_id, null);
    assert.equal(message.crm_write_started, false);
    assert.equal((await store.getReply(id)).status, 'SENT');
  }
  assert.equal((await store.getMessage('wamid.new-boss-startup')).message_text,
    'Desert Build LLC: Sara needs AC maintenance in Dubai. Customer phone 0501234567.');
  assert.equal((await store.getMessage('wamid.new-customer-startup')).message_text, 'Do you offer office maintenance?');
  assert.equal(await store.getLeadExtraction('wamid.new-customer-startup'), null);
  assert.equal(await store.getLeadExtraction('wamid.legacy-boss-startup'), null);
  assert.equal((await store.getMessage('wamid.legacy-boss-startup')).attempts, 0);
});
}
