'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, validBill } = require('./billFixtures');
const { resolveOrganization, findOrganizationsInText, BOOKS_ORGANIZATIONS } = require('../src/services/books/organizations');
const { computeGrounding, createBillExtractionService } = require('../src/services/ai/billExtractionService');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');
const { temporaryStore } = require('./helpers');
const { createBillStore } = require('../src/database/billStore');
const { readConfig } = require('../src/config/env');

test('Books organization IDs come from separate configuration keys and reject missing or duplicate IDs only when enabled', () => {
  const base = { WEBHOOK_VERIFY_TOKEN: 'test-token', META_APP_SECRET: 'test-secret', AUTOMATION_ENABLED: 'true', AI_PROVIDER: 'openai',
    AUTHORIZED_BOOKS_PHONES: '+971501234567', WHATSAPP_ACCESS_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '123456789', META_GRAPH_API_VERSION: 'v25.0' };
  const ids = { ZOHO_BOOKS_SWITCHGEAR_ORG_ID: '123456', ZOHO_BOOKS_CONTRACTING_ORG_ID: '654321' };
  assert.deepEqual(readConfig({ ...base, ...ids }).booksOrganizationIds, { switchgear: '123456', contracting: '654321' });
  assert.throws(() => readConfig({ ...base, ...ids, ZOHO_BOOKS_SWITCHGEAR_ORG_ID: '' }), /ZOHO_BOOKS_SWITCHGEAR_ORG_ID/);
  assert.throws(() => readConfig({ ...base, ...ids, ZOHO_BOOKS_CONTRACTING_ORG_ID: '123456' }), /distinct numeric/);
  assert.doesNotThrow(() => readConfig({ ...base, ...ids, AUTOMATION_ENABLED: 'false', ZOHO_BOOKS_SWITCHGEAR_ORG_ID: '' }));
});

for (const [name, organizationId, label] of [
  ['Switchgear', '802911060', 'Voltronix Switchgear LLC'],
  ['Contracting', '828765858', 'Voltronix Contracting LLC'],
]) test(`${name} customer selection displays only its organization label without changing lookup scope`, async () => {
  const scopes = [];
  const f = fixture({ bill: { ...validBill(), organization: resolveOrganization({ organizationId }) }, zohoOverrides: {
    async searchCustomer({ organizationId: scope }) { scopes.push(scope); return [{ contactId: 'customer-1', contactName: 'Customer One' }]; },
  } });
  const first = await f.send('invoice');
  assert.equal(first.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal(first.replyInteractive.footer, label);
  assert.deepEqual(scopes, [organizationId]);
});

function mockedExtraction(organization = null, overrides = {}) {
  const bill = { ...validBill() };
  delete bill.customer_details;
  return createBillExtractionService({
    env: { OPENAI_API_KEY: 'synthetic-test-key', OPENAI_MODEL: 'gpt-4o-mini' },
    http: { async post() {
      return { status: 200, data: { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify({ bill: { ...bill, organization, ...overrides }, confidence: {} }) }],
      }] } };
    } },
  });
}

for (const [text, id] of [
  ['VOLTRONIX CONTRACTING LLC', '828765858'],
  ['Voltronix  Contracting L.L.C.', '828765858'],
  ['VOLTRONIX SWITCHGEAR LLC', '802911060'],
  ['Voltronix\nSwitchgear L. L. C.', '802911060'],
]) test(`invoice text ${text.replace(/\n/g, ' ')} determines organization ${id} independently of model guesses`, async () => {
  const wrong = BOOKS_ORGANIZATIONS.find(org => org.organizationId !== id);
  const service = mockedExtraction({ name: wrong.name, organizationId: wrong.organizationId, confidence: 1 });
  const result = await service.extractBillFromText({ text: `Supplier LLC TAX INVOICE INV-100\nBill to: ${text}\n2026-09-19 Cable 2 50 100 VAT 5 Total 105 AED` });
  assert.equal(result.success, true);
  assert.equal(result.bill.organization.organizationId, id);
  assert.equal(result.grounding.organization, 'explicit');
});

for (const text of [
  'Supplier LLC invoice for another company in Dubai. TRN 123456789012345',
  'VOLTRONIX CONTRACTING LLC and VOLTRONIX SWITCHGEAR LLC',
  'NOTVOLTRONIX CONTRACTING LLC', 'VOLTRONIX CONTRACTINGSERVICES LLC', 'VOLTRONIX SWITCHGEAR LLCOTHER',
]) test(`missing/ambiguous/lookalike invoice text never trusts a model default: ${text}`, async () => {
  const result = await mockedExtraction({ name: 'VOLTRONIX SWITCHGEAR LLC', organizationId: '802911060', confidence: 1 },
    { vendor_name: 'VOLTRONIX SWITCHGEAR LLC' }).extractBillFromText({ text });
  assert.equal(result.success, true);
  assert.equal(result.bill.organization, null, 'Do not infer routing from extracted vendor fields or default IDs.');
});

test('name detection is boundary-aware and conflicting or unsupported organization IDs fail closed', () => {
  assert.equal(findOrganizationsInText('VOLTRONIX CONTRACTING LLC / VOLTRONIX SWITCHGEAR LLC').length, 2);
  assert.equal(resolveOrganization({ name: 'VOLTRONIX CONTRACTING LLC', organizationId: 'wrong-id' }), null);
  assert.equal(resolveOrganization({ name: 'Unrelated Company', organizationId: '828765858' }), null);
});

test('organization names and OCR punctuation normalize only to the supported Books organizations', () => {
  assert.equal(resolveOrganization('voltronix contracting l.l.c.').organizationId, '828765858');
  assert.equal(resolveOrganization({ name: 'VOLTRONIX SWITCHGEAR LLC' }).organizationId, '802911060');
  assert.equal(resolveOrganization({ name: 'VOLTRONIX CONTRACTING LLC', organizationId: '802911060' }), null);
  assert.equal(resolveOrganization('unrelated company'), null);
});

test('invoice organization grounding marks visible company evidence explicit and conflicting companies ambiguous', () => {
  const bill = { organization: { name: 'VOLTRONIX CONTRACTING LLC', organizationId: '828765858' } };
  assert.equal(computeGrounding(bill, 'Invoice issued by VOLTRONIX CONTRACTING LLC').organization, 'explicit');
  assert.equal(computeGrounding(bill, 'VOLTRONIX CONTRACTING LLC / VOLTRONIX SWITCHGEAR LLC').organization, 'ambiguous');
});

test('Zoho Books client requires a per-request organization and ignores the configured default', async () => {
  const requests = [];
  const client = createZohoBooksClient({
    env: {}, clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', organizationId: 'default-org',
    http: {
      async post(url, payload, options) {
        requests.push(['POST', url, options?.params?.organization_id]);
        if (url.endsWith('/oauth/v2/token')) return { data: { access_token: 'token', expires_in: 3600 } };
        return { data: { code: 0, bill: { bill_id: 'bill-1' } } };
      },
      async get(url, options) {
        requests.push(['GET', url, options?.params?.organization_id]);
        if (url.endsWith('/contacts')) return { data: { code: 0, contacts: [] } };
        throw new Error(`unexpected GET ${url}`);
      },
    },
  });
  await client.searchCustomer({ organizationId: '802911060' });
  await client.createBill({ organizationId: '828765858', vendorId: 'vendor', billNumber: 'INV-1', billDate: '2026-09-19', lineItems: [{ name: 'Cable', quantity: 1, rate: 10 }] });
  assert.deepEqual(requests.filter(request => request[1].endsWith('/contacts'))[0], ['GET', 'https://www.zohoapis.com/books/v3/contacts', '802911060']);
  assert.deepEqual(requests.find(request => request[1].endsWith('/bills')), ['POST', 'https://www.zohoapis.com/books/v3/bills', '828765858']);
  assert.throws(() => client.buildZohoBillUrl('bill-1'), { code: 'ZOHO_BOOKS_CONFIG_ERROR' });
  assert.equal(client.buildZohoBillUrl('bill-1', '802911060'), 'https://books.zoho.com/app/802911060#/bills/bill-1');
});

for (const organization of [
  { name: 'VOLTRONIX CONTRACTING LLC', organizationId: '828765858' },
  { name: 'VOLTRONIX SWITCHGEAR LLC', organizationId: '802911060' },
]) test(`SAVE routes vendor, duplicate check, preparation and creation to ${organization.name}`, async () => {
  const routed = [];
  const f = fixture({
    bill: { ...validBill(), organization: { ...organization, confidence: 1 } },
    zohoOverrides: {
      async searchVendor(input) { routed.push(['vendor', input.organizationId]); return [{ id: 'vendor-1', name: 'Supplier LLC' }]; },
      async checkDuplicateBill(input) { routed.push(['duplicate', input.organizationId]); return { found: false }; },
      async prepareBill(_bill, _vendor, input) { routed.push(['prepare', input.organizationId]); },
      async createBill(input) { routed.push(['create', input.organizationId]); return { id: 'bill-1' }; },
      buildZohoBillUrl(_id, organizationId) { routed.push(['url', organizationId]); return `https://books.example/${organizationId}`; },
    },
  });

  const first = await f.send('invoice');
  assert.equal(first.state, 'AWAITING_FINAL_CONFIRMATION');
  await f.send('SAVE');
  assert.deepEqual(routed.slice(0, 5), [
    ['vendor', organization.organizationId],
    ['vendor', organization.organizationId],
    ['duplicate', organization.organizationId],
    ['prepare', organization.organizationId],
    ['create', organization.organizationId],
  ]);
  assert.equal((await f.billStore.getBill(first.billId)).organization.organizationId, organization.organizationId);
});

test('missing organization prompts for selection and persists the selected organization', async () => {
  const f = fixture({ bill: { ...validBill(), organization: null } });
  const first = await f.send('invoice');
  assert.equal(first.state, 'WAITING_FOR_ORGANIZATION');
  assert.match(first.replyText, /Organization could not be clearly detected/);
  const selected = await f.send('1');
  assert.equal(selected.bill.organization.organizationId, '802911060');
  assert.equal((await f.billStore.getBillSession(first.sessionId)).bill_data.organization.organizationId, '802911060');
});

test('customer lookup and bill creation share the selected organization scope', async () => {
  const scoped = [];
  const customer = { contactId: 'customer-1', contactName: 'Contact', companyName: 'Company', status: 'active' };
  const f = fixture({
    bill: { ...validBill(), organization: { name: 'VOLTRONIX SWITCHGEAR LLC', organizationId: '802911060', confidence: 1 }, customer_details: null },
    zohoOverrides: {
      async searchCustomer(input) { scoped.push(['search', input.organizationId]); return [customer]; },
      async getCustomer(_id, input) { scoped.push(['get', input.organizationId]); return customer; },
      async createBill(input) { scoped.push(['create', input.organizationId]); return { id: 'bill-2' }; },
    },
  });
  const first = await f.send('invoice');
  assert.equal(first.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  await f.send('1');
  await f.send('SAVE');
  assert.deepEqual(scoped, [['search', '802911060'], ['get', '802911060'], ['create', '802911060']]);
});

test('cross-organization customer state is rejected before bill creation', async () => {
  let creates = 0;
  const f = fixture({ zohoOverrides: {
    async searchCustomer() { return []; },
    async createBill() { creates += 1; return { id: 'should-not-create' }; },
  } });
  const first = await f.send('invoice');
  const session = await f.billStore.getBillSession(first.sessionId);
  session.bill_data.customer_details.organization_id = '802911060';
  await f.billStore.updateBillSession(first.sessionId, { bill_data: session.bill_data });
  const result = await f.send('SAVE');
  assert.match(result.replyText, /does not belong/);
  assert.equal(creates, 0);
});

test('EDIT changes organization and DELETE clears an organization-pending bill', async () => {
  const edited = fixture();
  await edited.send('invoice');
  await edited.send('EDIT');
  const changed = await edited.send('organization: VOLTRONIX SWITCHGEAR LLC');
  assert.equal(changed.bill.organization.organizationId, '802911060');

  const deleted = fixture({ bill: { ...validBill(), organization: null } });
  const pending = await deleted.send('invoice');
  await deleted.send('DELETE');
  const session = await deleted.billStore.getBillSession(pending.sessionId);
  assert.equal(session.state, 'CANCELLED');
  assert.deepEqual(session.bill_data, {});
  assert.deepEqual(session.customer_options, []);
  assert.equal((await deleted.billStore.getBill(pending.billId)).organization, null);
  assert.equal((await deleted.billStore.getBill(pending.billId)).currency, null);
});

test('no Books operation may silently use the old global Switchgear organization', async () => {
  const calls = [];
  const client = createZohoBooksClient({
    env: { ZOHO_BOOKS_ORGANIZATION_ID: '802911060' },
    clientId: 'fixture', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh', organizationId: '802911060',
    http: { async post() { calls.push('POST'); throw Error('No HTTP expected'); }, async get() { calls.push('GET'); throw Error('No HTTP expected'); } },
  });
  for (const operation of [
    () => client.searchCustomer(), () => client.getCustomer('customer-1'),
    () => client.searchVendor({ name: 'Supplier LLC' }),
    () => client.checkDuplicateBill({ billNumber: 'INV-100' }),
    () => client.prepareBill(validBill(), {}),
    () => client.createBill({ vendorId: 'vendor', billNumber: 'INV-100', billDate: '2026-09-19', lineItems: [{ quantity: 1, rate: 10 }] }),
    () => client.attachBillFile({ billId: 'bill-1', buffer: Buffer.from('invoice'), filename: 'invoice.jpg' }),
    () => client.getBillPdf('bill-1'),
  ]) await assert.rejects(operation, { code: 'ZOHO_BOOKS_CONFIG_ERROR' });
  assert.deepEqual(calls, []);
});

for (const organization of BOOKS_ORGANIZATIONS) {
  test(`${organization.name}: missing organization blocks SAVE, worker choice persists and continues currency/customer flow`, async () => {
    const scoped = [];
    const f = fixture({ bill: { ...validBill(), organization: null, currency: null, customer_details: null }, zohoOverrides: {
      async searchCustomer({ organizationId }) { scoped.push(organizationId); return [{ contactId: 'customer', contactName: 'Selected Customer' }]; },
    } });
    const first = await f.send('invoice');
    assert.match(first.replyText, /Please select the bill organization:\n\n1\. VOLTRONIX SWITCHGEAR LLC\n2\. VOLTRONIX CONTRACTING LLC/);
    await f.send('1 SAVE');
    assert.equal((await f.billStore.getBillSession(first.sessionId)).state, 'WAITING_FOR_ORGANIZATION');
    assert.deepEqual(scoped, []);
    assert.equal(f.calls.some(call => call[0] === 'create'), false);
    const selected = await f.send(organization.organizationId === '802911060' ? '1' : '2');
    assert.equal(selected.state, 'WAITING_FOR_CURRENCY');
    assert.match(selected.replyText, /Currency not detected/);
    assert.equal((await f.billStore.getBill(first.billId)).organization.organizationId, organization.organizationId);
    await f.send('usd');
    assert.deepEqual(scoped, [organization.organizationId]);
    await f.send('1');
    await f.send('1 SAVE');
    const created = f.calls.find(call => call[0] === 'create')[1];
    assert.equal(created.organizationId, organization.organizationId);
    assert.equal(created.currency, 'USD');
    assert.equal(created.customerId, 'customer');
  });

  test(`${organization.name}: EDIT invalidates a previously selected customer and organization-specific IDs`, async () => {
    const other = BOOKS_ORGANIZATIONS.find(org => org.organizationId !== organization.organizationId);
    const lookups = [];
    const f = fixture({ bill: { ...validBill(), organization: resolveOrganization(organization), customer_details: null }, zohoOverrides: {
      async searchCustomer({ organizationId }) { lookups.push(organizationId); return [{ contactId: `customer-${organizationId}`, contactName: 'Company Contact' }]; },
      async searchVendor({ organizationId }) { return [{ id: `vendor-${organizationId}`, name: 'Supplier LLC', organizationId }]; },
    } });
    const first = await f.send('invoice');
    await f.send('1');
    const session = await f.billStore.getBillSession(first.sessionId);
    session.bill_data.currency_id = 'old-currency-id';
    session.bill_data.zoho_vendor_id = 'old-vendor-id';
    session.bill_data.line_items[0].tax_id = 'old-tax-id';
    assert.equal(session.bill_data.customer_details.organization_id, organization.organizationId);
    await f.send('EDIT');
    const changed = await f.send(`organization: ${other.name}`);
    assert.equal(changed.state, 'WAITING_FOR_CUSTOMER_SELECTION');
    assert.equal(changed.bill.customer_details, null);
    assert.equal(changed.bill.currency_id, null);
    assert.equal(changed.bill.zoho_vendor_id, `vendor-${other.organizationId}`, 'The vendor is re-resolved in the newly selected organization.');
    assert.equal(changed.bill.line_items[0].tax_id, undefined);
    assert.equal(changed.bill.currency, 'AED');
    assert.equal(changed.bill.payment_type, 'Credit Card');
    assert.deepEqual(lookups, [organization.organizationId, other.organizationId]);
    await f.send('Choose stale contact', { interactiveId: `zoho-customer:customer-${organization.organizationId}` });
    await f.send('1 SAVE');
    assert.equal(f.calls.some(call => call[0] === 'create'), false);
    await f.send('1');
    await f.send('1 SAVE');
    const created = f.calls.find(call => call[0] === 'create')[1];
    assert.equal(created.organizationId, other.organizationId);
    assert.equal(created.customerId, `customer-${other.organizationId}`);
  });

  test(`${organization.name}: mismatched and unscoped legacy customer IDs cannot be saved`, async () => {
    for (const scope of [undefined, BOOKS_ORGANIZATIONS.find(org => org.organizationId !== organization.organizationId).organizationId]) {
      const f = fixture({ bill: { ...validBill(), organization: resolveOrganization(organization) }, zohoOverrides: {
        async searchCustomer() { return [{ contactId: 'correct-customer', contactName: 'Correct Contact' }]; },
      } });
      const first = await f.send('invoice');
      const session = await f.billStore.getBillSession(first.sessionId);
      session.bill_data.customer_details = { contact_id: 'wrong-customer', customer_name: 'Wrong Contact', organization_id: scope };
      const saved = await f.send('1 SAVE');
      assert.match(saved.replyText, /does not belong/);
      assert.equal(f.calls.some(call => call[0] === 'create'), false);
      assert.equal((await f.billStore.getBill(first.billId)).customer_details, null);
    }
  });
}

test('ambiguous extraction asks the worker; an unrelated EDIT cannot silently change organization', async () => {
  const f = fixture({ extractionOverrides: {
    async extractBillFromText() { return { success: true, bill: validBill(), grounding: { organization: 'ambiguous' } }; },
    async applyEditInstructions({ currentBill }) { return { success: true, bill: { ...currentBill, organization: resolveOrganization(BOOKS_ORGANIZATIONS[1]), notes: 'Corrected notes' } }; },
  } });
  const first = await f.send('invoice');
  assert.equal(first.state, 'WAITING_FOR_ORGANIZATION');
  await f.send('SAVE');
  assert.equal(f.calls.some(call => call[0] === 'create'), false);
  await f.send('2');
  await f.send('EDIT');
  const corrected = await f.send('Correct the notes');
  assert.equal(corrected.bill.organization.organizationId, '828765858');
  assert.equal(corrected.bill.notes, 'Corrected notes');
});

test('customer and vendor responses explicitly scoped to another organization are refused', async () => {
  const f = fixture({ zohoOverrides: {
    async searchCustomer() { return [{ contactId: 'customer', contactName: 'Contact' }]; },
    async getCustomer() { return { contactId: 'customer', contactName: 'Contact', organization_id: '802911060' }; },
  } });
  const first = await f.send('invoice');
  const selection = await f.send('1');
  assert.match(selection.replyText, /could not be verified/);
  assert.equal((await f.billStore.getBill(first.billId)).customer_details.contact_id, undefined);
  const vendor = fixture({ zohoOverrides: { async searchVendor() { return [{ id: 'wrong-vendor', name: 'Supplier LLC', organization_id: '802911060' }]; } } });
  await vendor.send('invoice');
  assert.match((await vendor.send('SAVE')).replyText, /Vendor does not belong/);
  assert.equal(vendor.calls.some(call => call[0] === 'create'), false);
});

test('EDIT with new invoice evidence changes organization; ambiguous new evidence requires selection', async () => {
  const f = fixture();
  await f.send('invoice');
  await f.send('EDIT');
  let result = await f.send('Bill to: VOLTRONIX SWITCHGEAR L.L.C.');
  assert.equal(result.bill.organization.organizationId, '802911060');
  await f.send('EDIT');
  result = await f.send('Bill to VOLTRONIX CONTRACTING LLC / VOLTRONIX SWITCHGEAR LLC');
  assert.equal(result.state, 'WAITING_FOR_ORGANIZATION');
  assert.equal(result.bill.organization, null);
  assert.equal(f.calls.some(call => call[0] === 'create'), false);
});

test('direct image extraction can identify organization when OCR is unavailable', async () => {
  const service = mockedExtraction({ name: 'Voltronix Switchgear L.L.C.', organizationId: '802911060', confidence: 0.98 });
  const f = fixture({ extractionOverrides: service, aiOverrides: { async extractMediaText() { throw Error('Synthetic OCR outage'); } } });
  const result = await f.send('', { messageType: 'image', mediaId: 'invoice' });
  assert.equal(result.bill.organization.organizationId, '802911060');
  assert.equal(result.state, 'WAITING_FOR_ADDITIONAL_INFO');
  assert.doesNotMatch(result.replyText, /BILL DETAILS|1 SAVE/);
});

test('DELETE clears a selected organization, customer IDs and options from both pending records', async () => {
  const f = fixture({ zohoOverrides: { async searchCustomer() { return [{ contactId: 'selected', contactName: 'Selected Contact' }]; } } });
  const first = await f.send('invoice');
  await f.send('1');
  await f.send('3 DELETE');
  const record = await f.billStore.getBill(first.billId);
  const session = await f.billStore.getBillSession(first.sessionId);
  assert.equal(record.organization, null);
  assert.equal(record.customer_details, null);
  assert.equal(record.currency, null);
  assert.equal(session.state, 'CANCELLED');
  assert.deepEqual(session.bill_data, {});
  assert.deepEqual(session.customer_options, []);
});

test('an already-created bill without a saved organization cannot retry in a different draft organization', async () => {
  const f = fixture();
  const first = await f.send('invoice');
  await f.billStore.updateBill(first.billId, { zoho_bill_id: 'legacy-created', organization: null });
  const result = await f.send('SAVE');
  assert.match(result.replyText, /saved organization is missing/);
  assert.equal(f.calls.some(call => ['create', 'attach', 'pdf'].includes(call[0])), false);
});

for (const organization of BOOKS_ORGANIZATIONS) {
  test(`${organization.name}: real extraction/workflow/store/client adapters keep one organization through create, attachment and PDF retry (mocked HTTP)`, async t => {
    const { store } = await temporaryStore(t);
    const billStore = createBillStore({ store });
    await billStore.init();
    const orgId = organization.organizationId;
    const other = BOOKS_ORGANIZATIONS.find(org => org.organizationId !== orgId);
    const requests = [];
    let createdRecord;
    let pdfReads = 0;
    const contact = { contact_id: `customer-${orgId}`, contact_name: 'Site Contact', company_name: 'Project Customer',
      phone: '+971501112233', email: 'contact@example.invalid', organization_id: orgId, contact_type: 'customer', status: 'active' };
    const client = createZohoBooksClient({
      // A conflicting legacy global value must not affect any selected scope.
      env: { ZOHO_BOOKS_ORGANIZATION_ID: other.organizationId },
      clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh',
      http: {
        async post(url, payload, options) {
          if (url.endsWith('/oauth/v2/token')) return { data: { access_token: 'synthetic-access', expires_in: 3600 } };
          requests.push({ method: 'POST', url, organizationId: options.params.organization_id });
          assert.equal(options.params.organization_id, orgId);
          if (url.endsWith('/bills')) {
            assert.equal(payload.vendor_id, `vendor-${orgId}`);
            assert.equal(payload.customer_id, contact.contact_id);
            assert.equal(payload.currency_id, `currency-${orgId}`);
            assert.equal(payload.line_items[0].tax_id, `tax-${orgId}`);
            assert.equal(payload.line_items[0].account_id, undefined);
            assert.match(payload.notes, /Payment method: Bank Transfer/);
            createdRecord = { ...payload, bill_id: `saved-${orgId}`, vendor_name: 'Supplier LLC', currency_code: 'AED',
              sub_total: 100, tax_total: 5, total: 105 };
            return { data: { code: 0, bill: createdRecord } };
          }
          assert.ok(url.endsWith(`/bills/saved-${orgId}/attachment`));
          const saved = (await billStore.listBills()).items[0];
          assert.equal(saved.zoho_bill_id, `saved-${orgId}`);
          assert.equal(saved.organization.organizationId, orgId);
          assert.equal(Buffer.from(await payload.get('attachment').arrayBuffer()).toString(), 'original-image');
          return { data: { code: 0, attachment_id: `attachment-${orgId}` } };
        },
        async get(url, options) {
          requests.push({ method: 'GET', url, organizationId: options.params.organization_id, page: options.params.page, contactType: options.params.contact_type });
          assert.equal(options.params.organization_id, orgId);
          if (url.endsWith('/contacts') && options.params.contact_type === 'customer') {
            return { data: { code: 0, contacts: options.params.page === 1 ? [] : [contact], page_context: { has_more_page: options.params.page === 1 } } };
          }
          if (url.endsWith(`/contacts/${contact.contact_id}`)) return { data: { code: 0, contact } };
          if (url.endsWith('/contacts')) return { data: { code: 0, contacts: [{ contact_id: `vendor-${orgId}`, contact_name: 'Supplier LLC' }] } };
          if (url.endsWith('/bills')) return { data: { code: 0, bills: [] } };
          if (url.endsWith('/settings/currencies')) return { data: { code: 0, currencies: [{ currency_id: `currency-${orgId}`, currency_code: 'AED' }] } };
          if (url.endsWith('/settings/taxes')) return { data: { code: 0, taxes: [{ tax_id: `tax-${orgId}`, tax_percentage: 5, tax_type: 'tax' }] } };
          assert.ok(url.endsWith(`/bills/saved-${orgId}`));
          pdfReads++;
          if (pdfReads === 1) throw Error('Synthetic PDF read outage');
          return { data: { code: 0, bill: createdRecord } };
        },
      },
    });
    const extraction = mockedExtraction(null, { currency: null, payment_type: null });
    const f = fixture({ billStore, zohoOverrides: client, extractionOverrides: extraction, aiOverrides: {
      async extractMediaText() { return `Supplier LLC TAX INVOICE INV-100\nBill to: ${organization.name.replace('LLC', 'L.L.C.')}\n2026-09-19 Cable 2 50 100 VAT 5 Total 105`; },
    } });
    const first = await f.send('', { messageType: 'image', mediaId: 'original-invoice' });
    assert.equal(first.state, 'WAITING_FOR_CURRENCY');
    assert.equal(first.bill.organization.organizationId, orgId);
    await f.send('1 SAVE');
    assert.equal(requests.length, 0, 'No API operation before required currency and organization are known.');
    const currency = await f.send('aed');
    assert.equal(currency.state, 'WAITING_FOR_CUSTOMER_SELECTION');
    assert.equal(currency.bill.currency, 'AED');
    assert.doesNotMatch(currency.replyText, /BILL DETAILS|1 SAVE/);
    assert.equal((await billStore.getBill(first.billId)).currency, 'AED');
    assert.equal((await billStore.getBillSession(first.sessionId)).bill_data.currency, 'AED');
    await f.send('1');
    assert.equal((await billStore.getBill(first.billId)).customer_details.organization_id, orgId);
    assert.equal((await billStore.getBill(first.billId)).customer_details.customer_email, contact.email);
    await f.send('Bank Transfer');
    const result = await f.send('1 SAVE');
    assert.match(result.replyText, /PDF could not be retrieved/);
    assert.match(result.replyText, new RegExp(`/app/${orgId}#`));
    const saved = await billStore.getBill(first.billId);
    assert.equal(saved.zoho_bill_id, `saved-${orgId}`);
    assert.equal(saved.attachments[0].zoho_upload_status, 'uploaded');
    // Once created, the persisted bill's scope is authoritative even if draft
    // data is stale. A PDF retry must never re-create or change organizations.
    const session = await billStore.getBillSession(first.sessionId);
    await billStore.updateBillSession(first.sessionId, { bill_data: { ...session.bill_data, organization: resolveOrganization(other) } });
    const retried = await f.send('SAVE');
    assert.equal(retried.state, 'COMPLETED');
    assert.equal(requests.filter(r => r.method === 'POST' && r.url.endsWith('/bills')).length, 1);
    assert.equal(requests.filter(r => r.url.endsWith('/attachment')).length, 1);
    assert.equal(requests.every(r => r.organizationId === orgId), true);
    assert.deepEqual(requests.filter(r => r.url.endsWith('/contacts') && r.contactType === 'customer').map(r => r.page), [1, 2]);
    assert.ok(requests.some(r => r.url.endsWith('/contacts') && r.contactType === 'vendor' && r.page === 1));
    const document = f.calls.find(call => call[0] === 'document')[2];
    assert.equal(document.buffer.subarray(0, 5).toString(), '%PDF-');
    assert.equal(await billStore.getActiveBillSession(require('./billFixtures').WORKER), null);
  });
}
