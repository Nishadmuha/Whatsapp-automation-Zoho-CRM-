'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { handleZohoSync } = require('../src/services/leads/bossLeadWorkflow');
const { createZohoLeadService } = require('../src/services/zoho/zohoLeadService');

const CRM_ID = '123456789012345';
const BASE_URL = 'https://www.zohoapis.com/crm/v8';
const CONTACT = { name: 'Sam Ali', company: 'Example LLC', phone: '+971501234567' };
const ORIGINAL = 'Please contact Sam about the enquiry.';
const DEFAULT_RECORD = {
  First_Name: 'Sam', Last_Name: 'Ali', Phone: CONTACT.phone, Company: CONTACT.company,
  Lead_Source: 'WhatsApp', Lead_Status: 'None', Description: `Original WhatsApp message:\n${ORIGINAL}`,
};

function setup({ source = 'boss', mapping, existing, storedId } = {}) {
  const lead = {
    id: 'local-lead', source, contact_name: CONTACT.name, company_name: CONTACT.company,
    phone: CONTACT.phone, original_message: ORIGINAL, attachments: [],
    ...(storedId ? { zoho_lead_id: storedId } : {}),
  };
  let crmRecord = existing ? structuredClone(existing) : null;
  const calls = [];
  const store = {
    async getLead() { return structuredClone(lead); },
    async updateLeadZohoStatus(_id, values) {
      const fields = { zohoStatus: 'zoho_status', zohoLeadId: 'zoho_lead_id', zohoUrl: 'zoho_url' };
      for (const [key, value] of Object.entries(values)) lead[fields[key] || key] = value;
    },
  };
  const zoho = createZohoLeadService({
    env: { ZOHO_API_BASE_URL: BASE_URL, ...(mapping ? { ZOHO_FIELD_MAPPING: JSON.stringify(mapping) } : {}) },
    auth: { async getAccessToken() { return 'test-token'; } },
    http: {
      async request(request) {
        calls.push(request);
        const route = `${request.method} ${request.url.slice(BASE_URL.length)}`;
        if (route === 'GET /Leads/search') {
          return crmRecord ? { status: 200, data: { data: [structuredClone(crmRecord)] } } : { status: 204 };
        }
        if (route === `GET /Leads/${CRM_ID}`) {
          return { status: 200, data: { data: [structuredClone(crmRecord)] } };
        }
        assert.ok(['POST /Leads', `PUT /Leads/${CRM_ID}`].includes(route), `Unexpected CRM action: ${route}`);
        crmRecord = { ...crmRecord, ...request.data.data[0], id: CRM_ID };
        return { status: 200, data: { data: [{ status: 'success', code: 'SUCCESS', details: { id: CRM_ID } }] } };
      },
    },
  });
  return {
    lead, calls, zoho, record: () => crmRecord,
    sync: () => handleZohoSync({ leadId: lead.id, store, zoho, config: {} }),
  };
}

test('only new boss leads use the empty Blueprint initial state', async () => {
  for (const source of ['boss', 'client', 'WhatsApp', null]) {
    const f = setup({ source });
    if (source === null) delete f.lead.source;
    assert.equal((await f.sync()).success, true, `source: ${source}`);
    assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST']);
    assert.deepEqual(f.calls[1].data, {
      data: [{ ...DEFAULT_RECORD, Lead_Status: source === 'boss' ? null : 'None' }],
    });
    assert.equal(f.lead.zoho_status, 'saved');
    assert.equal(f.lead.zoho_lead_id, CRM_ID);
  }
});

test('the shared create API retains its default HTTP payload', async () => {
  const f = setup();
  await f.zoho.createLead(CONTACT, ORIGINAL);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'POST');
  assert.deepEqual(f.calls[0].data, { data: [DEFAULT_RECORD] });
});

test('boss Blueprint enrollment honors custom and disabled status mappings', async () => {
  for (const statusField of ['Custom_Lead_Status', null]) {
    const f = setup({ mapping: { leadStatus: statusField } });
    assert.equal((await f.sync()).success, true);
    const expected = { ...DEFAULT_RECORD };
    delete expected.Lead_Status;
    if (statusField) expected[statusField] = null;
    assert.deepEqual(f.calls.at(-1).data, { data: [expected] });
    assert.equal(Object.hasOwn(f.record(), 'Lead_Status'), false);
    assert.equal(Object.hasOwn(f.record(), 'null'), false);
  }
});

test('duplicate and stored-ID updates preserve CRM status, owner and department', async () => {
  for (const storedId of [undefined, CRM_ID]) {
    for (const statusField of ['Lead_Status', 'Custom_Lead_Status']) {
      const existing = {
        id: CRM_ID, Phone: CONTACT.phone, [statusField]: 'Pre-Qualified',
        Owner: { id: '99887766', name: 'Existing Owner' }, Assign_Department: 'Existing Department',
      };
      const f = setup({ storedId, existing, mapping: { leadStatus: statusField } });
      assert.equal((await f.sync()).success, true);
      assert.deepEqual(f.calls.map(call => `${call.method} ${call.url.slice(BASE_URL.length)}`), [
        ...(!storedId ? ['GET /Leads/search'] : []), `GET /Leads/${CRM_ID}`, `PUT /Leads/${CRM_ID}`,
      ]);
      const update = f.calls.at(-1).data.data[0];
      for (const field of [statusField, 'Owner', 'Assign_Department']) {
        assert.equal(Object.hasOwn(update, field), false, `must not overwrite ${field}`);
        assert.deepEqual(f.record()[field], existing[field]);
      }
      assert.equal(f.lead.zoho_lead_id, CRM_ID);
    }
  }
});

test('syncing an already saved boss lead performs no additional CRM action', async () => {
  const f = setup();
  const first = await f.sync();
  assert.equal(first.success, true);
  const requestCount = f.calls.length;
  const second = await f.sync();
  assert.equal(second.success, true);
  assert.equal(second.zohoLeadId, first.zohoLeadId);
  assert.equal(f.calls.length, requestCount);
});
