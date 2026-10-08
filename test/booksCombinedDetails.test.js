'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, validBill } = require('./billFixtures');

const CUSTOMER = { contact_id: 'combined-customer', contact_name: 'Example Projects LLC', contact_type: 'customer', status: 'active' };

function combinedFixture() {
  const bill = validBill();
  delete bill.customer_details;
  return fixture({ bill, workerAnswers: null, workerPaymentMethod: null, zohoOverrides: {
    async searchCustomer() { return [CUSTOMER]; },
    async getCustomer() { return CUSTOMER; },
  } });
}

async function reachProject(f) {
  assert.equal((await f.send('Invoice details')).state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal((await f.send('1')).state, 'WAITING_FOR_PROJECT_DETAILS');
}

for (const separator of ['\n', '; ', ', ']) {
  test(`project-first combined reply retains explicit method and status with ${JSON.stringify(separator)} separators`, async () => {
    const f = combinedFixture();
    await reachProject(f);
    const result = await f.send(['Project: Al Quoz workshop', 'Payment method: Cash', 'Payment status: unpaid'].join(separator));
    assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
    assert.equal(result.bill.customer_details.project_site, 'Al Quoz workshop');
    assert.equal(result.bill.customer_details.contact_id, CUSTOMER.contact_id);
    assert.equal(result.bill.payment_type, 'Cash');
    assert.equal(result.bill.payment_method_confirmed, true);
    assert.equal(result.bill.payment_status, 'unpaid');
    assert.equal(f.calls.filter(call => ['edit', 'merge', 'create'].includes(call[0])).length, 0);
    assert.match(result.replyText, /1 SAVE\n2 EDIT\n3 DELETE/);
    assert.equal((await f.send('SAVE')).state, 'COMPLETED');
    assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
  });
}

test('plain project reply retains its text and still asks for payment confirmation', async () => {
  const f = combinedFixture();
  await reachProject(f);
  const result = await f.send('Project: Al Quoz workshop\nBuilding B');
  assert.equal(result.bill.customer_details.project_site, 'Al Quoz workshop\nBuilding B');
  assert.equal(result.bill.payment_method_confirmed, false);
  assert.match(result.replyText, /Please confirm the payment method/);
});

test('project bundle does not confirm an unsupported payment method or save a bill', async () => {
  const f = combinedFixture();
  await reachProject(f);
  const result = await f.send('Project: Al Quoz workshop\nPayment method: unsupported\nPayment status: paid');
  assert.match(result.replyText, /Payment method must be one of/);
  const session = await f.billStore.getBillSession(result.sessionId);
  assert.equal(session.bill_data.payment_method_confirmed, false);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 0);
});

for (const paymentStatus of ['paid', 'unpaid']) {
  test(`manual customer bundle retains explicit ${paymentStatus} without changing vendor TRN`, async () => {
    const f = combinedFixture();
    await f.send('Invoice details');
    const result = await f.send(`MANUAL: Customer: Example Projects LLC\nCustomer TRN: 100000000000001\nProject: Al Quoz workshop\nPayment method: Cash\nPayment status: ${paymentStatus}`);
    assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
    assert.equal(result.bill.customer_details.customer_source, 'manual');
    assert.equal(result.bill.customer_details.customer_lookup_status, 'manual_entry');
    assert.equal(result.bill.customer_details.customer_trn, '100000000000001');
    assert.equal(result.bill.customer_details.project_site, 'Al Quoz workshop');
    assert.equal(result.bill.vendor_trn, undefined);
    assert.equal(result.bill.payment_type, 'Cash');
    assert.equal(result.bill.payment_method_confirmed, true);
    assert.equal(result.bill.payment_status, paymentStatus);
    assert.equal(f.calls.filter(call => ['edit', 'merge', 'create'].includes(call[0])).length, 0);
  });
}

test('labelled customer bundle keeps explicit selection policy and payment status', async () => {
  const f = combinedFixture();
  await f.send('Invoice details');
  const result = await f.send('Customer: Example Projects LLC\nProject: Al Quoz workshop\nPayment method: Cash\nPayment status: unpaid');
  assert.equal(result.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal(result.bill.customer_details.contact_id, null);
  assert.equal(result.bill.payment_status, 'unpaid');
  assert.equal(result.bill.payment_method_confirmed, true);
  const selected = await f.send('1');
  assert.equal(selected.bill.customer_details.contact_id, CUSTOMER.contact_id);
  assert.equal(selected.bill.payment_status, 'unpaid');
  assert.equal(f.calls.filter(call => ['edit', 'merge', 'create'].includes(call[0])).length, 0);
});

test('unlabelled exact customer bundle retains existing automatic exact-match selection', async () => {
  const f = combinedFixture();
  await f.send('Invoice details');
  const result = await f.send('Example Projects LLC\nProject: Al Quoz workshop\nPayment method: Cash\nPayment status: unpaid');
  assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(result.bill.customer_details.contact_id, CUSTOMER.contact_id);
  assert.equal(result.bill.customer_details.project_site, 'Al Quoz workshop');
  assert.equal(result.bill.payment_status, 'unpaid');
  assert.equal(result.bill.payment_method_confirmed, true);
  assert.equal(f.calls.filter(call => ['edit', 'merge', 'create'].includes(call[0])).length, 0);
});
