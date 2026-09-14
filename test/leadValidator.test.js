'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone } = require('../src/utils/phone');
const { validateLead } = require('../src/services/leads/leadValidator');

function lead(overrides = {}) {
  return {
    name: 'Ahmed', phone: '0501234567', email: null, company: 'ABC Contracting',
    service: 'AC maintenance', location: 'Dubai', requirement: 'AC maintenance', notes: null,
    ...overrides,
  };
}

test('normalizes UAE local and international formats to E.164', () => {
  for (const input of ['0501234567', '+971501234567', '971501234567', '+971 50 123 4567', '00971-50-123-4567', '(050) 123 4567']) {
    assert.equal(normalizePhone(input), '+971501234567', input);
  }
});

test('preserves valid explicit international phone countries', () => {
  assert.equal(normalizePhone('+44 20 7946 0018'), '+442079460018');
  assert.equal(normalizePhone('0044 20 7946 0018'), '+442079460018');
  assert.equal(normalizePhone('+1 (415) 555-2671'), '+14155552671');
  assert.equal(normalizePhone('+91 98765 43210'), '+919876543210');
});

test('rejects invalid, ambiguous, non-string, embedded and extended phone values', () => {
  for (const input of [null, undefined, 501234567, '', '12345', '050000', '+971000000000',
    '442079460018', '501234567', '02079460018', 'Call 0501234567', '+971501234567 ext 123',
    '+971501234567;drop table leads', '++971501234567', '+971501234567123456789', 'x'.repeat(81)]) {
    assert.equal(normalizePhone(input), null, String(input));
  }
});

test('validates and cleans a grounded UAE phone lead', () => {
  const result = validateLead(lead({ name: ' Ahmed\n ', company: 'ABC\u0000 Contracting' }), {
    originalText: 'Ahmed from ABC Contracting, 0501234567, needs AC maintenance in Dubai.',
  });
  assert.equal(result.valid, true);
  assert.equal(result.lead.phone, '+971501234567');
  assert.equal(result.lead.name, 'Ahmed');
  assert.equal(result.lead.company, 'ABC Contracting');
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.errors, []);
});

test('missing phone and email requests contact information and prevents a CRM-ready lead', () => {
  const result = validateLead(lead({ phone: null }));
  assert.equal(result.valid, false);
  assert.deepEqual(result.missing, ['customer phone number or email address']);
  assert.equal(result.lead.phone, null);
});

test('name is required even when a valid phone is supplied', () => {
  for (const name of [null, '', 'unknown', 'N/A', 'not provided', '123456']) {
    const result = validateLead(lead({ name }));
    assert.equal(result.valid, false);
    assert.ok(result.missing.includes('customer name'));
  }
});

test('a grounded valid email can replace an absent phone', () => {
  const result = validateLead(lead({ phone: null, email: ' Ahmed@ABC.ae ' }), {
    originalText: 'Ahmed (Ahmed@ABC.ae) needs maintenance in Dubai.',
  });
  assert.equal(result.valid, true);
  assert.equal(result.lead.phone, null);
  assert.equal(result.lead.email, 'ahmed@abc.ae');
  assert.deepEqual(result.missing, []);
});

test('invalid contact fields cannot enter CRM even if an alternative is valid', () => {
  for (const overrides of [
    { phone: '050123', email: null }, { phone: null, email: 'ahmed at abc.ae' },
    { phone: 'invalid', email: 'ahmed@abc.ae' }, { email: 'invalid' },
  ]) {
    const result = validateLead(lead(overrides));
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  }
});

test('rejects hallucinated contacts not present in the original message', () => {
  const result = validateLead(lead({ email: 'invented@abc.ae' }), {
    originalText: 'Ahmed from ABC Contracting needs AC maintenance in Dubai.',
  });
  assert.equal(result.valid, false);
  assert.equal(result.lead.phone, null);
  assert.equal(result.lead.email, null);
  assert.equal(result.errors.length, 2);
});

test('contact provenance recognizes equivalent UAE and international number formats', () => {
  for (const [phone, originalText] of [
    ['+971501234567', 'Ahmed, phone: 050 123 4567.'],
    ['0501234567', 'Ahmed, +971 50 123 4567.'],
    ['+442079460018', 'Ahmed, +44 (20) 7946-0018.'],
    ['+971501234567', 'Ahmed, 971501234567'],
  ]) {
    assert.equal(validateLead(lead({ phone }), { originalText }).valid, true, originalText);
  }
});

test('contact provenance does not match digits or emails embedded in another identifier', () => {
  for (const originalText of [
    'Ahmed, reference A0501234567B', 'Ahmed, reference 99501234567000',
    'Ahmed, invented part of longer email xahmed@abc.ae',
  ]) {
    const result = validateLead(lead({ phone: originalText.includes('email') ? null : '0501234567', email: originalText.includes('email') ? 'ahmed@abc.ae' : null }), { originalText });
    assert.equal(result.valid, false, originalText);
  }
});

test('non-string original message fails contact provenance closed', () => {
  const result = validateLead(lead(), { originalText: null });
  assert.equal(result.valid, false);
  assert.equal(result.lead.phone, null);
  assert.ok(result.errors.includes('The original message could not be verified.'));
});

test('strict validation rejects missing keys, unexpected fields and unbounded data with safe errors', () => {
  const incomplete = lead();
  delete incomplete.email;
  for (const raw of [null, [], incomplete, { ...lead(), password: 'sensitive-test-content' }, lead({ notes: 'sensitive-test-content'.repeat(1000) }), lead({ phone: 501234567 })]) {
    const result = validateLead(raw);
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result).includes('sensitive-test-content'), false);
    assert.deepEqual(result.errors, ['The extracted customer details could not be validated.']);
  }
});
