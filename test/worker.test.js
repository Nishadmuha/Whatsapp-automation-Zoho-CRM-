'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createWorker } = require('../src/worker');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(t, overrides = {}) {
  const scheduled = [];
  const cleared = [];
  const calls = [];
  const logs = [];
  t.mock.method(global, 'setInterval', (callback, milliseconds) => {
    const timer = { callback, milliseconds, unref() { this.unreferenced = true; } };
    scheduled.push(timer);
    return timer;
  });
  t.mock.method(global, 'clearInterval', (timer) => { cleared.push(timer); });
  const config = { enabled: true, pollMs: 1000, leaseMs: 120000, maxAttempts: 3, ...overrides.config };
  const store = overrides.store || { async claimNext(options) { calls.push(['claim', options]); return null; } };
  const processor = overrides.processor || {
    async processIncomingWhatsAppMessage(job) { calls.push(['process', job]); },
    async processNextReply() { calls.push(['reply']); return false; },
  };
  const worker = createWorker({ config, store, processor, logger: { error: (record) => logs.push(record) },
    ...(overrides.inboxClaimOptions ? { inboxClaimOptions: overrides.inboxClaimOptions } : {}),
    ...(overrides.processInbox === undefined ? {} : { processInbox: overrides.processInbox }) });
  t.after(() => worker.stop());
  return { worker, scheduled, cleared, calls, logs };
}

test('Disabled worker does not claim jobs, process replies, or schedule external work', async (t) => {
  const { worker, calls, scheduled } = setup(t, { config: { enabled: false } });
  worker.start();
  worker.start();
  await flush();
  assert.deepEqual(calls, []);
  assert.deepEqual(scheduled, []);
  await worker.stop();
});

test('Enabled worker starts immediately once and uses bounded lease and attempt settings', async (t) => {
  const { worker, calls, scheduled } = setup(t);
  worker.start();
  worker.start();
  await flush();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].milliseconds, 1000);
  assert.equal(scheduled[0].unreferenced, true);
  assert.deepEqual(calls, [['claim', { leaseMs: 120000, maxAttempts: 3 }], ['reply']]);
});

test('Reply-only worker drains the outbox without claiming or processing inbox jobs', async (t) => {
  let replies = 0;
  const { worker, scheduled } = setup(t, {
    processInbox: false,
    store: { async claimNext() { assert.fail('Reply-only mode must not claim inbox jobs'); } },
    processor: {
      async processIncomingWhatsAppMessage() { assert.fail('Reply-only mode must not run lead processing'); },
      async processNextReply() { replies += 1; return false; },
    },
  });
  worker.start();
  await flush();
  assert.equal(replies, 1);
  scheduled[0].callback();
  await flush();
  assert.equal(replies, 2);
});

test('Conversational worker scopes inbox claims while preserving configured lease and retry bounds', async t => {
  const { worker, calls } = setup(t, { inboxClaimOptions: { processingFlow: 'conversation' } });
  worker.start();
  await flush();
  assert.deepEqual(calls, [['claim', { processingFlow: 'conversation', leaseMs: 120000, maxAttempts: 3 }], ['reply']]);
});

test('Worker interval ticks cannot overlap a pending asynchronous claim or processing operation', async (t) => {
  const claim = deferred();
  const processing = deferred();
  let claims = 0;
  let processed = 0;
  const job = { whatsapp_message_id: 'mock-message' };
  const { worker, scheduled } = setup(t, {
    store: { async claimNext() { claims += 1; return claims === 1 ? claim.promise : null; } },
    processor: {
      async processIncomingWhatsAppMessage(received) { assert.equal(received, job); processed += 1; await processing.promise; },
      async processNextReply() { return false; },
    },
  });
  worker.start();
  scheduled[0].callback();
  scheduled[0].callback();
  await flush();
  assert.equal(claims, 1);
  claim.resolve(job);
  await flush();
  assert.equal(processed, 1);
  scheduled[0].callback();
  await flush();
  assert.equal(claims, 1);
  processing.resolve();
  await flush();
  scheduled[0].callback();
  await flush();
  assert.equal(claims, 2);
  assert.equal(processed, 1);
});

test('Worker processes an inbox job before draining up to ten confirmations per tick', async (t) => {
  const events = [];
  let pending = 13;
  const { worker, scheduled } = setup(t, {
    store: { async claimNext() { events.push('claim'); return { whatsapp_message_id: 'mock-message' }; } },
    processor: {
      async processIncomingWhatsAppMessage() { events.push('message'); },
      async processNextReply() {
        events.push('reply');
        if (pending === 0) return false;
        pending -= 1;
        return true;
      },
    },
  });
  worker.start();
  await flush();
  assert.deepEqual(events.slice(0, 2), ['claim', 'message']);
  assert.equal(events.filter((event) => event === 'reply').length, 10);
  assert.equal(pending, 3);
  scheduled[0].callback();
  await flush();
  assert.equal(pending, 0);
  assert.equal(events.filter((event) => event === 'reply').length, 14);
});

test('Worker still drains confirmations when no incoming message is available and stops at an empty outbox', async (t) => {
  let replies = 0;
  const { worker } = setup(t, {
    store: { async claimNext() { return null; } },
    processor: {
      async processIncomingWhatsAppMessage() { assert.fail('No inbox job should process'); },
      async processNextReply() { replies += 1; return replies < 3; },
    },
  });
  worker.start();
  await flush();
  assert.equal(replies, 3);
});

test('Worker stop waits for the in-flight job and prevents further replies or claims', async (t) => {
  const gate = deferred();
  let processed = false;
  let replies = 0;
  let claims = 0;
  const { worker, scheduled, cleared } = setup(t, {
    store: { async claimNext() { claims += 1; return { whatsapp_message_id: 'mock-message' }; } },
    processor: {
      async processIncomingWhatsAppMessage() { await gate.promise; processed = true; },
      async processNextReply() { replies += 1; return true; },
    },
  });
  worker.start();
  await flush();
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  scheduled[0].callback();
  await flush();
  assert.equal(stopped, false);
  assert.equal(cleared[0], scheduled[0]);
  gate.resolve();
  await stopping;
  assert.equal(processed, true);
  assert.equal(stopped, true);
  assert.equal(replies, 0);
  assert.equal(claims, 1);
  scheduled[0].callback();
  await flush();
  assert.equal(claims, 1);
});

test('Worker recovers after claim, processing, or outbox exceptions without leaking raw errors', async (t) => {
  let phase = 0;
  let success = 0;
  const { worker, scheduled, logs } = setup(t, {
    store: { async claimNext() {
      if (phase === 0) throw new Error('private database credential');
      return { whatsapp_message_id: 'mock-message' };
    } },
    processor: {
      async processIncomingWhatsAppMessage() { if (phase === 1) throw new Error('private lead details'); },
      async processNextReply() {
        if (phase === 2) throw new Error('private access token');
        success += 1;
        return false;
      },
    },
  });
  worker.start();
  await flush();
  for (phase = 1; phase <= 3; phase += 1) {
    scheduled[0].callback();
    await flush();
  }
  assert.equal(success, 1);
  assert.deepEqual(logs, Array.from({ length: 3 }, () => ({ event: 'worker_tick_failed' })));
  assert.equal(JSON.stringify(logs).includes('private'), false);
});
