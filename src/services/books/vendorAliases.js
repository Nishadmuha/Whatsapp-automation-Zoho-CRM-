'use strict';

const { organizationById } = require('./organizations');

const CONTRACTING_VENDOR_ALIAS = 'NEW QAMAR JASI BUILDING MATERIALS TRADING L.L.C (BR)';
const CONTRACTING_VENDOR_NAME = 'NEW QAMAR JASI BUILDING MATERIALS TRADING LLC';

function vendorNameKey(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function resolveVendorAlias(name, organizationId) {
  if (organizationById(organizationId)?.name !== 'VOLTRONIX CONTRACTING LLC') return null;
  // The user confirmed this invoice name and this existing vendor are the same.
  // Branch suffixes on any other vendor remain significant.
  return vendorNameKey(name) === vendorNameKey(CONTRACTING_VENDOR_ALIAS) ? CONTRACTING_VENDOR_NAME : null;
}

module.exports = { resolveVendorAlias };
