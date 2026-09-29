'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createZohoBooksClient, ZohoBooksError } = require('../src/services/books/zohoBooksClient');
const { createLogger } = require('../src/utils/logger');
const { fixture } = require('./billFixtures');

// Most provider fixtures are synthetic. The 400/13009 regressions reproduce
// the safe response captured from production on 2026-09-28, without live writes.
const input = {
  vendorId: 'private-vendor-id', billNumber: 'PRIVATE-INV-100',
  billDate: '2026-09-28', organizationId: 'private-organization-id',
  lineItems: [{ description: 'Private purchased product', quantity: 2, rate: 50 }],
};
function harness(respond, logger) {
  const events = [], posts = [], tokens = [];
  const client = createZohoBooksClient({
    env: { UNRELATED_API_KEY: 'private-other-api-key' },
    clientId: 'private-client', clientSecret: 'private-client-secret', refreshToken: 'private-refresh-token',
    logger: logger || { error: event => events.push(event) },
    http: { async post(url, payload, options) {
      if (url.endsWith('/oauth/v2/token')) {
        const token = `private-access-token-${tokens.length + 1}`;
        tokens.push(token);
        return { status: 200, data: { access_token: token, expires_in: 3600 } };
      }
      posts.push({ url, payload, options });
      return respond(posts.length);
    } },
  });
  return { client, events, posts, tokens };
}
function rejected(status, code, message) {
  return Object.assign(new Error('private transport error'), {
    response: { status, data: { code, message, extra: 'private response field' } },
    config: { headers: { Authorization: 'private authorization header' } },
  });
}
function expected(status, code, message) {
  return { event: 'zoho.books.bill_create_failed', httpStatus: status, providerCode: code,
    providerMessage: message, operation: 'createBill', method: 'POST', endpoint: '/bills' };
}

test('bill rejection retains the exact safe provider message and only diagnostic fields', async () => {
  const message = 'Please enter a valid bill number.';
  const h = harness(() => { throw rejected(400, 36004, message); });
  await assert.rejects(h.client.createBill(input), error => {
    assert.ok(error instanceof ZohoBooksError);
    assert.equal(error.code, 'ZOHO_BOOKS_API_ERROR');
    assert.equal(error.httpStatus, 400);
    assert.equal(error.providerCode, 36004);
    assert.equal(error.providerMessage, message);
    assert.equal(error.operation, 'createBill');
    assert.equal(error.method, 'POST');
    assert.equal(error.endpoint, '/bills');
    assert.equal(error.response, undefined);
    assert.equal(error.config, undefined);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(h.events, [expected(400, 36004, message)]);
  assert.equal(h.posts.length, 1);
});

for (const code of [13009, '13009']) {
  test(`production missing-account rejection retains HTTP 400/${typeof code} 13009 without guessing an account`, async () => {
    const message = 'The account field cannot be empty';
    const h = harness(() => {
      const payload = JSON.parse(JSON.stringify(h.posts.at(-1).payload));
      assert.ok(payload.line_items.every(item => !Object.hasOwn(item, 'account_id') && !Object.hasOwn(item, 'item_id')));
      throw rejected(400, code, message);
    });
    await assert.rejects(h.client.createBill(input), {
      code: 'ZOHO_BOOKS_API_ERROR', httpStatus: 400, providerCode: code,
      providerMessage: message, operation: 'createBill', method: 'POST', endpoint: '/bills',
    });
    assert.deepEqual(h.events, [expected(400, code, message)]);
    assert.equal(h.posts.length, 1, 'A validation rejection must not trigger a guessed-account retry');
    assert.equal(h.tokens.length, 1, 'A missing account is not an expired OAuth token');
  });
}

test('production 13009 leaves the draft in review with its existing safe reply and unchanged bill details', async () => {
  const message = 'The account field cannot be empty';
  const h = harness(() => { throw rejected(400, 13009, message); });
  const f = fixture({ zohoOverrides: { createBill: h.client.createBill } });
  const initial = await f.send('Synthetic bill');
  const before = structuredClone(await f.billStore.getBill(initial.billId));
  const result = await f.send('SAVE');
  const after = await f.billStore.getBill(initial.billId);
  assert.equal(result.replyText, 'Zoho rejected this bill. Please check the accounting fields and permissions.\nReply SAVE to retry, EDIT to correct, or DELETE.');
  assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(after.status, 'PENDING_REVIEW');
  assert.equal(after.zoho_status, 'FAILED');
  assert.equal(after.zoho_error, 'ZOHO_REJECTED_BILL');
  assert.equal(after.zoho_bill_id, undefined);
  for (const field of ['vendor_name', 'bill_number', 'bill_date', 'currency', 'organization',
    'payment_type', 'customer_details', 'line_items', 'subtotal', 'tax_amount', 'total_amount', 'attachments']) {
    assert.deepEqual(after[field], before[field], `${field} must survive rejection unchanged`);
  }
  assert.equal(f.calls.some(([action]) => ['attach', 'pdf', 'document'].includes(action)), false);
  assert.deepEqual(h.events, [expected(400, 13009, message)]);
  assert.equal(h.posts.length, 1);
});

test('bill diagnostics redact credentials, echoed bill values and customer details before logging or throwing', async () => {
  const message = [
    'Invalid account_id for private-vendor-id, PRIVATE-INV-100, private-organization-id.',
    'Private purchased product; Customer: Private Customer; Project/site: Private Project.',
    'private-client-secret private-refresh-token private-access-token-1 private-other-api-key',
    'prefixprivate-client-secretsuffix private%2Bencoded%2Fvalue',
    'Authorization: Bearer unknown-header-token; refresh_token=unknown-refresh;',
    'private.person@example.test +971 50 123 4567 https://private.example/path?token=anything',
    'Vendor "Private Vendor LLC" has invalid "account_id". Contact "private_person_name".',
  ].join('\n');
  const h = harness(() => { throw rejected(400, 12345, message); });
  await assert.rejects(h.client.createBill({ ...input, notes: 'Customer: Private Customer | Project/site: Private Project',
    referenceNumber: 'private+encoded/value' }), error => {
    const output = JSON.stringify({ message: error.message, error, events: h.events });
    for (const privateValue of ['private-vendor-id', 'PRIVATE-INV-100', 'private-organization-id',
      'Private purchased product', 'Private Customer', 'Private Project', 'Private Vendor LLC', 'private_person_name',
      'private-client-secret', 'private-refresh-token', 'private-access-token-1', 'private-other-api-key',
      'private%2Bencoded%2Fvalue', 'unknown-header-token', 'unknown-refresh', 'private.person@example.test',
      '+971 50 123 4567', 'private.example', 'private authorization header', 'private response field']) {
      assert.equal(output.includes(privateValue), false, privateValue);
    }
    assert.match(error.providerMessage, /"account_id"/);
    assert.doesNotMatch(error.providerMessage, /[\r\n]/);
    assert.match(error.providerMessage, /\[REDACTED\]/);
    return true;
  });
  assert.equal(h.events.length, 1);
  assert.deepEqual(Object.keys(h.events[0]).sort(), Object.keys(expected(400, 12345, '')).sort());
});

test('malformed provider code/message/status cannot smuggle objects into bill diagnostics', async () => {
  const h = harness(() => { throw rejected('private-status', { secret: 'private-code' }, { secret: 'private-message' }); });
  await assert.rejects(h.client.createBill(input), error => {
    assert.equal(error.providerCode, undefined);
    assert.equal(error.providerMessage, undefined);
    assert.equal(error.httpStatus, undefined);
    assert.doesNotMatch(JSON.stringify(error), /private-/);
    return true;
  });
  assert.deepEqual(h.events, [expected(null, null, null)]);
});

test('unquoted vendor and customer names echoed by Zoho are redacted even when absent from the request', async () => {
  for (const [message, safeMessage] of [
    ['Vendor Private Name LLC does not exist.', 'Vendor [REDACTED] does not exist.'],
    ['customer_name: Private Person; invalid account_id.', 'customer_name: [REDACTED]; invalid account_id.'],
    ['Contact Private Person is inactive.', 'Contact [REDACTED] is inactive.'],
  ]) {
    const h = harness(() => { throw rejected(400, 12345, message); });
    await assert.rejects(h.client.createBill(input), { providerMessage: safeMessage });
    assert.deepEqual(h.events, [expected(400, 12345, safeMessage)]);
  }
});

test('sanitization failure omits provider text while preserving the rejection status and code', async () => {
  const h = harness(() => { throw rejected(400, 12345, 'Private provider details'); });
  await assert.rejects(h.client.createBill({ ...input, notes: '\ud800' }), error => {
    assert.equal(error.httpStatus, 400);
    assert.equal(error.providerCode, 12345);
    assert.equal(error.providerMessage, undefined);
    assert.doesNotMatch(error.message, /Private/);
    return true;
  });
  assert.deepEqual(h.events, [expected(400, 12345, null)]);
});

test('a numeric string provider code retains its type and value', async () => {
  const h = harness(() => { throw rejected(422, '12345', 'Invalid line item.'); });
  await assert.rejects(h.client.createBill(input), { providerCode: '12345', providerMessage: 'Invalid line item.' });
  assert.deepEqual(h.events, [expected(422, '12345', 'Invalid line item.')]);
});

test('transport errors without a provider response do not log the raw error, request or stack', async () => {
  const h = harness(() => { throw Object.assign(Error('private connection details'), {
    code: 'ECONNRESET', request: { secret: 'private request body' },
  }); });
  await assert.rejects(h.client.createBill(input), error => {
    assert.equal(error.httpStatus, undefined);
    assert.equal(error.providerCode, undefined);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.deepEqual(h.events, [expected(null, null, null)]);
});

test('authentication retry retains the final response once and redacts both access tokens', async () => {
  const h = harness(attempt => {
    if (attempt === 1) throw rejected(401, 57, 'The access token has expired.');
    throw rejected(403, 12345, 'Not permitted. private-access-token-1 private-access-token-2');
  });
  await assert.rejects(h.client.createBill(input), { httpStatus: 403, providerCode: 12345 });
  assert.equal(h.tokens.length, 2);
  assert.equal(h.posts.length, 2);
  assert.deepEqual(h.events, [expected(403, 12345, 'Not permitted. [REDACTED] [REDACTED]')]);
});

test('a recovered authentication failure produces no final rejection event', async () => {
  const h = harness(attempt => {
    if (attempt === 1) throw rejected(401, 57, 'The access token has expired.');
    return { status: 201, data: { code: 0, bill: { bill_id: 'created-id' } } };
  });
  assert.equal((await h.client.createBill(input)).id, 'created-id');
  assert.equal(h.posts.length, 2);
  assert.deepEqual(h.events, []);
});

test('HTTP-200 error envelopes retain their provider evidence without duplicate logging', async () => {
  const h = harness(() => ({ status: 200, data: { code: 12345, message: 'Invalid line item.' } }));
  await assert.rejects(h.client.createBill(input), { httpStatus: 200, providerCode: 12345, providerMessage: 'Invalid line item.' });
  assert.deepEqual(h.events, [expected(200, 12345, 'Invalid line item.')]);
  assert.equal(h.posts.length, 1);
});

test('success envelopes without a bill ID remain unconfirmed and retain code zero', async () => {
  const h = harness(() => ({ status: 200, data: { code: 0, message: 'Success' } }));
  await assert.rejects(h.client.createBill(input), { code: 'ZOHO_BOOKS_API_ERROR', httpStatus: 200, providerCode: 0 });
  assert.deepEqual(h.events, [expected(200, 0, 'Success')]);
});

test('logger failures cannot replace the original bill rejection or cause a second POST', async () => {
  const h = harness(() => { throw rejected(400, 12345, 'Invalid line item.'); }, { error() { throw Error('logger unavailable'); } });
  await assert.rejects(h.client.createBill(input), { httpStatus: 400, providerCode: 12345, providerMessage: 'Invalid line item.' });
  assert.equal(h.posts.length, 1);
});

test('bill diagnostics bound oversized and multiline provider messages', async () => {
  for (const [message, result] of [
    ['x'.repeat(8193), '[Provider message omitted: exceeds diagnostic limit]'],
    ['x'.repeat(1025), 'x'.repeat(1024) + ' [truncated]'],
    ['Invalid\nline\r\nitem.\u0000', 'Invalid line  item.'],
  ]) {
    const h = harness(() => { throw rejected(400, 12345, message); });
    await assert.rejects(h.client.createBill(input), { providerMessage: result });
    assert.deepEqual(h.events, [expected(400, 12345, result)]);
  }
});

test('structured diagnostic fields survive the production logger without logging an Error object', async () => {
  const lines = [];
  const logger = createLogger({ LOG_LEVEL: 'error' }, { write: line => lines.push(line) });
  const h = harness(() => { throw rejected(400, 12345, 'Invalid line item.'); }, logger);
  await assert.rejects(h.client.createBill(input));
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  for (const [key, value] of Object.entries(expected(400, 12345, 'Invalid line item.'))) assert.equal(row[key], value);
  assert.doesNotMatch(lines[0], /private-|Authorization|stack|headers|payload/);
});

test('successful bill payload preserves line amounts with explicit tax calculation and emits no diagnostics', async () => {
  const h = harness(() => ({ status: 201, data: { code: 0, bill: { bill_id: 'created-id' } } }));
  assert.equal((await h.client.createBill(input)).id, 'created-id');
  assert.deepEqual(h.events, []);
  assert.deepEqual(JSON.parse(JSON.stringify(h.posts[0].payload)), {
    vendor_id: input.vendorId, bill_number: input.billNumber, date: input.billDate,
    is_inclusive_tax: false, is_item_level_tax_calc: true,
    line_items: [{ description: input.lineItems[0].description, rate: 50, quantity: 2 }],
  });
});

for (const status of [400, 401, 403, 422]) {
  test(`SAVE keeps its safe review reply for HTTP ${status} while retaining provider diagnostics`, async () => {
    const h = harness(() => { throw rejected(status, 12345, 'Invalid line item.'); });
    const f = fixture({ zohoOverrides: { createBill: h.client.createBill } });
    const initial = await f.send('Synthetic bill');
    const result = await f.send('SAVE');
    assert.equal(result.replyText, 'Zoho rejected this bill. Please check the accounting fields and permissions.\nReply SAVE to retry, EDIT to correct, or DELETE.');
    assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
    assert.equal((await f.billStore.getBill(initial.billId)).zoho_error, 'ZOHO_REJECTED_BILL');
    assert.deepEqual(h.events, [expected(status, 12345, 'Invalid line item.')]);
    assert.equal(h.posts.length, status === 401 ? 2 : 1);
  });
}

test('unconfirmed HTTP-200 bill response still locks SAVE against duplicate creation', async () => {
  const h = harness(() => ({ status: 200, data: { code: 12345, message: 'Invalid line item.' } }));
  const f = fixture({ zohoOverrides: { createBill: h.client.createBill } });
  await f.send('Synthetic bill');
  const result = await f.send('SAVE');
  assert.equal(result.state, 'CREATING_IN_ZOHO');
  assert.match(result.replyText, /locked to prevent duplicates/);
  assert.doesNotMatch(result.replyText, /Invalid line item/);
  await f.send('SAVE');
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.events, [expected(200, 12345, 'Invalid line item.')]);
});
