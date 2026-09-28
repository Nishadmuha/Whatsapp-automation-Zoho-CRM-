'use strict';

function populated(value) {
  return value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '')
    && (!Array.isArray(value) || value.length > 0);
}

// Merge only records already verified as the same Zoho customer/organization.
// Sparse detail responses must not erase useful values from the list response.
function mergeCustomerData(...records) {
  const result = {};
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    for (const [key, value] of Object.entries(record || {})) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || !populated(value)) continue;
      if (Array.isArray(value)) {
        result[key] = value.map(item => {
          const idKey = ['contact_person_id', 'customfield_id', 'address_id'].find(field => populated(item?.[field]));
          const previous = idKey && Array.isArray(result[key])
            ? result[key].find(candidate => candidate?.[idKey] === item[idKey]) : null;
          return previous ? mergeCustomerData(previous, item) : structuredClone(item);
        });
      } else if (typeof value === 'object') {
        result[key] = mergeCustomerData(result[key], value);
      } else result[key] = value;
    }
  }
  return result;
}

function parseManualCustomerDetails(text) {
  const source = String(text || '').trim().slice(0, 4000)
    .replace(/^(?:customer|client)(?:\s+(?:details|name))?\s*[:=-]\s*/i, '');
  if (!source) return null;
  const details = {};
  let addressField = null;
  for (const part of source.split(/[,;\n]+/).map(value => value.trim()).filter(Boolean)) {
    const labelled = part.match(/^(?:(?:customer|client)\s+)?(name|company(?:\s+name)?|contact\s+person|phone|mobile|email|trn|tax(?:\s+(?:registration\s+)?(?:number|no\.?))?|billing\s+address|shipping\s+address|address|location|site|project(?:\s*\/\s*site)?)\s*[:=-]\s*(.*)$/i);
    const label = labelled?.[1].toLowerCase() || '';
    const value = labelled ? labelled[2].trim() : part;
    if (label) addressField = null;
    if (!value) continue;
    if (/^(?:trn|tax)/.test(label)) { details.customer_trn = value; continue; }
    if (label.includes('address')) {
      addressField = label.startsWith('billing') ? 'customer_billing_address' : label.startsWith('shipping') ? 'customer_shipping_address' : 'customer_address';
      details[addressField] = value;
      continue;
    }
    if (addressField && !label) { details[addressField] += `, ${value}`; continue; }
    if (label === 'name') { details.customer_name = value; continue; }
    if (label.startsWith('company')) { details.customer_company_name = value; details.customer_name ||= value; continue; }
    if (label === 'contact person') { details.customer_contact_person = value; continue; }
    const email = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    const phone = value.match(/\+?\d[\d\s()-]{6,}\d/);
    if (email) details.customer_email = email;
    if (phone) details[label === 'mobile' ? 'customer_mobile' : 'customer_phone'] = phone[0].replace(/[\s()-]/g, '');
    const remaining = value.replace(email || '', '').replace(phone?.[0] || '', '').trim();
    if (!remaining || ['email', 'phone', 'mobile'].includes(label)) continue;
    if (/^(?:location|site|project)/.test(label) || (!details.customer_name && /\bsite\b/i.test(remaining))) {
      details.project_site = remaining;
    } else if (!details.customer_name) details.customer_name = remaining;
    else details.project_site = [details.project_site, remaining].filter(Boolean).join(', ');
  }
  return Object.keys(details).length ? details : null;
}

function addressText(address) {
  if (typeof address === 'string') return address;
  if (!address || typeof address !== 'object') return null;
  return ['attention', 'address', 'street2', 'city', 'state', 'zip', 'country'].map(key => address[key]).filter(populated).join(', ');
}

// Customer contact fields are not vendor VAT/currency/payment configuration.
// Keep the full Zoho snapshot locally; send useful customer annotations only
// through the documented bill notes field, never arbitrary contact API fields.
function customerBillNotes(details = {}) {
  const zoho = details.zoho_contact || {};
  const people = (Array.isArray(zoho.contact_persons) ? zoho.contact_persons : []).map(person =>
    [person?.salutation, person?.first_name, person?.last_name].filter(populated).join(' ')).filter(Boolean);
  const fields = [
    ['Customer', details.customer_name],
    ['Customer company', details.customer_company_name || zoho.company_name],
    ['Customer display name', details.display_name || zoho.display_name],
    ['Customer contact person', details.customer_contact_person || zoho.contact_person || people.join('; ')],
    ['Customer email', details.customer_email || zoho.email],
    ['Customer phone', details.customer_phone || zoho.phone],
    ['Customer mobile', details.customer_mobile || zoho.mobile],
    ['Customer TRN', zoho.tax_registration_number || zoho.tax_reg_no || zoho.vat_reg_no || zoho.gst_no || details.customer_trn],
    ['Customer tax treatment', zoho.tax_treatment || zoho.vat_treatment],
    ['Customer address', addressText(details.customer_address)],
    ['Customer billing address', addressText(zoho.billing_address || details.customer_billing_address)],
    ['Customer shipping address', addressText(zoho.shipping_address || details.customer_shipping_address)],
    ['Customer code', zoho.customer_code || zoho.contact_number || details.customer_code],
    ['Customer currency', zoho.currency_code || zoho.currency_id],
    ['Customer payment terms', zoho.payment_terms_label || zoho.payment_terms],
    ['Customer status', details.customer_status || zoho.status],
    ['Customer organization ID', details.organization_id],
    ['Project/site', details.project_site],
  ];
  return fields.filter(([, value]) => populated(value)).map(([label, value]) => `${label}: ${value}`);
}

module.exports = { mergeCustomerData, parseManualCustomerDetails, customerBillNotes };
