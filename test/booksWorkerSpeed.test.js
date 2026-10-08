'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBooksWorker } = require('../src/services/books/booksWorker');
const { createBillStore } = require('../src/database/billStore');
const { readConfig } = require('../src/config/env');
const { temporaryStore, testEnv } = require('./helpers');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let count = 0; count < 100; count += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Expected worker progress did not occur');
}

function job(id, phone) {
  return { job_id: id, message_id: id, worker_phone: phone, lease_token: `lease-${id}`,
    created_at: new Date(Date.now() - 1000), payload: { message_type: 'text', message_text: 'SAVE' } };
}

function harness({ jobs = [], process, send, beforeClaim, config = {} } = {}) {
  const pending = [...jobs];
  const calls = [];
  const logs = [];
  let simultaneousClaims = 0;
  let maxClaims = 0;
  const worker = createBooksWorker({
    config,
    logger: { info: entry => logs.push(entry), error: entry => logs.push(entry) },
    billStore: {
      async claimBillExtraction(options) {
        simultaneousClaims += 1;
        maxClaims = Math.max(maxClaims, simultaneousClaims);
        calls.push(['claim', options]);
        try {
          await beforeClaim?.();
          const index = pending.findIndex(item => !options.excludeWorkerPhones.includes(item.worker_phone));
          return index < 0 ? null : pending.splice(index, 1)[0];
        } finally { simultaneousClaims -= 1; }
      },
      async reserveBillReply(id) { calls.push(['reserve', id]); return true; },
      async finishBillReply(id, _lease, result) { calls.push(['finish', id, result]); },
      async completeBillExtraction(id, _lease, result) { calls.push(['complete', id, result]); },
      async failBillExtraction(id) { calls.push(['fail', id]); },
    },
    billWorkflow: { async processMessage(incoming) {
      calls.push(['process', incoming.messageId]);
      return process ? process(incoming) : { success: true, replyText: `Reply ${incoming.messageId}` };
    } },
    whatsapp: {
      async sendTextMessage(phone, text) {
        calls.push(['text', phone, text]);
        await send?.(phone, text);
        return { messages: [{ id: `sent-${calls.length}` }] };
      },
      async sendInteractiveList(phone, value) { calls.push(['interactive', phone, value]); return {}; },
    },
  });
  return { worker, pending, calls, logs, maxClaims: () => maxClaims };
}

test('Books processes another sender while a slow bill waits and drains the first sender after its full reply', async () => {
  const extraction = deferred();
  const delivery = deferred();
  const h = harness({ jobs: [job('a1', 'A'), job('a2', 'A'), job('b1', 'B')],
    async process(incoming) {
      if (incoming.messageId === 'a1') {
        await extraction.promise;
        return { success: true, replyMessages: ['Customer part 1', 'Customer part 2'], replyText: 'Project prompt' };
      }
      return { success: true, replyText: `Reply ${incoming.messageId}` };
    },
    async send(_phone, text) { if (text === 'Project prompt') await delivery.promise; },
  });
  const ticking = h.worker.tick();
  await until(() => h.calls.some(([action, id]) => action === 'complete' && id === 'b1'));
  assert.deepEqual(h.calls.filter(([action]) => action === 'process').map(([, id]) => id), ['a1', 'b1']);
  extraction.resolve();
  await until(() => h.calls.some(([action, , text]) => action === 'text' && text === 'Project prompt'));
  assert.equal(h.calls.some(([action, id]) => action === 'process' && id === 'a2'), false);
  delivery.resolve();
  await ticking;
  assert.deepEqual(h.calls.filter(([action, phone]) => action === 'text' && phone === 'A').map(([, , text]) => text),
    ['Customer part 1', 'Customer part 2', 'Project prompt', 'Reply a2']);
  assert.equal(h.maxClaims(), 1);
  const completed = h.logs.find(entry => entry.event === 'books_job_completed' && entry.jobId === 'a1');
  assert.ok(completed.queueWaitMs >= 1000);
  assert.ok(completed.durationMs >= 0);
  assert.equal(completed.workerPhone, undefined);
});

test('Books concurrency is bounded and reentrant wake/tick cannot duplicate claims', async t => {
  const blocked = deferred();
  const h = harness({ jobs: ['A', 'B', 'C', 'D'].map(phone => job(phone, phone)),
    config: { enabled: true, pollMs: 60000, booksConcurrency: 2 },
    async process() { await blocked.promise; return { success: true, replyText: 'Done' }; },
  });
  t.after(() => h.worker.stop());
  h.worker.start();
  await until(() => h.calls.filter(([action]) => action === 'process').length === 2);
  h.worker.wake();
  h.worker.wake();
  const ticking = h.worker.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(([action]) => action === 'process').length, 2);
  blocked.resolve();
  await ticking;
  assert.deepEqual(h.calls.filter(([action]) => action === 'process').map(([, id]) => id).sort(), ['A', 'B', 'C', 'D']);
  assert.equal(h.calls.filter(([action]) => action === 'text').length, 4);
  assert.equal(h.maxClaims(), 1);
});

test('Books stop waits for an in-flight claim and its reply without claiming more jobs', async () => {
  const claiming = deferred();
  const sending = deferred();
  const h = harness({ jobs: [job('first', 'A'), job('second', 'B')],
    beforeClaim: () => claiming.promise, send: () => sending.promise,
  });
  const ticking = h.worker.tick();
  await until(() => h.calls.some(([action]) => action === 'claim'));
  let stopped = false;
  const stopping = h.worker.stop().then(() => { stopped = true; });
  claiming.resolve();
  await until(() => h.calls.some(([action]) => action === 'text'));
  assert.equal(stopped, false);
  assert.equal(h.calls.filter(([action]) => action === 'claim').length, 1);
  sending.resolve();
  await Promise.all([ticking, stopping]);
  assert.equal(stopped, true);
  h.worker.wake();
  await h.worker.tick();
  assert.equal(h.calls.filter(([action]) => action === 'process').length, 1);
  assert.equal(h.pending.length, 1);
});

test('Books wake starts newly enqueued work without waiting for the polling interval', async t => {
  const h = harness({ config: { enabled: true, pollMs: 60000 } });
  t.after(() => h.worker.stop());
  h.worker.start();
  await h.worker.tick();
  const initialClaims = h.calls.filter(([action]) => action === 'claim').length;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(([action]) => action === 'claim').length, initialClaims);
  h.pending.push(job('fresh', 'A'));
  h.worker.wake();
  await until(() => h.calls.some(([action, id]) => action === 'complete' && id === 'fresh'));
});

test('Books immediate drain defers failed-job retries until another poll or wake', async () => {
  const failedJob = job('retry', 'A');
  const h = harness({ jobs: [failedJob], async process() {
    h.pending.push(failedJob);
    return { success: false, error: { message: 'Unavailable' } };
  } });
  await h.worker.tick();
  assert.equal(h.calls.filter(([action]) => action === 'process').length, 1);
  await h.worker.tick();
  assert.equal(h.calls.filter(([action]) => action === 'process').length, 2);
});

test('Books concurrency setting defaults to three, validates one to four, and leaves shared timing unchanged', () => {
  const baseline = readConfig(testEnv());
  assert.equal(baseline.booksConcurrency, 3);
  for (const value of ['1', '2', '3']) {
    const config = readConfig(testEnv({ BOOKS_WORKER_CONCURRENCY: value }));
    assert.equal(config.booksConcurrency, Number(value));
    assert.equal(config.pollMs, baseline.pollMs);
    assert.equal(config.messageBatchQuietMs, baseline.messageBatchQuietMs);
  }
  for (const value of ['0', '4', '-1', '1.5', 'invalid']) {
    assert.throws(() => readConfig(testEnv({ BOOKS_WORKER_CONCURRENCY: value })), /BOOKS_WORKER_CONCURRENCY/);
  }
});

test('billStore excludes active senders before the candidate limit and serializes them without batching', async t => {
  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();
  for (let index = 0; index < 12; index += 1) {
    await billStore.enqueueBillExtraction({ messageId: `a-${index}`, workerPhone: 'A', payload: {} });
  }
  await billStore.enqueueBillExtraction({ messageId: 'b-1', workerPhone: 'B', payload: {} });
  const a = await billStore.claimBillExtraction({ workerPhone: 'A' });
  assert.equal(a.worker_phone, 'A');
  assert.equal(await billStore.claimBillExtraction({ workerPhone: 'A', batchQuietMs: 0 }), null);
  const b = await billStore.claimBillExtraction({ excludeWorkerPhones: ['A'], batchQuietMs: 0 });
  assert.equal(b.message_id, 'b-1');
  assert.equal(await billStore.claimBillExtraction({ workerPhone: 'A', excludeWorkerPhones: ['A'] }), null);
  await billStore.completeBillExtraction(a.job_id, a.lease_token, {});
  const next = await billStore.claimBillExtraction({ workerPhone: 'A' });
  assert.equal(next.message_id, 'a-1');
  await assert.rejects(billStore.claimBillExtraction({ excludeWorkerPhones: 'A' }), { code: 'INVALID_INPUT' });
});
