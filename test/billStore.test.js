'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { temporaryStore } = require('./helpers');
const { createBillStore } = require('../src/database/billStore');

test('billStore: worker payment choice and Zoho reconciliation survive reload and retry updates', async (t) => {
  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();
  const bill = await billStore.saveBill({ worker_phone: '+971501112233' });
  assert.equal(bill.payment_status, null);
  assert.equal(bill.payment_method_confirmed, false);
  assert.equal(bill.payment_recording_status, null);
  assert.equal(bill.amount_verification_status, null);
  assert.equal(bill.payment_account_id, null);
  assert.equal(bill.payment_account_name, null);
  assert.equal(bill.payment_account_organization_id, null);

  await billStore.updateBill(bill.bill_id, {
    payment_type: 'Cash', payment_method_confirmed: true, payment_status: 'paid', payment_recording_status: 'UNKNOWN',
    payment_account_id: '1234567890123456789', payment_account_name: 'Main cash',
    payment_account_organization_id: 'org-1',
    payment_recording_error: 'Payment response was interrupted',
    zoho_total: 700.02, zoho_currency: 'AED', amount_verification_status: 'VERIFIED',
  });
  const recovered = await billStore.getBill(bill.bill_id);
  assert.equal(recovered.payment_status, 'paid');
  assert.equal(recovered.payment_method_confirmed, true);
  assert.equal(recovered.payment_account_id, '1234567890123456789');
  assert.equal(recovered.payment_account_name, 'Main cash');
  assert.equal(recovered.payment_account_organization_id, 'org-1');
  const resaved = await billStore.saveBill(recovered);
  assert.equal(resaved.payment_method_confirmed, true);
  assert.equal(resaved.payment_account_id, '1234567890123456789');
  assert.equal(resaved.payment_account_name, 'Main cash');
  assert.equal(resaved.payment_account_organization_id, 'org-1');
  assert.equal(recovered.payment_recording_status, 'UNKNOWN');
  assert.equal(recovered.payment_recording_error, 'Payment response was interrupted');
  assert.equal(recovered.zoho_total, 700.02);
  assert.equal(recovered.zoho_currency, 'AED');
  assert.equal(recovered.amount_verification_status, 'VERIFIED');

  await billStore.updateBill(bill.bill_id, {
    zoho_payment_id: 'payment-1', payment_recording_status: 'RECORDED', payment_recording_error: null,
  });
  const recorded = await billStore.getBill(bill.bill_id);
  assert.equal(recorded.zoho_payment_id, 'payment-1');
  assert.equal(recorded.payment_recording_status, 'RECORDED');
  assert.equal(recorded.payment_recording_error, null);
  assert.equal(recorded.payment_status, 'paid');
  await assert.rejects(billStore.updateBill(bill.bill_id, { payment_status: 'probably' }), { code: 'INVALID_PAYMENT_STATUS' });
  await assert.rejects(billStore.updateBill(bill.bill_id, { payment_method_confirmed: 'true' }), { code: 'INVALID_INPUT' });
  await assert.rejects(billStore.updateBill(bill.bill_id, { amount_verification_status: 'assumed' }), { code: 'INVALID_AMOUNT_VERIFICATION_STATUS' });
  await assert.rejects(billStore.saveBill({ worker_phone: '+971501112233', payment_recording_status: 'sent' }), { code: 'INVALID_PAYMENT_RECORDING_STATUS' });
});

test('billStore: customer pages persist and project/payment prompts protect active sessions', async (t) => {
  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();
  const workerPhone = '+971501112233';
  const customers = [{ contact_id: 'customer-1' }, { contact_id: 'customer-2' }];
  const session = await billStore.createBillSession({
    worker_phone: workerPhone, state: 'WAITING_FOR_CUSTOMER_SELECTION',
    customer_options: [customers[0]], customer_all_options: customers,
    customer_page: 0, customer_search: 'motor',
    payment_account_options: [{ account_id: '1234567890123456789', organization_id: 'org-1' }],
  });
  assert.equal(session.customer_page, 0);
  assert.equal(session.payment_account_page, 0);
  await billStore.updateBillSession(session.session_id, { customer_page: 1, customer_options: [customers[1]] });
  const resumed = await billStore.getBillSession(session.session_id);
  assert.equal(resumed.customer_page, 1);
  assert.equal(resumed.customer_search, 'motor');
  assert.deepEqual(resumed.customer_all_options, customers);
  assert.deepEqual(resumed.customer_options, [customers[1]]);
  assert.deepEqual(resumed.payment_account_options, [{ account_id: '1234567890123456789', organization_id: 'org-1' }]);
  await billStore.updateBillSession(session.session_id, { payment_account_page: 2 });
  assert.equal((await billStore.getBillSession(session.session_id)).payment_account_page, 2);

  for (const state of ['WAITING_FOR_PROJECT_DETAILS', 'WAITING_FOR_PAYMENT_STATUS', 'WAITING_FOR_PAYMENT_ACCOUNT']) {
    await billStore.updateBillSession(session.session_id, { state });
    assert.equal((await billStore.getActiveBillSession(workerPhone)).state, state);
    await assert.rejects(billStore.createBillSession({ worker_phone: workerPhone }), { code: 'ACTIVE_SESSION_EXISTS' });
    await assert.rejects(store.col('bill_sessions').insertOne({
      session_id: `conflicting-${state}`, worker_phone: workerPhone, state: 'EXTRACTING',
    }), { code: 11000 });
  }
  await assert.rejects(billStore.updateBillSession(session.session_id, { customer_page: -1 }), { code: 'INVALID_INPUT' });
  await assert.rejects(billStore.updateBillSession(session.session_id, { customer_page: 0.5 }), { code: 'INVALID_INPUT' });
  await assert.rejects(billStore.updateBillSession(session.session_id, { payment_account_page: -1 }), { code: 'INVALID_INPUT' });
  await assert.rejects(billStore.updateBillSession(session.session_id, { payment_account_page: 0.5 }), { code: 'INVALID_INPUT' });
});

test('billStore: save, retrieve, and update bills', async (t) => {
  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();

  // Save bill
  const billData = {
    worker_phone: '+971501112233',
    vendor_name: 'Acme Electronics LLC',
    vendor_phone: '+971509998877',
    vendor_email: 'billing@acme.example',
    vendor_trn: '100234567800003',
    bill_number: 'INV-2026-001',
    bill_date: '2026-03-15',
    due_date: '2026-04-15',
    currency: 'AED',
    subtotal: 1000,
    tax_amount: 50,
    discount_amount: 0,
    total_amount: 1050,
    line_items: [
      {
        name: 'Circuit Board',
        description: 'PCB Type A',
        quantity: 10,
        rate: 100,
        tax: 5,
        amount: 1050,
        account_id: 'acc_123',
      },
    ],
    notes: 'Net 30 terms',
    additional_information: 'Urgent supply',
    attachments: [
      {
        storage_reference: 'ref_abc_123',
        original_filename: 'invoice.pdf',
        mime_type: 'application/pdf',
        media_id: 'media_987',
        storage_url: '/api/media/ref_abc_123',
      },
    ],
  };

  const saved = await billStore.saveBill(billData);
  assert.ok(saved);
  assert.ok(saved.bill_id);
  assert.strictEqual(saved.vendor_name, 'Acme Electronics LLC');
  assert.strictEqual(saved.bill_number, 'INV-2026-001');
  assert.strictEqual(saved.total_amount, 1050);
  assert.strictEqual(saved.status, 'DRAFT');
  assert.strictEqual(saved.zoho_status, 'NOT_SYNCED');
  assert.strictEqual(saved.line_items.length, 1);
  assert.strictEqual(saved.attachments.length, 1);

  // Retrieve bill
  const retrieved = await billStore.getBill(saved.bill_id);
  assert.ok(retrieved);
  assert.strictEqual(retrieved.bill_id, saved.bill_id);
  assert.strictEqual(retrieved.vendor_trn, '100234567800003');

  // Update bill
  const updated = await billStore.updateBill(saved.bill_id, {
    status: 'READY_FOR_CONFIRMATION',
    zoho_status: 'SYNCING',
    notes: 'Approved by finance',
    new_edit_history: {
      editor: 'worker',
      field: 'notes',
      previous_value: 'Net 30 terms',
      new_value: 'Approved by finance',
      reason: 'Manager approved',
    },
  });

  assert.ok(updated);
  assert.strictEqual(updated.status, 'READY_FOR_CONFIRMATION');
  assert.strictEqual(updated.zoho_status, 'SYNCING');
  assert.strictEqual(updated.notes, 'Approved by finance');
  assert.strictEqual(updated.edit_history.length, 1);

  // List bills & stats
  const list = await billStore.listBills({ workerPhone: '+971501112233' });
  assert.strictEqual(list.total, 1);
  assert.strictEqual(list.items[0].bill_id, saved.bill_id);

  const stats = await billStore.getBillStats();
  assert.strictEqual(stats.total, 1);
  assert.strictEqual(stats.ready_for_confirmation, 1);
  assert.strictEqual(stats.zoho_syncing, 1);
});

test('billStore: bill sessions state lifecycle and completion', async (t) => {
  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();

  const workerPhone = '+971507778899';

  // 1. Create session
  const session = await billStore.createBillSession({
    worker_phone: workerPhone,
    state: 'EXTRACTING',
    bill_data: { vendor_name: 'Tech Supplies' },
  });

  assert.ok(session);
  assert.ok(session.session_id);
  assert.strictEqual(session.worker_phone, workerPhone);
  assert.strictEqual(session.state, 'EXTRACTING');

  // 2. Retrieve active session
  const active = await billStore.getActiveBillSession(workerPhone);
  assert.ok(active);
  assert.strictEqual(active.session_id, session.session_id);
  assert.strictEqual(active.state, 'EXTRACTING');

  // 3. Update state
  const updated = await billStore.updateBillSession(session.session_id, {
    state: 'AWAITING_ADDITIONAL_INFO',
    bill_data: { vendor_name: 'Tech Supplies', total_amount: 500 },
  });
  assert.strictEqual(updated.state, 'AWAITING_ADDITIONAL_INFO');

  // Active session reflects new state
  const active2 = await billStore.getActiveBillSession(workerPhone);
  assert.strictEqual(active2.state, 'AWAITING_ADDITIONAL_INFO');

  // 4. Complete session
  const completed = await billStore.completeBillSession(session.session_id);
  assert.strictEqual(completed.state, 'COMPLETED');

  // 5. Active session is now null
  const activeAfterComplete = await billStore.getActiveBillSession(workerPhone);
  assert.strictEqual(activeAfterComplete, null);
});

test('billStore: active session protection prevents concurrent active sessions for same worker', async (t) => {
  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();

  const workerPhone = '+971509991122';

  // Create first active session
  await billStore.createBillSession({
    worker_phone: workerPhone,
    state: 'EXTRACTING',
  });

  // Attempting to create a second active session for the same worker must fail
  await assert.rejects(
    async () => {
      await billStore.createBillSession({
        worker_phone: workerPhone,
        state: 'EXTRACTING',
      });
    },
    (err) => {
      assert.strictEqual(err.code, 'ACTIVE_SESSION_EXISTS');
      return true;
    }
  );

  // Different worker can create an active session without conflict
  const otherWorker = await billStore.createBillSession({
    worker_phone: '+971508883344',
    state: 'EXTRACTING',
  });
  assert.ok(otherWorker);

  // Once first session is cancelled, the first worker can create a new session
  const activeFirst = await billStore.getActiveBillSession(workerPhone);
  await billStore.cancelBillSession(activeFirst.session_id);

  const newSessionFirst = await billStore.createBillSession({
    worker_phone: workerPhone,
    state: 'EXTRACTING',
  });
  assert.ok(newSessionFirst);
  assert.notStrictEqual(newSessionFirst.session_id, activeFirst.session_id);
});

test('billStore: extraction job enqueue, claim, lease, heartbeat, complete, and fail', async (t) => {
  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();

  const messageId = 'wamid.HBgNNzkxNTAxMjM0NTY3FQIAERgSM';
  const workerPhone = '+971501234567';

  // 1. Enqueue job
  const job = await billStore.enqueueBillExtraction({
    messageId,
    workerPhone,
    maxAttempts: 3,
    payload: { source: 'whatsapp_image' },
  });

  assert.ok(job);
  assert.ok(job.job_id);
  assert.strictEqual(job.message_id, messageId);
  assert.strictEqual(job.status, 'PENDING');
  assert.strictEqual(job.attempts, 0);

  // Idempotent enqueue returns same job
  const duplicate = await billStore.enqueueBillExtraction({
    messageId,
    workerPhone,
  });
  assert.strictEqual(duplicate.job_id, job.job_id);

  // 2. Claim job
  const claimed = await billStore.claimBillExtraction({ leaseMs: 60000 });
  assert.ok(claimed);
  assert.strictEqual(claimed.job_id, job.job_id);
  assert.strictEqual(claimed.status, 'PROCESSING');
  assert.strictEqual(claimed.attempts, 1);
  assert.ok(claimed.lease_token);
  assert.ok(claimed.lease_until);

  // Cannot claim again while leased
  const noJob = await billStore.claimBillExtraction({ leaseMs: 60000 });
  assert.strictEqual(noJob, null);

  // 3. Heartbeat extends lease
  const initialLeaseUntil = new Date(claimed.lease_until).getTime();
  await new Promise((r) => setTimeout(r, 50));
  const heartbeatOk = await billStore.heartbeatBillExtraction(claimed.job_id, claimed.lease_token, 120000);
  assert.strictEqual(heartbeatOk, true);

  const refreshed = await billStore.getBillExtraction(claimed.job_id);
  assert.ok(new Date(refreshed.lease_until).getTime() > initialLeaseUntil);

  // 4. Begin processing exchanges lease token
  const executionToken = await billStore.beginBillExtractionProcessing(claimed.job_id, claimed.lease_token, 60000);
  assert.ok(executionToken);
  assert.notStrictEqual(executionToken, claimed.lease_token);

  // Old lease token is rejected
  const oldHeartbeat = await billStore.heartbeatBillExtraction(claimed.job_id, claimed.lease_token, 60000);
  assert.strictEqual(oldHeartbeat, false);

  // New execution token works
  const newHeartbeat = await billStore.heartbeatBillExtraction(claimed.job_id, executionToken, 60000);
  assert.strictEqual(newHeartbeat, true);

  // 5. Complete extraction
  const completeOk = await billStore.completeBillExtraction(claimed.job_id, executionToken, {
    vendor_name: 'Gulf Electricals',
    total_amount: 1500,
  });
  assert.strictEqual(completeOk, true);

  const finalJob = await billStore.getBillExtraction(claimed.job_id);
  assert.strictEqual(finalJob.status, 'COMPLETED');
  assert.strictEqual(finalJob.lease_token, null);
  assert.strictEqual(finalJob.result.vendor_name, 'Gulf Electricals');
});

test('billStore: extraction job failure and retry handling', async (t) => {
  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();

  const messageId = 'wamid.fail-test-123';
  const workerPhone = '+971505554433';

  await billStore.enqueueBillExtraction({
    messageId,
    workerPhone,
    maxAttempts: 2,
  });

  // Attempt 1: claim and fail
  const claimed1 = await billStore.claimBillExtraction();
  assert.strictEqual(claimed1.attempts, 1);

  const fail1 = await billStore.failBillExtraction(claimed1.job_id, claimed1.lease_token, {
    error: 'OCR_UNREADABLE',
  });
  assert.strictEqual(fail1, true);

  const check1 = await billStore.getBillExtraction(claimed1.job_id);
  assert.strictEqual(check1.status, 'FAILED');
  assert.strictEqual(check1.last_error, 'OCR_UNREADABLE');

  // Attempt 2: retryable since attempts (1) < maxAttempts (2)
  const claimed2 = await billStore.claimBillExtraction();
  assert.ok(claimed2);
  assert.strictEqual(claimed2.job_id, claimed1.job_id);
  assert.strictEqual(claimed2.attempts, 2);

  // Fail attempt 2: reaches maxAttempts (2)
  await billStore.failBillExtraction(claimed2.job_id, claimed2.lease_token, {
    error: 'TIMEOUT',
  });

  // Attempt 3: no longer claimable because attempts (2) >= maxAttempts (2)
  const claimed3 = await billStore.claimBillExtraction();
  assert.strictEqual(claimed3, null);
});

test('billStore: complete isolation between Books and CRM leads collections', async (t) => {
  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();

  // Save a Bill
  const bill = await billStore.saveBill({
    worker_phone: '+971501110000',
    vendor_name: 'Isolated Vendor',
    total_amount: 300,
  });
  assert.ok(bill.bill_id);

  // Enqueue a Bill extraction
  const job = await billStore.enqueueBillExtraction({
    messageId: 'wamid.books-iso-1',
    workerPhone: '+971501110000',
  });
  assert.ok(job.job_id);

  // Create a Bill session
  const session = await billStore.createBillSession({
    worker_phone: '+971501110000',
    bill_id: bill.bill_id,
  });
  assert.ok(session.session_id);

  // Verify that CRM collections in the same database remain completely empty!
  const crmLeadsCount = await store.col('leads').countDocuments();
  const crmExtractionsCount = await store.col('lead_extractions').countDocuments();
  const crmSessionsCount = await store.col('lead_sessions').countDocuments();

  assert.strictEqual(crmLeadsCount, 0, 'CRM leads collection must remain empty');
  assert.strictEqual(crmExtractionsCount, 0, 'CRM lead_extractions collection must remain empty');
  assert.strictEqual(crmSessionsCount, 0, 'CRM lead_sessions collection must remain empty');

  // Verify Books collections have exactly the expected records
  const booksCount = await store.col('bills').countDocuments();
  const booksExtractionsCount = await store.col('bill_extractions').countDocuments();
  const booksSessionsCount = await store.col('bill_sessions').countDocuments();

  assert.strictEqual(booksCount, 1, 'bills collection must have exactly 1 record');
  assert.strictEqual(booksExtractionsCount, 1, 'bill_extractions collection must have exactly 1 record');
  assert.strictEqual(booksSessionsCount, 1, 'bill_sessions collection must have exactly 1 record');
});
