'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { temporaryStore, testEnv, silent } = require('./helpers');

async function setup(t, hook) {
  const { store } = await temporaryStore(t);
  const env = testEnv({ AUTOMATION_ENABLED: 'true', AI_PROVIDER: 'openai', META_APP_SECRET: 'synthetic-signing-secret',
    AUTHORIZED_BOSS_PHONES: '+971551234567', WHATSAPP_ACCESS_TOKEN: 'synthetic-access-token',
    WHATSAPP_PHONE_NUMBER_ID: '1234567890', META_GRAPH_API_VERSION: 'v25.0' });
  const app = createApp({ store, env, logger: silent });
  app.locals.onNewMessage = message => hook(message, app, store);
  await app.locals.ready;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  async function post(messages, statuses) {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: '1234567890' }, messages, statuses,
    } }] }] });
    return fetch('http://127.0.0.1:' + server.address().port + '/webhook', { method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', env.META_APP_SECRET).update(body).digest('hex') } });
  }
  return { post, store, app };
}
const message = (id, timestamp = Math.floor(Date.now() / 1000)) => ({ id, from: '971551234567', type: 'text',
  timestamp: String(timestamp), text: { body: 'ABC Contracting needs LV switchgear' } });

test('CRM intake hook runs only after durable new receipt and current-run trigger admission', async t => {
  const seen = [];
  const h = await setup(t, async (entry, app, store) => {
    assert.ok(await store.getMessage(entry.messageId));
    assert.equal(app.locals.triggerGate.allows(entry.messageId), true);
    seen.push(entry.messageId);
  });
  assert.equal((await h.post([message('wamid.crm-new')])).status, 200);
  assert.equal((await h.post([message('wamid.crm-new')])).status, 200);
  assert.equal((await h.post([message('wamid.crm-old', Math.floor(Date.now() / 1000) - 600)])).status, 200);
  assert.equal((await h.post([], [{ id: 'wamid.outgoing', status: 'delivered' }])).status, 200);
  assert.deepEqual(seen, ['wamid.crm-new']);
  assert.equal(h.app.locals.triggerGate.beginProcessing('wamid.crm-new'), true);
  assert.equal(h.app.locals.triggerGate.beginProcessing('wamid.crm-new'), false);
});

test('a failed acknowledgement queue cannot erase the committed inbox or admit duplicates', async t => {
  let attempts = 0;
  const h = await setup(t, () => { attempts++; throw new Error('simulated queue unavailable'); });
  assert.equal((await h.post([message('wamid.crm-queue-failure')])).status, 200);
  assert.ok(await h.store.getMessage('wamid.crm-queue-failure'));
  assert.equal((await h.post([message('wamid.crm-queue-failure')])).status, 200);
  assert.equal(attempts, 1);
});
