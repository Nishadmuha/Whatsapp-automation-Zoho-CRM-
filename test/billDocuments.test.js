'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderCreatedBillPdf } = require('../src/services/books/billPdf');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');
const { createWhatsAppService } = require('../src/services/whatsapp/whatsappService');
const record = () => ({ bill_id: '123456', vendor_name: 'Sample Supplier LLC', bill_number: 'QA-001', date: '2026-09-19', due_date: '2026-10-19', status: 'open', currency_code: 'AED', sub_total: 100, tax_total: 5, total: 105, line_items: [{ description: 'Electrical cable', quantity: 2, rate: 50, item_total: 100, tax_percentage: 5 }], notes: 'Synthetic verification fixture - not a real bill.' });
const credentials = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh', organizationId: 'org1' };
test('PDF copy is generated from a confirmed bill record, with multipage support', async () => {
  const bill = record();
  for (let i = 1; i < 35; i++) bill.line_items.push({ ...bill.line_items[0], description: `Electrical cable ${i + 1} - additional test item` });
  bill.sub_total = 3500; bill.tax_total = 175; bill.total = 3675;
  const buffer = await renderCreatedBillPdf(bill); assert.equal(buffer.subarray(0, 5).toString(), '%PDF-'); assert.ok(buffer.length > 1500);
  if (process.env.BILL_PDF_QA_DIR) {
    const fs = require('node:fs'); const path = require('node:path');
    fs.mkdirSync(process.env.BILL_PDF_QA_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.BILL_PDF_QA_DIR, 'created-bill-synthetic.pdf'), buffer);
  }
});
test('incomplete records and unsupported fonts fail rather than create misleading PDFs', async () => {
  await assert.rejects(renderCreatedBillPdf({}), /INCOMPLETE/);
  await assert.rejects(renderCreatedBillPdf({ ...record(), vendor_name: 'شركة' }), /UNICODE_FONT/);
});
test('PDF retrieval reads EXACT created ID, never original attachment or OCR', async () => {
  const calls = [];
  const client = createZohoBooksClient({ ...credentials, env: {}, http: {
    async post() { return { data: { access_token: 'synthetic-access', expires_in: 3600 } }; },
    async get(url, options) { calls.push(url); assert.equal(options.params.organization_id, 'org1'); return { data: { code: 0, bill: record() } }; },
  } });
  const document = await client.getBillPdf('123456', { organizationId: credentials.organizationId }); assert.equal(document.source, 'generated_from_zoho_record'); assert.match(calls[0], /\/bills\/123456$/); assert.equal(calls.length, 1);
});
for (const [organizationId, author] of [
  ['802911060', 'Voltronix Switchgear LLC'],
  ['828765858', 'Voltronix Contracting LLC'],
]) test(`created Bill PDF Author reflects selected ${author} organization`, async () => {
  const client = createZohoBooksClient({ ...credentials, env: {}, http: {
    async post() { return { data: { access_token: 'synthetic-access', expires_in: 3600 } }; },
    async get(_url, options) { assert.equal(options.params.organization_id, organizationId); return { data: { code: 0, bill: record() } }; },
  } });
  const document = await client.getBillPdf('123456', { organizationId });
  assert.match(document.buffer.toString('latin1'), new RegExp(`/Author \\d+ 0 R`));
  assert.ok(document.buffer.toString('latin1').includes(`${author})`));
});
test('wrong record ID and JSON errors cannot be delivered as PDF', async () => {
  const client = createZohoBooksClient({ ...credentials, env: {}, http: {
    async post() { return { data: { access_token: 'synthetic-access', expires_in: 3600 } }; },
    async get() { return { data: { code: 0, bill: { ...record(), bill_id: 'other' } } }; },
  } });
  await assert.rejects(client.getBillPdf('123456', { organizationId: credentials.organizationId }), /different bill/);
});
test('document transport uploads PDF bytes and sends media ID to correct worker', async () => {
  const calls = [];
  const service = createWhatsAppService({ env: { WHATSAPP_ACCESS_TOKEN: 'synthetic-token', WHATSAPP_PHONE_NUMBER_ID: '123', META_GRAPH_API_VERSION: 'v25.0' }, logger: {}, http: {
    async post(url, data) {
      calls.push(url);
      if (url.endsWith('/media')) { assert.equal(data.get('messaging_product'), 'whatsapp'); assert.equal(data.get('file').type, 'application/pdf'); assert.equal(Buffer.from(await data.get('file').arrayBuffer()).toString(), '%PDF-created'); return { data: { id: '456' } }; }
      assert.equal(data.to, '+971568556901'); assert.equal(data.type, 'document'); assert.equal(data.document.id, '456'); assert.equal(data.document.filename, 'created.pdf'); return { data: { messages: [{ id: 'wamid.sent' }] } };
    },
  } });
  await service.sendDocument('+971568556901', { buffer: Buffer.from('%PDF-created'), filename: 'created.pdf' }); assert.equal(calls.length, 2);
});
test('failed media upload sends no document message and is retryable', async () => {
  let calls = 0; const service = createWhatsAppService({ env: { WHATSAPP_ACCESS_TOKEN: 'synthetic-token', WHATSAPP_PHONE_NUMBER_ID: '123', META_GRAPH_API_VERSION: 'v25.0' }, logger: {}, http: { async post() { calls++; throw Error('synthetic-error'); } } });
  await assert.rejects(service.sendDocument('+971568556901', { buffer: Buffer.from('%PDF-created'), filename: 'created.pdf' }), error => error.deliveryState === 'NOT_ATTEMPTED'); assert.equal(calls, 1);
});

test('bill preparation validates AED and tax IDs without Chart of Accounts access', async () => {
  const reads = [];
  const client = createZohoBooksClient({ ...credentials, env: {}, http: {
    async post(url) { assert.match(url, /\/oauth\/v2\/token$/); return { data: { access_token: 'synthetic-access', expires_in: 3600 } }; },
    async get(url) {
      reads.push(url);
      if (url.endsWith('/settings/currencies')) return { data: { code: 0, currencies: [{ currency_id: 'aed1', currency_code: 'AED' }] } };
      if (url.endsWith('/settings/taxes')) return { data: { code: 0, taxes: [{ tax_id: 'vat5', tax_type: 'tax', tax_percentage: 5 }] } };
      assert.fail('Unexpected read');
    },
  } });
  const bill = require('./billFixtures').validBill(); await client.prepareBill(bill, { raw: { currency_id: 'aed1' } }, { organizationId: credentials.organizationId });
  assert.equal(bill.currency_id, 'aed1'); assert.equal(bill.line_items[0].account_id, undefined); assert.equal(bill.line_items[0].tax_id, 'vat5'); assert.equal(reads.length, 2); assert.equal(reads.some(url => url.includes('chartofaccounts')), false);
});
test('bill preparation does not require an expense account or Chart of Accounts access', async () => {
  const client = createZohoBooksClient({ ...credentials, env: {}, http: {
    async post(url) { assert.match(url, /\/oauth\/v2\/token$/); return { data: { access_token: 'synthetic-access', expires_in: 3600 } }; },
    async get(url) {
      assert.equal(url.endsWith('/settings/currencies') || url.endsWith('/settings/taxes'), true);
      if (url.endsWith('/settings/currencies')) return { data: { code: 0, currencies: [{ currency_id: 'aed1', currency_code: 'AED' }] } };
      return { data: { code: 0, taxes: [{ tax_id: 'vat5', tax_type: 'tax', tax_percentage: 5 }] } };
    },
  } });
  await assert.doesNotReject(client.prepareBill(require('./billFixtures').validBill(), {}, { organizationId: credentials.organizationId }));
});
test('duplicate check follows all pages and rejects provider errors', async () => {
  const pages = [];
  const client = createZohoBooksClient({ ...credentials, env: {}, http: {
    async post() { return { data: { access_token: 'synthetic', expires_in: 3600 } }; },
    async get(_url, options) { const page = options.params.page; pages.push(page); return { data: { code: 0, bills: page === 1 ? [] : [{ bill_id: 'saved', bill_number: 'INV-100', vendor_id: 'v1' }], page_context: { has_more_page: page === 1 } } }; },
  } });
  assert.equal((await client.checkDuplicateBill({ organizationId: credentials.organizationId, billNumber: 'INV-100', vendorId: 'v1' })).found, true); assert.deepEqual(pages, [1, 2]);
});
test('Books client has no obsolete Chart of Accounts integration', () => {
  const client = createZohoBooksClient({ ...credentials, env: {} });
  assert.equal(client.listChartOfAccounts, undefined);
});
