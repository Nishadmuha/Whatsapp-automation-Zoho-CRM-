'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, validBill } = require('./billFixtures');

for (const reply of ['7-oct-26', '7-Oct-2026', '2026-10-07', 'Bill date: 7-Oct-26']) {
  test(`missing bill date reply ${reply} bypasses AI and preserves the reviewed facts`, async () => {
    const f = fixture({ bill: { ...validBill(), bill_date: null } });
    const initial = await f.send('Invoice details');
    assert.match(initial.replyText, /Please supply bill date/);
    const before = structuredClone(await f.billStore.getBill(initial.billId));
    const result = await f.send(reply);
    assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
    assert.equal(result.bill.bill_date, '2026-10-07');
    assert.equal(f.calls.some(([action]) => ['edit', 'merge', 'create'].includes(action)), false);
    const after = await f.billStore.getBill(initial.billId);
    for (const field of ['vendor_name', 'line_items', 'subtotal', 'tax_amount', 'total_amount', 'payment_type', 'customer_details', 'organization']) {
      assert.deepEqual(after[field], before[field], field);
    }
    assert.equal((await f.send('SAVE')).state, 'COMPLETED');
    assert.equal(f.calls.find(([action]) => action === 'create')[1].billDate, '2026-10-07');
  });
}

test('an explicit date correction changes only the bill date and retains final SAVE', async () => {
  const f = fixture();
  const initial = await f.send('Invoice details');
  const result = await f.send('Invoice date: 7-Oct-26');
  assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(result.bill.bill_date, '2026-10-07');
  assert.equal((await f.billStore.getBill(initial.billId)).bill_date, '2026-10-07');
  assert.equal(f.calls.some(([action]) => ['edit', 'merge', 'create'].includes(action)), false);
});

test('a date-shaped project answer remains project text rather than changing an existing bill date', async () => {
  const bill = validBill();
  bill.customer_details.project_site = null;
  const f = fixture({ bill, workerAnswers: null, workerPaymentMethod: null });
  assert.equal((await f.send('Invoice details')).state, 'WAITING_FOR_PROJECT_DETAILS');
  const result = await f.send('7-Oct-26');
  assert.equal(result.bill.bill_date, bill.bill_date);
  assert.equal(result.bill.customer_details.project_site, '7-Oct-26');
});

test('ambiguous numeric date replies cannot bypass correction validation', async () => {
  const f = fixture({ bill: { ...validBill(), bill_date: null }, extractionOverrides: {
    async applyEditInstructions({ currentBill }) { return { success: true, bill: currentBill }; },
  } });
  await f.send('Invoice details');
  const result = await f.send('03/04/26');
  assert.equal(result.bill.bill_date, null);
  assert.match(result.replyText, /Please supply bill date/);
  assert.equal(f.calls.some(([action]) => action === 'create'), false);
});
