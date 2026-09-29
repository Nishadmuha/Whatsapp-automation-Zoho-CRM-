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
    .replace(/^(?:customer|client)\s+details\s*(?::|=|-|\n)\s*/i, '')
    .replace(/^(?:customer|client)(?:\s+name)?\s*[:=-]\s*/i, '');
  if (!source) return null;
  const details = {};
  let addressField = null;
  const labels = '(?:(?:customer|client)\\s+)?(?:name|company(?:\\s+name)?|contact\\s+(?:person|name)|(?:phone|mobile|telephone|tel|whatsapp)(?:\\s+(?:number|no\\.?))?|e-?mail|trn|(?:tax|vat|gst)(?:\\s+(?:registration\\s+)?(?:number|no\\.?))?|billing\\s+address|shipping\\s+address|address|location|site|project(?:\\s*\\/\\s*site)?(?:\\s+(?:name|details))?|website|notes?|payment(?:\\s+(?:method|type|status))?|paid\\s+by)';
  // Workers often paste a single line with spaces between labelled fields.
  // Introduce a boundary only before a known label and explicit separator.
  const parts = source.replace(new RegExp(`(^|\\s+)(${labels})\\s*[:=]\\s*`, 'gi'), ';$2: ').split(/[,;\n]+/);
  for (const part of parts.map(value => value.trim()).filter(Boolean)) {
    const labelled = part.match(new RegExp(`^(${labels})\\s*[:=-]\\s*(.*)$`, 'i'));
    const label = (labelled?.[1].toLowerCase() || '').replace(/^(?:customer|client)\s+/, '');
    const value = labelled ? labelled[2].trim() : part;
    if (label) addressField = null;
    if (!value) continue;
    if (/^(?:payment|paid by)/.test(label)) continue;
    if (/^(?:trn|tax|vat|gst)/.test(label)) { details.customer_trn = value; continue; }
    if (label.includes('address')) {
      addressField = label.startsWith('billing') ? 'customer_billing_address' : label.startsWith('shipping') ? 'customer_shipping_address' : 'customer_address';
      details[addressField] = value;
      continue;
    }
    if (addressField && !label) { details[addressField] += `, ${value}`; continue; }
    if (label === 'name') { details.customer_name = value; continue; }
    if (label.startsWith('company')) { details.customer_company_name = value; details.customer_name ||= value; continue; }
    if (/^contact (?:person|name)$/.test(label)) { details.customer_contact_person = value; continue; }
    if (label === 'website') { details.customer_website = value; continue; }
    if (/^notes?$/.test(label)) { details.customer_notes = value; continue; }
    if (/^(?:location|site|project)/.test(label)) {
      details.project_site = value;
      continue;
    }
    const email = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    const phone = value.replace(email || '', '').match(/\+?\d[\d\s()-]{6,}\d/);
    if (email) details.customer_email = email;
    if (phone) details[/^(?:mobile|whatsapp)/.test(label) ? 'customer_mobile' : 'customer_phone'] = phone[0].replace(/[\s()-]/g, '');
    const remaining = value.replace(email || '', '').replace(phone?.[0] || '', '').trim();
    if (!remaining || /^(?:e-?mail|phone|mobile|telephone|tel|whatsapp)/.test(label)) continue;
    if (!details.customer_name) details.customer_name = remaining;
    else details.project_site = [details.project_site, remaining].filter(Boolean).join(', ');
  }
  return Object.keys(details).length ? details : null;
}

function addressText(address) {
  if (typeof address === 'string') return address;
  if (!address || typeof address !== 'object') return null;
  const text = ['attention', 'address', 'street2', 'city', 'state', 'zip', 'country'].map(key => address[key]).filter(populated).join(', ');
  return [text, address.phone ? `Phone: ${address.phone}` : '', address.fax ? `Fax: ${address.fax}` : ''].filter(Boolean).join('; ');
}

function fieldText(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(', ');
  if (typeof value === 'object') return fieldText(value.name ?? value.label ?? value.value ?? '');
  return String(value);
}

// Customer contact fields are not vendor VAT/currency/payment configuration.
// Keep the full Zoho snapshot locally; send useful customer annotations only
// through the documented bill notes field, never arbitrary contact API fields.
function customerBillNotes(details = {}) {
  const zoho = details.zoho_contact || {};
  const people = (Array.isArray(zoho.contact_persons) ? zoho.contact_persons : []).map(person =>
    [person?.salutation, person?.first_name, person?.last_name].filter(populated).join(' ')).filter(Boolean);
  const fields = [
    ['Customer', details.customer_name || zoho.display_name || zoho.contact_name],
    ['Customer company', details.customer_company_name || zoho.company_name],
    ['Customer display name', details.display_name || zoho.display_name],
    ['Customer contact person', details.customer_contact_person || zoho.contact_person || people.join('; ')],
    ['Customer email', details.customer_email || zoho.email],
    ['Customer phone', details.customer_phone || zoho.phone],
    ['Customer mobile', details.customer_mobile || zoho.mobile],
    ['Customer website', details.customer_website || zoho.website],
    ['Customer TRN', zoho.tax_registration_number || zoho.tax_reg_no || zoho.vat_reg_no || zoho.gst_no || details.customer_trn],
    ['Customer tax treatment', zoho.tax_treatment || zoho.vat_treatment],
    ['Customer address', addressText(details.customer_address)],
    ['Customer billing address', addressText(zoho.billing_address || details.customer_billing_address)],
    ['Customer shipping address', addressText(zoho.shipping_address || details.customer_shipping_address)],
    ['Customer code', zoho.customer_code || zoho.contact_number || details.customer_code],
    ['Customer currency', zoho.currency_code || zoho.currency_id],
    ['Customer payment terms', zoho.payment_terms_label || zoho.payment_terms],
    ['Customer status', details.customer_status || zoho.status],
    ['Customer notes', details.customer_notes || zoho.notes],
    ['Customer organization ID', details.organization_id],
  ];
  for (const [index, person] of (Array.isArray(zoho.contact_persons) ? zoho.contact_persons : []).entries()) {
    const name = [person?.salutation, person?.first_name, person?.last_name].filter(populated).join(' ') || person?.name;
    const contact = [name, person?.is_primary_contact ? '(primary)' : '', person?.designation, person?.department,
      person?.email ? `Email: ${person.email}` : '', person?.phone ? `Phone: ${person.phone}` : '',
      person?.mobile ? `Mobile: ${person.mobile}` : ''].filter(populated).join(' | ');
    fields.push([`Customer contact ${index + 1}`, contact]);
  }
  const addresses = zoho.addresses || zoho.other_addresses;
  for (const [index, address] of (Array.isArray(addresses) ? addresses : []).entries()) {
    fields.push([`Customer additional address ${index + 1}`, addressText(address)]);
  }
  for (const field of Array.isArray(zoho.custom_fields) ? zoho.custom_fields : []) {
    if (!field || typeof field !== 'object') continue;
    const label = field.label || field.field_name || field.api_name || field.customfield_id || 'Custom field';
    fields.push([`Customer ${label}`, fieldText(populated(field.value_formatted) ? field.value_formatted : field.value)]);
  }
  fields.push(['Project/site', details.project_site]);
  return fields.filter(([, value]) => populated(value)).map(([label, value]) => `${label}: ${fieldText(value)}`);
}

module.exports = { mergeCustomerData, parseManualCustomerDetails, customerBillNotes };
