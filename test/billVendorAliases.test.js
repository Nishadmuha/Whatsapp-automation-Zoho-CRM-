'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveVendorAlias } = require('../src/services/books/vendorAliases');
const { organizationByName } = require('../src/services/books/organizations');

const CONTRACTING_ID = organizationByName('VOLTRONIX CONTRACTING LLC').organizationId;
const SWITCHGEAR_ID = organizationByName('VOLTRONIX SWITCHGEAR LLC').organizationId;
const ALIAS = 'NEW QAMAR JASI BUILDING MATERIALS TRADING L.L.C (BR)';
const CANONICAL = 'NEW QAMAR JASI BUILDING MATERIALS TRADING LLC';

test('confirmed Contracting vendor alias resolves to its existing vendor name', () => {
  assert.ok(CONTRACTING_ID, 'Use the isolated test environment with configured organization IDs.');
  assert.equal(resolveVendorAlias(ALIAS, CONTRACTING_ID), CANONICAL);
});

test('confirmed alias tolerates case, spacing, and punctuation only', () => {
  for (const name of [
    'new qamar jasi building materials trading llc (br)',
    '  New Qamar Jasi Building Materials Trading L. L. C. [BR]  ',
    'NEW QAMAR JASI BUILDING MATERIALS TRADING LLC-BR',
  ]) assert.equal(resolveVendorAlias(name, CONTRACTING_ID), CANONICAL);
});

test('confirmed alias never applies to Switchgear, unknown, or missing organizations', () => {
  assert.ok(SWITCHGEAR_ID);
  for (const organizationId of [SWITCHGEAR_ID, 'unknown-organization', '', null, undefined]) {
    assert.equal(resolveVendorAlias(ALIAS, organizationId), null);
  }
});

test('different companies and branch suffixes do not gain a vendor alias', () => {
  for (const name of [
    CANONICAL,
    'NEW QAMAR JASI BUILDING MATERIALS TRADING LLC (BR 2)',
    'NEW QAMAR JASI BUILDING MATERIALS TRADING LLC (BRANCH)',
    'NEW QAMAR JASI BUILDING MATERIALS TRADING LLC (DUBAI)',
    'QAMAR JASI BUILDING MATERIALS TRADING LLC (BR)',
    'NEW QAMAR JASI BUILDING MATERIAL TRADING LLC (BR)',
    'OTHER COMPANY LLC (BR)',
    '', null, undefined,
  ]) assert.equal(resolveVendorAlias(name, CONTRACTING_ID), null);
});
