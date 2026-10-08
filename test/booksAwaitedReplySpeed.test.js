'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { temporaryStore } = require('./helpers');
const { fixture, validBill, WORKER } = require('./billFixtures');
const { createBillStore } = require('../src/database/billStore');
const { createBooksWorker } = require('../src/services/books/booksWorker');
const { isBooksBatchBoundary, isBossBatchBoundary } = require('../src/services/whatsapp/messageBatching');

const PROJECT = 'WAITING_FOR_PROJECT_DETAILS';
const ORGANIZATION = 'WAITING_FOR_ORGANIZATION';
const CURRENCY = 'WAITING_FOR_CURRENCY';
const EDIT = 'WAITING_FOR_EDIT_INSTRUCTION';
const options = { batchQuietMs: 5000, batchBoundary: isBooksBatchBoundary, batchSessionAware: true };
const message = text => ({ message_type: 'text', message_text: text });

async function setup(t, state = PROJECT) {
  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();
  const session = await billStore.createBillSession({ worker_phone: WORKER, state });
  let sequence = 0;
  const enqueue = (payload, workerPhone = WORKER) => billStore.enqueueBillExtraction({
    messageId: `awaited-${++sequence}`, workerPhone, payload,
  });
  return { store, billStore, session, enqueue };
}

test('importing the bill queue before environment setup does not freeze empty organization IDs', () => {
  const script = `
    const assert = require('node:assert/strict');
    for (const name of ['ZOHO_BOOKS_CONTRACTING_ORG_ID', 'ZOHO_BOOKS_SWITCHGEAR_ORG_ID',
      'ZOHO_BOOKS_CONTRACTING_ORGANIZATION_ID', 'ZOHO_BOOKS_SWITCHGEAR_ORGANIZATION_ID']) delete process.env[name];
    require('./src/database/billStore');
    const { isBooksBatchBoundary } = require('./src/services/whatsapp/messageBatching');
    assert.equal(require.cache[require.resolve('./src/services/books/organizations')], undefined);
    process.env.ZOHO_BOOKS_CONTRACTING_ORG_ID = '111111111';
    process.env.ZOHO_BOOKS_SWITCHGEAR_ORG_ID = '222222222';
    assert.equal(isBooksBatchBoundary({ text: 'Voltronix Contracting LLC' }, { state: 'WAITING_FOR_ORGANIZATION' }), true);
    const { resolveOrganization } = require('./src/services/books/organizations');
    assert.equal(resolveOrganization('Voltronix Contracting LLC').organizationId, '111111111');
    assert.equal(resolveOrganization('Voltronix Switchgear LLC').organizationId, '222222222');
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test('only the currently awaited Books project, organization or currency answer becomes an immediate boundary', () => {
  for (const [state, text] of [
    [PROJECT, 'Electrical'], [PROJECT, 'Motor repair, Al Quoz workshop'], [PROJECT, 'Project: Electrical'],
    [ORGANIZATION, 'Voltronix Contracting LLC'], [ORGANIZATION, 'Company name: Voltronix Switchgear LLC'],
    [CURRENCY, 'AED'], [CURRENCY, 'Currency: USD'], [CURRENCY, 'dirhams'],
    [PROJECT, 'Project: Electrical; Payment method: Cash; Payment status: paid'],
    [PROJECT, 'Site: Workshop\nPayment method: Cash\nPayment status: unpaid'],
    [PROJECT, 'Location: Al Quoz, Payment method: Credit Card, Payment status: paid'],
  ]) {
    assert.equal(isBooksBatchBoundary(message(text), { state }), true, `${state}: ${text}`);
    assert.equal(isBooksBatchBoundary(message(text)), false, `No state: ${text}`);
    assert.equal(isBooksBatchBoundary(message(text), { state: EDIT }), false, `Edit: ${text}`);
    assert.equal(isBossBatchBoundary(message(text)), false, `Boss: ${text}`);
  }
  for (const [state, text] of [
    [PROJECT, ''], [PROJECT, 'Project:'], [PROJECT, 'yes'],
    [PROJECT, 'Vendor: Supplier LLC'], [PROJECT, 'Customer: Example LLC'], [PROJECT, 'change total to 220'],
    [PROJECT, 'Invoice 123 AED 220'], [PROJECT, 'Project: First floor\nextra information'],
    [CURRENCY, 'AED; vendor: Supplier'], [CURRENCY, 'US dollars'], [ORGANIZATION, 'Another Company LLC'],
    ['WAITING_FOR_ADDITIONAL_INFO', 'Electrical'], ['WAITING_FOR_CUSTOMER_SELECTION', 'Example LLC'],
  ]) assert.equal(isBooksBatchBoundary(message(text), { state }), false, `${state}: ${text}`);
  for (const type of ['image', 'document', 'audio']) {
    assert.equal(isBooksBatchBoundary({ message_type: type, message_text: 'Electrical' }, { state: PROJECT }), false);
  }
  assert.equal(isBooksBatchBoundary({ ...message('Electrical'), media_id: 'fixture-image' }, { state: PROJECT }), false);
});

test('fresh project, organization and currency replies are claimed without waiting the configured five seconds', async t => {
  const h = await setup(t);
  for (const [state, text] of [[PROJECT, 'Electrical'], [ORGANIZATION, 'Voltronix Contracting LLC'],
    [CURRENCY, 'Currency: AED'], [PROJECT, 'Project: Electrical; Payment method: Cash; Payment status: paid']]) {
    await h.billStore.updateBillSession(h.session.session_id, { state });
    const enqueued = await h.enqueue(message(text));
    const claimed = await h.billStore.claimBillExtraction(options);
    assert.equal(claimed?.message_id, enqueued.message_id, `${state}: ${text}`);
    assert.deepEqual(claimed.batch_items.map(item => item.message_id), [enqueued.message_id]);
    await h.billStore.completeBillExtraction(claimed.job_id, claimed.lease_token);
  }
});

test('session timing context is scoped to the worker and ignores expired, editing and absent sessions', async t => {
  const h = await setup(t);
  await h.enqueue(message('Electrical'), '+971500000002');
  assert.equal(await h.billStore.claimBillExtraction(options), null, 'Another worker cannot borrow the prompt state');
  const enqueued = await h.enqueue(message('Electrical'));
  await h.billStore.updateBillSession(h.session.session_id, { expires_at: new Date(Date.now() - 1000) });
  assert.equal(await h.billStore.claimBillExtraction(options), null, 'Expired prompts do not accelerate new input');
  await h.billStore.updateBillSession(h.session.session_id, { expires_at: new Date(Date.now() + 60000), state: EDIT });
  assert.equal(await h.billStore.claimBillExtraction(options), null, 'Arbitrary editing input retains batching');
  await h.billStore.updateBillSession(h.session.session_id, { state: PROJECT });
  assert.equal((await h.billStore.claimBillExtraction(options))?.message_id, enqueued.message_id);
});

test('invoice media and captions still wait and are claimed together after the quiet window', async t => {
  const h = await setup(t);
  const first = await h.enqueue({ message_type: 'image', media_id: 'fixture-page-1', message_text: 'Electrical' });
  const second = await h.enqueue({ message_type: 'document', media_id: 'fixture-page-2' });
  const caption = await h.enqueue(message('Second page details'));
  assert.equal(await h.billStore.claimBillExtraction(options), null);
  await h.billStore.col('bill_extractions').updateMany({}, { $set: { created_at: new Date(Date.now() - 6000) } });
  const claimed = await h.billStore.claimBillExtraction(options);
  assert.deepEqual(claimed.batch_items.map(item => item.message_id), [first.message_id, second.message_id, caption.message_id]);
});

test('rapid project and payment replies stay separate and the sender cannot be claimed during its existing lease', async t => {
  const h = await setup(t);
  const project = await h.enqueue(message('Electrical'));
  const payment = await h.enqueue(message('Cash'));
  const first = await h.billStore.claimBillExtraction(options);
  assert.deepEqual(first.batch_items.map(item => item.message_id), [project.message_id]);
  assert.equal(await h.billStore.claimBillExtraction(options), null);
  await h.billStore.completeBillExtraction(first.job_id, first.lease_token);
  const second = await h.billStore.claimBillExtraction(options);
  assert.deepEqual(second.batch_items.map(item => item.message_id), [payment.message_id]);
});

test('empty polls, existing choice boundaries and media need no extra session query', async t => {
  const h = await setup(t);
  const originalCol = h.billStore.col.bind(h.billStore);
  const sessions = originalCol('bill_sessions');
  const queries = [];
  t.mock.method(h.billStore, 'col', name => name === 'bill_sessions' ? {
    async findOne(filter, projection) { queries.push([filter, projection]); return sessions.findOne(filter, projection); },
  } : originalCol(name));
  assert.equal(await h.billStore.claimBillExtraction(options), null);
  for (const text of ['1', '8', 'Cash', 'PAID', 'SAVE']) {
    await h.enqueue(message(text));
    const claimed = await h.billStore.claimBillExtraction(options);
    assert.ok(claimed);
    await h.billStore.completeBillExtraction(claimed.job_id, claimed.lease_token);
  }
  await h.enqueue({ message_type: 'image', media_id: 'fixture-page' });
  assert.equal(await h.billStore.claimBillExtraction(options), null);
  assert.equal(queries.length, 0);
  await h.enqueue(message('Electrical'), '+971500000002');
  assert.equal(await h.billStore.claimBillExtraction(options), null);
  assert.equal(queries.length, 1);
  assert.equal(queries[0][0].worker_phone, '+971500000002');
  assert.deepEqual(queries[0][1], { projection: { state: 1, _id: 0 } });
});

test('Books worker immediately processes the project answer and retains the payment question and SAVE gate', async t => {
  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();
  const bill = validBill();
  bill.customer_details.project_site = null;
  const f = fixture({ billStore, bill, workerAnswers: null, workerPaymentMethod: null });
  const initial = await f.send('Bill details');
  assert.equal(initial.state, PROJECT);
  await billStore.enqueueBillExtraction({ messageId: 'project-answer', workerPhone: WORKER, payload: message('Electrical') });
  const worker = createBooksWorker({ billStore, billWorkflow: f.workflow, whatsapp: f.whatsapp,
    config: { messageBatchQuietMs: 5000 } });
  await worker.tick();
  const session = await billStore.getActiveBillSession(WORKER);
  assert.equal(session.bill_data.customer_details.project_site, 'Electrical');
  assert.equal(session.state, 'WAITING_FOR_ADDITIONAL_INFO');
  assert.match(f.calls.find(([action]) => action === 'text')[2], /Please confirm the payment method/);
  assert.equal(f.calls.some(([action]) => ['create', 'edit', 'merge', 'document'].includes(action)), false);
  assert.equal((await billStore.getBillExtractionByMessageId('project-answer')).status, 'COMPLETED');
});
