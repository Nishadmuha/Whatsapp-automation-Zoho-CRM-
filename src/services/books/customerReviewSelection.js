'use strict';

function nameKey(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// A recent complete list already offered for this draft can resolve a typed
// exact name or retain the free-form manual fallback. Partial/stale lists and
// ambiguous/inactive records still take the normal live search path.
function reviewCustomerLookup(session, name, organizationId = session?.bill_data?.organization?.organizationId) {
  if (session?.state !== 'WAITING_FOR_CUSTOMER_SELECTION' || session.customer_search !== ''
      || !organizationId || session.bill_data?.organization?.organizationId !== organizationId) return null;
  const age = Date.now() - new Date(session.created_at).getTime();
  if (!Number.isFinite(age) || age < 0 || age >= 60000) return null;
  const options = session.customer_all_options;
  if (!Array.isArray(options) || !options.length || options.some(option => !option
      || option.organizationId !== organizationId
      || ![option.contactName, option.companyName, option.displayName].some(value => typeof value === 'string' && value.trim())
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(option.contactId || option.id || ''))) return null;
  const needle = String(name || '').trim().toLowerCase();
  const key = nameKey(name);
  if (!needle || !key) return null;
  const exact = options.filter(option => {
    const names = [option.contactName, option.companyName, option.displayName];
    // Keep the live client's substring qualification before the workflow's
    // normalized exact-name rule; punctuation alone must not add new matches.
    return [...names, option.phone, option.mobile, option.email].some(value => value && String(value).toLowerCase().includes(needle))
      && names.some(value => value && nameKey(value) === key);
  });
  if (!exact.length) return { customer: null };
  if (exact.length !== 1 || (exact[0].contactType && exact[0].contactType !== 'customer')
      || (exact[0].status && exact[0].status.toLowerCase() !== 'active')) return null;
  return { customer: exact[0] };
}

module.exports = { reviewCustomerLookup };
