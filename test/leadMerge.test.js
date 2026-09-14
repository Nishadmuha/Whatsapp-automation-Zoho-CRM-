'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { emptyResult, mergeLeadResults } = require('../src/services/leads/leadMerge');
const { FIELD_LIMITS } = require('../src/services/ai/leadExtraction');

const enquiry = values => ({ ...emptyResult(), is_lead: true, lead: { ...emptyResult().lead, ...values } });

test('merging a later message never restores stale facts from the extraction history', () => {
  const previous = enquiry({ company_name: 'Al Noor', project_location: 'Abu Dhabi', phone: '+971501234567' });
  const incoming = enquiry({ company_name: 'Al Noor', project_location: 'Dubai', phone: '+971501234567', contact_name: 'Ahmed' });
  const merged = mergeLeadResults(previous, incoming, { currentText: 'The contact is Ahmed' });
  assert.equal(merged.lead.project_location, 'Abu Dhabi');
  assert.equal(merged.lead.phone, '+971501234567');
  assert.equal(merged.lead.contact_name, 'Ahmed');
  assert.equal(merged.lead.company_name, 'Al Noor');
});

test('newly stated factual corrections replace the previous scalar value', () => {
  const merged = mergeLeadResults(enquiry({ project_location: 'Dubai' }), enquiry({ project_location: 'Abu Dhabi' }),
    { currentText: 'Correction: project location is Abu Dhabi' });
  assert.equal(merged.lead.project_location, 'Abu Dhabi');
});

test('requirements and products added separately retain each complete fact without guessing totals', () => {
  const first = enquiry({ requirement: 'Need 2 generators', product_or_service: 'generators', quantity: '2' });
  const update = enquiry({ requirement: 'Also need 4 switches', product_or_service: 'switches', quantity: '4' });
  const merged = mergeLeadResults(first, update, { currentText: 'Also need 4 switches' });
  assert.equal(merged.lead.requirement, 'Need 2 generators\nAlso need 4 switches');
  assert.equal(merged.lead.product_or_service, 'generators\nswitches');
  assert.equal(merged.lead.quantity, '4');
  assert.deepEqual(mergeLeadResults(merged, update, { currentText: 'Also need 4 switches' }), merged);
});

test('explicit requirement correction replaces the old requirement and product', () => {
  const merged = mergeLeadResults(enquiry({ requirement: 'Need 2 generators', product_or_service: 'generators' }),
    enquiry({ requirement: 'Need 4 switches', product_or_service: 'switches' }),
    { currentText: 'Correction: Need 4 switches instead' });
  assert.equal(merged.lead.requirement, 'Need 4 switches');
  assert.equal(merged.lead.product_or_service, 'switches');
});

test('combined extraction retains only additions grounded in the latest message', () => {
  const previous = enquiry({ requirement: 'Need 2 generators', notes: 'Deliver before noon', project_location: 'Abu Dhabi' });
  const merged = mergeLeadResults(previous, enquiry({ requirement: 'Need 2 generators Also need 4 switches',
    notes: 'Deliver before noon Gate 4', project_location: 'Dubai' }),
  { currentText: 'Also need 4 switches. Gate 4' });
  assert.equal(merged.lead.requirement, 'Need 2 generators\nAlso need 4 switches');
  assert.equal(merged.lead.notes, 'Deliver before noon\nGate 4');
  assert.equal(merged.lead.project_location, 'Abu Dhabi');
  assert.equal(mergeLeadResults(previous, enquiry({ requirement: 'Need 2 generators Need 9 panels' }),
    { currentText: 'Gate 4' }).lead.requirement, previous.lead.requirement);
});

test('an unrelated contact update never replaces previous requirements or products', () => {
  const merged = mergeLeadResults(enquiry({ requirement: 'Need 2 generators', product_or_service: 'generators' }),
    enquiry({ requirement: 'Need 4 switches', product_or_service: 'switches', contact_name: 'Ahmed' }),
    { currentText: 'Update contact: Ahmed. Need 4 switches' });
  assert.equal(merged.lead.requirement, 'Need 2 generators\nNeed 4 switches');
  assert.equal(merged.lead.product_or_service, 'generators\nswitches');
  assert.equal(merged.lead.contact_name, 'Ahmed');
});

test('merge deduplication uses full facts and respects schema bounds without truncating a fact', () => {
  const merged = mergeLeadResults(enquiry({ notes: 'Reference 1' }), enquiry({ notes: 'Reference 10' }));
  assert.equal(merged.lead.notes, 'Reference 1\nReference 10');
  const full = 'A'.repeat(FIELD_LIMITS.requirement);
  assert.equal(mergeLeadResults(enquiry({ requirement: full }), enquiry({ requirement: 'Another complete requirement' }))
    .lead.requirement, full);
});

test('nulls and irrelevant extraction cannot erase previously captured fields', () => {
  const first = enquiry({ company_name: 'Al Noor', email: 'procurement@example.com', requirement: 'Need 2 generators' });
  assert.deepEqual(mergeLeadResults(first, emptyResult()), first);
  assert.deepEqual(mergeLeadResults(first, enquiry({ notes: null })), first);
});
