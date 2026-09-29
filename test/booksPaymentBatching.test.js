'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { temporaryStore } = require('./helpers');
const { createBillStore } = require('../src/database/billStore');
const { isBooksBatchBoundary, isBossBatchBoundary } = require('../src/services/whatsapp/messageBatching');

const paymentReplies = ['Cash', 'Bank Transfer', 'Bank Remittance', 'Credit Card', 'Cheque',
  'Payment method: Cash', 'Payment type = Bank Transfer', 'Paid by: Cheque', 'Cash.', 'Cheque!',
  'Paid by Cash', 'Paid in Cash'];

test('standalone Books payment-method replies bypass batching without changing Boss boundaries', () => {
  for (const text of paymentReplies) {
    const message = { message_type: 'text', message_text: ` ${text} ` };
    assert.equal(isBooksBatchBoundary(message), true, text);
    assert.equal(isBossBatchBoundary(message), false, text);
  }
  for (const text of ['Customer: Cash Trading LLC', 'Project: Bank Transfer Room',
    'Cash sale invoice 123', 'Payment method: Cash; Customer: Example LLC']) {
    assert.equal(isBooksBatchBoundary({ text }), false, text);
  }
  assert.equal(isBooksBatchBoundary({ message_type: 'image', message_text: 'Cash' }), false);
});

test('payment-method replies can be claimed immediately while ordinary bill text keeps its quiet window', async t => {
  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();
  const workerPhone = '+971501112233';
  for (const [index, text] of paymentReplies.entries()) {
    await billStore.enqueueBillExtraction({ messageId: `method-${index}`, workerPhone,
      payload: { message_type: 'text', message_text: text } });
    const job = await billStore.claimBillExtraction({ batchQuietMs: 60000, batchBoundary: isBooksBatchBoundary });
    assert.ok(job, `${text} should not wait for the quiet window`);
    assert.deepEqual(job.batch_items.map(item => item.message_id), [`method-${index}`]);
    await billStore.completeBillExtraction(job.job_id, job.lease_token, { result: { success: true } });
  }
  await billStore.enqueueBillExtraction({ messageId: 'invoice-text', workerPhone,
    payload: { message_type: 'text', message_text: 'Cash sale invoice 123' } });
  assert.equal(await billStore.claimBillExtraction({ batchQuietMs: 60000, batchBoundary: isBooksBatchBoundary }), null);
});
