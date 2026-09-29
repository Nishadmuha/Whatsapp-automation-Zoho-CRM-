'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, validBill } = require('./billFixtures');

function setup({ accounts, configured = false } = {}) {
  const options = accounts || [
    { id: 'cash1', name: 'Petty Cash', type: 'cash', organizationId: '828765858' },
    { id: 'cash2', name: 'Undeposited Funds', type: 'cash', organizationId: '828765858' },
  ];
  const preparations = [], payments = [];
  const f = fixture({ workerAnswers: null, bill: { ...validBill(), payment_type: 'Cash' }, zohoOverrides: {
    async listPaymentAccounts({ organizationId }) { return options.filter(account => account.organizationId === organizationId); },
    async prepareBillPayment(input) {
      preparations.push(input);
      if (!input.paymentAccountId && !configured) throw Object.assign(new Error('choose account'), { code: 'PAYMENT_ACCOUNT_CONFIG_REQUIRED' });
      const account = options.find(option => option.id === (input.paymentAccountId || options[0]?.id));
      if (!account || account.organizationId !== input.organizationId) throw Object.assign(new Error('invalid'), { code: 'PAYMENT_ACCOUNT_INVALID' });
      return { accountId: account.id, accountName: account.name, paymentMode: input.paymentType };
    },
    async recordBillPayment(input) { payments.push(input); return { id: 'payment-1', status: 'paid' }; },
  } });
  return { ...f, preparations, payments };
}

test('paid worker chooses the actual account and reviews it before SAVE records a payment', async () => {
  const f = setup();
  const initial = await f.send('Bill');
  const picker = await f.send('PAID');
  assert.equal(picker.state, 'WAITING_FOR_PAYMENT_ACCOUNT');
  assert.deepEqual(picker.replyInteractive.sections[0].rows.map(row => row.title), ['Petty Cash', 'Undeposited Funds']);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 0);
  const review = await f.send('1');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(review.bill.payment_account_id, 'cash1');
  assert.match(review.replyText, /Payment account:.*Petty Cash/);
  assert.equal(f.payments.length, 0);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 0);
  assert.equal((await f.send('SAVE')).state, 'COMPLETED');
  assert.equal(f.payments.length, 1);
  assert.equal(f.payments[0].paymentAccountId, 'cash1');
  assert.equal(f.payments[0].organizationId, '828765858');
  assert.equal((await f.billStore.getBill(initial.billId)).payment_account_name, 'Petty Cash');
});

test('configured defaults are verified and displayed without an unnecessary account question', async () => {
  const f = setup({ configured: true });
  await f.send('Bill');
  const result = await f.send('PAID');
  assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(result.bill.payment_account_id, 'cash1');
  assert.match(result.replyText, /Petty Cash/);
});

test('forged and out-of-range selections cannot choose an account or accidentally SAVE/DELETE', async () => {
  const f = setup(); await f.send('Bill'); await f.send('PAID');
  for (const message of [{ text: '3' }, { text: 'wrong', interactiveId: 'zoho-payment-account:foreign' }, { text: '0' }]) {
    const result = await f.send(message.text, message);
    assert.equal(result.state, 'WAITING_FOR_PAYMENT_ACCOUNT');
    assert.equal(result.bill.payment_account_id, null);
  }
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 0);
});

test('account pages obey WhatsApp row limits and only accept the visible page', async () => {
  const accounts = Array.from({ length: 19 }, (_, index) => ({ id: `account${index}`, name: `Cash account ${index}`, type: 'cash', organizationId: '828765858' }));
  const f = setup({ accounts }); await f.send('Bill');
  const first = await f.send('PAID');
  assert.equal(first.replyInteractive.sections[0].rows.length, 9);
  const next = await f.send('next', { interactiveId: 'zoho-payment-accounts:next' });
  assert.equal(next.replyInteractive.sections[0].rows.length, 10);
  const stale = await f.send('stale', { interactiveId: 'zoho-payment-account:account0' });
  assert.equal(stale.state, 'WAITING_FOR_PAYMENT_ACCOUNT');
  const selected = await f.send('1');
  assert.equal(selected.bill.payment_account_id, 'account8');
});

test('switching to UNPAID clears an account and no vendor payment is recorded', async () => {
  const f = setup(); await f.send('Bill'); await f.send('PAID'); await f.send('2');
  const result = await f.send('UNPAID');
  assert.equal(result.bill.payment_account_id, null);
  assert.equal(result.bill.payment_account_name, null);
  await f.send('SAVE');
  assert.equal(f.payments.length, 0);
});

test('changing payment method clears the previous account and requests a new selection', async () => {
  const f = setup(); await f.send('Bill'); await f.send('PAID'); await f.send('1');
  const result = await f.send('Payment method: Bank Transfer');
  assert.equal(result.state, 'WAITING_FOR_PAYMENT_ACCOUNT');
  assert.equal(result.bill.payment_account_id, null);
  assert.equal(result.bill.payment_account_name, null);
});

test('a missing account list blocks paid saves with a useful correction prompt', async () => {
  const f = setup({ accounts: [] }); await f.send('Bill');
  const result = await f.send('PAID');
  assert.equal(result.state, 'WAITING_FOR_PAYMENT_ACCOUNT');
  assert.match(result.replyText, /No active Cash payment account/);
  assert.equal(result.replyInteractive, undefined);
  await f.send('SAVE');
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 0);
});

test('organization change cannot retain the former payment account', async () => {
  const f = setup(); await f.send('Bill'); await f.send('PAID'); await f.send('1');
  const result = await f.send('VOLTRONIX SWITCHGEAR LLC');
  assert.equal(result.bill.payment_account_id, null);
  assert.equal(result.bill.payment_account_organization_id, null);
});

test('payment method choices use each organization accounts and omit unavailable Credit Card', async () => {
  const lookups = [];
  const accountsByOrganization = {
    '802911060': [{ id: '101', name: 'Switchgear Cash', type: 'cash' }, { id: '102', name: 'Switchgear Bank', type: 'bank' }],
    '828765858': [{ id: '201', name: 'Contracting Card', type: 'credit_card' }],
  };
  for (const [organizationId, name] of [['802911060', 'VOLTRONIX SWITCHGEAR LLC'], ['828765858', 'VOLTRONIX CONTRACTING LLC']]) {
    const f = fixture({ workerAnswers: null, bill: { ...validBill(), payment_type: null, organization: { organizationId, name, confidence: 1 } }, zohoOverrides: {
      async listPaymentAccounts(input) {
        lookups.push(input);
        const type = input.paymentType === 'Cash' ? 'cash' : input.paymentType === 'Credit Card' ? 'credit_card' : 'bank';
        return accountsByOrganization[input.organizationId].filter(account => account.type === type).map(account => ({ ...account, organizationId: input.organizationId }));
      },
    } });
    const initial = await f.send('Bill');
    const invalid = await f.send('Payment method: invalid');
    for (const result of [initial, invalid]) {
      if (organizationId === '802911060') {
        assert.match(result.replyText, /Cash.*Bank Remittance.*Bank Transfer.*Cheque/);
        assert.doesNotMatch(result.replyText, /Credit Card/);
      } else {
        assert.match(result.replyText, /Credit Card/);
        assert.doesNotMatch(result.replyText, /Cash|Bank Transfer|Cheque/);
      }
    }
    assert.ok(lookups.slice(-6).every(input => input.organizationId === organizationId));
  }
});

test('unavailable Credit Card account offers only actual organization payment methods', async () => {
  const f = fixture({ workerAnswers: null, bill: { ...validBill(), organization: { name: 'VOLTRONIX SWITCHGEAR LLC', organizationId: '802911060', confidence: 1 } }, zohoOverrides: {
    async prepareBillPayment() { throw Object.assign(new Error('choose account'), { code: 'PAYMENT_ACCOUNT_CONFIG_REQUIRED' }); },
    async listPaymentAccounts({ paymentType, organizationId }) {
      return paymentType === 'Credit Card' ? [] : [{ id: '101', name: 'Available account', type: paymentType === 'Cash' ? 'cash' : 'bank', organizationId }];
    },
  } });
  await f.send('Bill');
  const result = await f.send('PAID');
  assert.equal(result.state, 'WAITING_FOR_PAYMENT_ACCOUNT');
  assert.match(result.replyText, /No active Credit Card payment account/);
  assert.match(result.replyText, /send payment method: Cash \/ Bank Remittance \/ Bank Transfer \/ Cheque/);
  assert.doesNotMatch(result.replyText.split('send payment method:')[1], /Credit Card/);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 0);
});

test('failed payment availability lookup does not advertise unsupported methods', async () => {
  const f = fixture({ workerAnswers: null, bill: { ...validBill(), payment_type: null }, zohoOverrides: {
    async listPaymentAccounts() { throw new Error('offline'); },
  } });
  const result = await f.send('Bill');
  assert.match(result.replyText, /could not verify the available payment methods/);
  assert.doesNotMatch(result.replyText, /Credit Card|Cash|Bank Transfer/);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 0);
});

test('UNPAID proceeds without any payment-account lookup or validation', async () => {
  const f = fixture({ workerAnswers: null, zohoOverrides: {
    async listPaymentAccounts() { assert.fail('Unpaid bills must not look up payment accounts'); },
    async prepareBillPayment() { assert.fail('Unpaid bills must not require a payment account'); },
    async recordBillPayment() { assert.fail('Unpaid bills must not record a payment'); },
  } });
  await f.send('Bill');
  assert.equal((await f.send('UNPAID')).state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal((await f.send('SAVE')).state, 'COMPLETED');
});

test('an account invalidated after review blocks PAID creation at final preflight', async () => {
  const f = setup();
  await f.send('Bill'); await f.send('PAID'); await f.send('1');
  f.zoho.prepareBillPayment = async () => { throw Object.assign(new Error('inactive'), { code: 'PAYMENT_ACCOUNT_INVALID' }); };
  const result = await f.send('SAVE');
  assert.match(result.replyText, /payment account.*missing or invalid/);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 0);
  assert.equal(f.payments.length, 0);
});
