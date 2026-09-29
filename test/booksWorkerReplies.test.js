'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBooksWorker } = require('../src/services/books/booksWorker');

function workerHarness({ result, reserved = true, failAt = null }) {
  const calls = [];
  const job = { job_id: 'job', message_id: 'message', lease_token: 'lease', worker_phone: '+971500000000', payload: {} };
  let claimed = false;
  let sendCount = 0;
  const send = async (kind, value) => {
    calls.push([kind, value]);
    sendCount += 1;
    if (sendCount === failAt) throw Object.assign(new Error('synthetic delivery failure'), { deliveryState: 'ATTEMPTED_FAILED' });
    return { messages: [{ id: `sent-${sendCount}` }] };
  };
  const worker = createBooksWorker({
    billStore: {
      async claimBillExtraction() { if (claimed) return null; claimed = true; return job; },
      async reserveBillReply() { calls.push(['reserve']); return reserved; },
      async finishBillReply(_id, _lease, outcome) { calls.push(['finish', outcome]); },
      async completeBillExtraction(_id, _lease, outcome) { calls.push(['complete', outcome]); },
      async failBillExtraction() { throw new Error('Unexpected extraction failure'); },
    },
    billWorkflow: { async processMessage() { return { success: true, state: 'WAITING_FOR_PROJECT_DETAILS', ...result }; } },
    whatsapp: {
      async sendTextMessage(_phone, message) { return send('text', message); },
      async sendInteractiveList(_phone, message) { return send('interactive', message); },
    },
  });
  return { worker, calls };
}

test('customer detail parts are reserved and delivered in order before the project prompt', async () => {
  const h = workerHarness({ result: { replyMessages: ['Customer part 1', 'Customer part 2'], replyText: 'Enter project/site' } });
  await h.worker.tick();
  assert.deepEqual(h.calls.slice(0, 4), [['reserve'], ['text', 'Customer part 1'], ['text', 'Customer part 2'], ['text', 'Enter project/site']]);
  assert.equal(h.calls.find(([action]) => action === 'finish')[1].status, 'ACCEPTED');
  assert.equal(h.calls.find(([action]) => action === 'complete')[1].replyDelivery, 'ACCEPTED');
  await h.worker.tick();
  assert.equal(h.calls.filter(([action]) => action === 'text').length, 3);
});

test('additional customer messages precede an interactive reply', async () => {
  const list = { header: 'Customer details', body: 'Select customer' };
  const h = workerHarness({ result: { replyMessages: ['Customer context'], replyInteractive: list, replyText: 'fallback' } });
  await h.worker.tick();
  assert.deepEqual(h.calls.slice(0, 3), [['reserve'], ['text', 'Customer context'], ['interactive', list]]);
});

test('duplicate reply reservation suppresses every part of the sequence', async () => {
  const h = workerHarness({ reserved: false, result: { replyMessages: ['Customer'], replyText: 'Project prompt' } });
  await h.worker.tick();
  assert.equal(h.calls.filter(([action]) => ['text', 'interactive'].includes(action)).length, 0);
  assert.equal(h.calls.find(([action]) => action === 'complete')[1].replyDelivery, 'DUPLICATE_SUPPRESSED');
});

test('partial delivery stops subsequent messages and records uncertainty instead of replaying', async () => {
  const h = workerHarness({ failAt: 2, result: { replyMessages: ['Customer part 1', 'Customer part 2'], replyText: 'Project prompt' } });
  await h.worker.tick();
  assert.deepEqual(h.calls.filter(([action]) => action === 'text'), [['text', 'Customer part 1'], ['text', 'Customer part 2']]);
  assert.equal(h.calls.find(([action]) => action === 'finish')[1].status, 'UNKNOWN');
  assert.equal(h.calls.find(([action]) => action === 'complete')[1].replyDelivery, 'UNKNOWN');
});
