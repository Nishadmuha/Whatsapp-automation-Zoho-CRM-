'use strict';
// Exercise the real startup path and HTTP listener without using account credentials.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { createHmac, randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const dotenv = require('dotenv');

async function removeTemporaryDirectory(directory) {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('whatsapp-webhook-smoke-')) throw new Error('Unsafe temporary cleanup path');
  await fs.rm(directory, { recursive: true, force: true });
}

async function runSmoke() {
  const port = process.env.SMOKE_PORT || '5000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid smoke port');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-webhook-smoke-'));
  const verifyToken = randomBytes(32).toString('hex');
  const appSecret = randomBytes(32).toString('hex');
  const example = dotenv.parse(await fs.readFile(path.resolve(__dirname, '../.env.example')));
  // Blank all documented settings so dotenv cannot import real integration settings.
  const env = Object.fromEntries(Object.keys(example).map((key) => [key, '']));
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    NODE_ENV: 'development', HOST: '127.0.0.1', PORT: port, AUTOMATION_ENABLED: 'false',
    WEBHOOK_VERIFY_TOKEN: verifyToken, META_APP_SECRET: appSecret, LOG_LEVEL: 'info',
    DATABASE_URL: 'file:' + path.join(directory, 'messages.sqlite'),
    NODE_TLS_REJECT_UNAUTHORIZED: '1', TEST_DATABASE_URL: '',
  });
  let child;
  let exited;
  let output = '';
  let startupTimer;
  try {
    child = fork(__filename, ['--server'], { env, silent: true, windowsHide: true });
    exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdout.on('data', (chunk) => { output += chunk; });
    // Capture only; never echo unreviewed child errors or configuration.
    child.stderr.on('data', (chunk) => {
      if (chunk.toString().includes('is already in use')) console.error('Smoke port is already in use.');
    });
    await new Promise((resolve, reject) => {
      startupTimer = setTimeout(() => reject(new Error('Startup timed out')), 10000);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Startup failed')));
      child.once('message', (message) => message === 'listening' ? resolve() : reject(new Error('Startup failed')));
    });
    clearTimeout(startupTimer);
    const baseUrl = 'http://127.0.0.1:' + port;
    const get = (url) => fetch(url, { signal: AbortSignal.timeout(5000) });
    const health = await get(baseUrl + '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', service: 'voltronix-whatsapp-backend' });
    console.log('GET /health: 200 (voltronix-whatsapp-backend)');
    const query = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': verifyToken, 'hub.challenge': '12345' });
    const verification = await get(baseUrl + '/webhook?' + query);
    assert.equal(verification.status, 200);
    assert.equal(await verification.text(), '12345');
    console.log('GET /webhook: 200; challenge 12345');
    query.set('hub.verify_token', 'invalid-synthetic-token');
    assert.equal((await get(baseUrl + '/webhook?' + query)).status, 403);
    console.log('Invalid verification token: 403');

    const messageId = 'wamid.local-smoke-' + randomBytes(8).toString('hex');
    const payload = {
      object: 'whatsapp_business_account', entry: [{ id: '100000000001', changes: [{
        field: 'messages', value: {
          messaging_product: 'whatsapp', metadata: { phone_number_id: '100000000002' },
          contacts: [{ wa_id: '971501234567', profile: { name: 'Synthetic Ahmed' } }],
          messages: [{ from: '971501234567', id: messageId, timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text', text: { body: 'Synthetic Ahmed needs AC maintenance' } }],
        },
      }] }],
    };
    const body = JSON.stringify(payload, null, 2);
    const signature = 'sha256=' + createHmac('sha256', appSecret).update(body).digest('hex');
    const post = (signed) => fetch(baseUrl + '/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(signed ? { 'X-Hub-Signature-256': signature } : {}) },
      body, signal: AbortSignal.timeout(5000),
    });
    for (let delivery = 0; delivery < 2; delivery++) {
      const response = await post(true);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'EVENT_RECEIVED');
    }
    console.log('Signed POST /webhook and duplicate delivery: 200');
    assert.equal((await post(false)).status, 403);
    console.log('Unsigned POST with signature validation enabled: 403');
    child.send('shutdown');
    await exited;
    const logs = output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const receipts = logs.filter((record) => record.msg === 'WhatsApp message received');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].message_id, messageId);
    assert.equal(receipts[0].sender, '***4567');
    assert.ok(logs.some((record) => record.event === 'webhook_received' && record.inserted === 0 && record.duplicates === 1));
    for (const privateValue of [verifyToken, appSecret, '971501234567', 'Synthetic Ahmed']) assert.equal(output.includes(privateValue), false);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(directory, 'messages.sqlite'), { readOnly: true });
    try {
      const stored = db.prepare('SELECT COUNT(*) AS count, MAX(processing_status) AS status FROM whatsapp_messages WHERE whatsapp_message_id = ?').get(messageId);
      assert.equal(stored.count, 1);
      assert.equal(stored.status, 'RECEIVED');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reply_outbox').get().count, 0);
    } finally { db.close(); }
    console.log('WhatsApp message received: one receipt, sender ***4567; text omitted from logs');
    console.log('Persistent duplicate protection: one inbox row, zero replies, automation disabled');
    console.log('Local smoke passed on port ' + port + '. Server stopped; real Meta verification remains manual.');
  } finally {
    clearTimeout(startupTimer);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
    await removeTemporaryDirectory(directory);
  }
}

if (process.argv.includes('--server')) {
  require('../src/server').startServer().then((server) => {
    process.once('message', async (message) => {
      if (message === 'shutdown') { await server.shutdown(); process.disconnect(); }
    });
    const listening = () => process.send('listening');
    if (server.listening) listening();
    else server.once('listening', listening);
    server.once('error', () => process.disconnect());
  }).catch(() => {
    process.send('startup_failed');
    process.exitCode = 1;
    process.disconnect();
  });
} else {
  runSmoke().catch(() => {
    console.error('Local webhook smoke failed. Ensure the smoke port (default 5000) is free and run npm test for diagnostics.');
    process.exitCode = 1;
  });
}
