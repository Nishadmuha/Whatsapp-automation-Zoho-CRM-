'use strict';

// These scopes describe the existing endpoints, not an automatic consent request.
const CRM_SCOPES = Object.freeze([
  'ZohoCRM.modules.leads.READ',
  'ZohoCRM.modules.leads.CREATE',
  'ZohoCRM.modules.leads.UPDATE',
  'ZohoCRM.modules.attachments.READ',
  'ZohoCRM.modules.attachments.CREATE',
  // /Leads/search requires this in addition to the module READ scope.
  'ZohoSearch.securesearch.READ',
]);
const BOOKS_SCOPES = Object.freeze([
  'ZohoBooks.contacts.READ',
  'ZohoBooks.bills.READ',
  'ZohoBooks.bills.CREATE',
  // Existing prepareBill validates configured currency and tax IDs.
  'ZohoBooks.settings.READ',
]);

function scopeReport(raw, required) {
  const tokens = typeof raw === 'string' ? raw.split(/[\s,]+/).filter(Boolean) : [];
  // Only print scope identifiers, never arbitrary OAuth response contents.
  const granted = [...new Set(tokens.filter(value => /^(?:ZohoCRM\.modules\.(?:[a-z]+\.)?(?:READ|CREATE|UPDATE|DELETE|ALL)|ZohoSearch\.securesearch\.READ|ZohoBooks\.[a-z]+\.(?:READ|CREATE|UPDATE|DELETE|ALL|all))$/.test(value)))];
  const known = tokens.length > 0 && tokens.length === tokens.filter(value => granted.includes(value)).length;
  const covers = (scope) => granted.includes(scope)
    || (scope.startsWith('ZohoCRM.modules.') && (granted.includes('ZohoCRM.modules.ALL') || granted.includes(scope.replace(/\.[^.]+$/, '.ALL'))))
    || (scope.startsWith('ZohoBooks.') && (granted.includes('ZohoBooks.fullaccess.all') || granted.includes(scope.replace(/\.[^.]+$/, '.ALL'))));
  return {
    required: [...required],
    granted,
    metadataAvailable: known,
    missing: known ? required.filter(scope => !covers(scope)) : null,
    excess: granted.filter(scope => !required.includes(scope)),
  };
}

module.exports = { CRM_SCOPES, BOOKS_SCOPES, scopeReport };
