'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, memoryStore, validBill, WORKER } = require('./billFixtures');

const turn = () => new Promise(resolve => setImmediate(resolve));
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function harness({ paid = false, gates = {}, pdfStatus, attachmentCount = 1, intentFailure = false,
  verificationFailure = false, paymentFailure = false, pdfFailure = false, pdfTotal = 105, pdfCurrency = 'AED' } = {}) {
  const events = [], writes = [], state = { pdfFailure };
  const billStore = memoryStore();
  const bill = { ...validBill(), payment_status: paid ? 'paid' : 'unpaid', payment_method_confirmed: true,
    zoho_vendor_id: 'v1', zoho_bill_id: '123456', payment_recording_status: paid ? 'PENDING' : 'NOT_REQUIRED',
    amount_verification_status: 'PENDING', pdf_delivery_status: pdfStatus,
    attachments: Array.from({ length: attachmentCount }, (_, index) => ({
      storage_reference: `attachment-${index + 1}`, original_filename: `page-${index + 1}.jpg`, mime_type: 'image/jpeg',
    })) };
  const session = { session_id: 'fixture-session', bill_id: 'fixture-bill', worker_phone: WORKER,
    state: 'CREATING_IN_ZOHO', bill_data: bill, attachments: bill.attachments };
  await billStore.createBillSession(session);
  await billStore.saveBill({ ...bill, status: 'CREATING', bill_id: session.bill_id, worker_phone: WORKER });
  const updateBill = billStore.updateBill.bind(billStore);
  billStore.updateBill = async (id, updates) => {
    if (intentFailure && updates.attachments?.some(attachment => attachment.zoho_upload_status === 'uploading')) {
      throw Error('Fixture attachment intent persistence failure');
    }
    return updateBill(id, updates);
  };
  async function wait(name) {
    events.push(name);
    if (gates[name]) await gates[name].promise;
  }
  const f = fixture({ billStore, bill, sourceStore: {
    async getMediaFile(reference) { return { buffer: Buffer.from(`original:${reference}`) }; },
  }, zohoOverrides: {
    async verifyBillTotal() {
      await wait('verify');
      if (verificationFailure) throw Object.assign(Error('Fixture amount mismatch'), { code: 'BILL_TOTAL_MISMATCH' });
      return { total: 105, currencyCode: 'AED' };
    },
    async recordBillPayment() {
      await wait('payment');
      if (paymentFailure) throw Object.assign(Error('Fixture payment failure'), { code: 'PAYMENT_PREFLIGHT_FAILED' });
      writes.push('payment');
      return { id: 'fixture-payment', status: 'paid' };
    },
    async attachBillFile(input) {
      const record = await billStore.getBill(session.bill_id);
      assert.equal(record.attachments.find(item => item.original_filename === input.filename).zoho_upload_status,
        'uploading', 'Attachment upload still requires its durable intent');
      writes.push(`attachment:${input.filename}`);
      await wait(`attachment:${input.filename}`);
      return { attachmentId: `uploaded:${input.filename}` };
    },
    async getBillPdf() {
      await wait('pdf');
      if (state.pdfFailure) throw Error('Fixture PDF read failure');
      return { buffer: Buffer.from('%PDF-fixture-created'), bill: { total: pdfTotal, currency_code: pdfCurrency } };
    },
  }, whatsappOverrides: {
    async sendDocument() {
      const record = await billStore.getBill(session.bill_id);
      assert.equal(record.pdf_delivery_status, 'SENDING', 'Document delivery still requires its durable intent');
      assert.ok(record.attachments.every(item => item.zoho_upload_status === 'uploaded'));
      writes.push('document');
      events.push('document');
      return { messages: [{ id: 'fixture-document' }] };
    },
  } });
  return { ...f, events, writes, state, session };
}

test('PDF preparation overlaps sequential attachments only after amount and payment confirmation', async t => {
  const gates = Object.fromEntries(['verify', 'payment', 'pdf', 'attachment:page-1.jpg', 'attachment:page-2.jpg']
    .map(name => [name, gate()]));
  t.after(() => Object.values(gates).forEach(item => item.release()));
  const h = await harness({ paid: true, attachmentCount: 2, gates });
  const pending = h.send('SAVE');
  await turn();
  assert.deepEqual(h.events, ['verify']);
  gates.verify.release();
  await turn();
  assert.deepEqual(h.events, ['verify', 'payment']);
  gates.payment.release();
  await turn();
  assert.ok(h.events.includes('pdf') && h.events.includes('attachment:page-1.jpg'));
  assert.equal(h.events.includes('attachment:page-2.jpg'), false, 'Attachments retain their sequential upload order');
  gates.pdf.release();
  await turn();
  assert.equal(h.events.includes('document'), false, 'Prepared PDF must not be delivered while attachments are pending');
  gates['attachment:page-1.jpg'].release();
  await turn();
  assert.equal(h.events.at(-1), 'attachment:page-2.jpg');
  assert.equal(h.events.includes('document'), false);
  gates['attachment:page-2.jpg'].release();
  assert.equal((await pending).state, 'COMPLETED');
  assert.deepEqual(h.writes, ['payment', 'attachment:page-1.jpg', 'attachment:page-2.jpg', 'document']);
});

test('completed attachments still wait for the prepared PDF before delivery', async t => {
  const pdf = gate();
  t.after(() => pdf.release());
  const h = await harness({ gates: { pdf } });
  let finished = false;
  const pending = h.send('SAVE').then(result => { finished = true; return result; });
  await turn();
  assert.ok(h.events.includes('pdf') && h.events.includes('attachment:page-1.jpg'));
  assert.equal((await h.billStore.getBill(h.session.bill_id)).attachments[0].zoho_upload_status, 'uploaded');
  assert.equal(finished, false);
  assert.equal(h.events.includes('document'), false);
  pdf.release();
  assert.equal((await pending).state, 'COMPLETED');
  assert.equal(h.events.at(-1), 'document');
});

test('a fast PDF read failure waits for attachment checkpoints and retries only the PDF', async t => {
  const attachment = gate();
  t.after(() => attachment.release());
  const h = await harness({ pdfFailure: true, gates: { 'attachment:page-1.jpg': attachment } });
  let finished = false;
  const pending = h.send('SAVE').then(result => { finished = true; return result; });
  await turn();
  assert.equal(finished, false);
  assert.equal(h.events.includes('document'), false);
  attachment.release();
  assert.match((await pending).replyText, /PDF could not be retrieved/);
  assert.equal((await h.billStore.getBill(h.session.bill_id)).pdf_delivery_status, 'FETCH_FAILED');
  h.state.pdfFailure = false;
  assert.equal((await h.send('SAVE')).state, 'COMPLETED');
  assert.equal(h.events.filter(event => event === 'pdf').length, 2);
  assert.deepEqual(h.writes, ['attachment:page-1.jpg', 'document']);
  assert.equal(h.calls.some(([action]) => action === 'create'), false, 'PDF retries cannot recreate a financial record');
});

test('attachment intent failure drains a started PDF failure without uploading or delivering anything', async t => {
  const pdf = gate();
  t.after(() => pdf.release());
  const h = await harness({ intentFailure: true, pdfFailure: true, gates: { pdf } });
  let finished = false;
  const pending = h.send('SAVE').then(result => { finished = true; return result; });
  await turn();
  assert.equal(h.events.includes('pdf'), true);
  assert.equal(finished, false, 'Even the early attachment failure must settle the already-started PDF request');
  assert.deepEqual(h.writes, []);
  pdf.release();
  assert.match((await pending).replyText, /attachment state could not be persisted.*No upload was attempted/);
  assert.deepEqual(h.writes, []);
  assert.equal((await h.billStore.getBill(h.session.bill_id)).pdf_delivery_status, undefined);
});

for (const pdfStatus of ['ACCEPTED', 'SENDING', 'UNKNOWN']) {
  test(`${pdfStatus} PDF delivery is never fetched or delivered again while attachments finish`, async () => {
    const h = await harness({ pdfStatus });
    const result = await h.send('SAVE');
    assert.equal(h.events.includes('pdf'), false);
    assert.equal(h.events.includes('document'), false);
    assert.deepEqual(h.writes, ['attachment:page-1.jpg']);
    assert.equal(result.state, pdfStatus === 'ACCEPTED' ? 'COMPLETED' : 'CREATING_IN_ZOHO');
  });
}

for (const mismatch of [{ pdfTotal: 106 }, { pdfCurrency: 'USD' }]) {
  test(`prepared PDF ${mismatch.pdfTotal ? 'amount' : 'currency'} mismatch still blocks delivery`, async () => {
    const h = await harness(mismatch);
    assert.match((await h.send('SAVE')).replyText, /saved record amount or currency differs/);
    assert.equal((await h.billStore.getBill(h.session.bill_id)).pdf_delivery_status, 'RECORD_MISMATCH');
    assert.deepEqual(h.writes, ['attachment:page-1.jpg']);
  });
}

for (const failure of [{ verificationFailure: true }, { paid: true, paymentFailure: true }]) {
  test(`${failure.verificationFailure ? 'amount' : 'payment'} failure prevents all PDF preparation and attachment work`, async () => {
    const h = await harness(failure);
    assert.equal((await h.send('SAVE')).state, 'CREATING_IN_ZOHO');
    assert.equal(h.events.includes('pdf'), false);
    assert.equal(h.events.includes('attachment:page-1.jpg'), false);
    assert.deepEqual(h.writes, []);
  });
}
