'use strict';

const { parsePhoneNumberFromString } = require('libphonenumber-js/max');

function normalizePhone(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) return null;
  const input = value.trim();
  // Reject text, extensions, and mixed identifiers instead of extracting a number from them.
  if (!/^[+\d\s().-]+$/.test(input)) return null;
  let compact = input.replace(/[\s().-]/g, '');
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;
  if (/^971\d+$/.test(compact)) compact = `+${compact}`;
  const isUaeLocal = /^0\d{8,9}$/.test(compact);
  if (!/^\+[1-9]\d{6,14}$/.test(compact) && !isUaeLocal) return null;
  try {
    const phone = parsePhoneNumberFromString(compact, { defaultCountry: isUaeLocal ? 'AE' : undefined, extract: false });
    return phone?.isValid() && !phone.ext ? phone.number : null;
  } catch {
    return null;
  }
}

// Meta sender IDs carry their country code, even when the leading + is absent.
// Only recognized UAE local formats may acquire a country code here.
function normalizeSenderPhone(value) {
  if (typeof value !== 'string' || value.length > 80 || !/^[+\d ().-]+$/.test(value)) return null;
  let compact = value.trim().replace(/[ ().-]/g, '');
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;
  if (/^0\d{8,9}$/.test(compact)) return normalizePhone(compact);
  return /^\+?[1-9]\d{6,14}$/.test(compact) ? `+${compact.replace(/^\+/, '')}` : null;
}

module.exports = { normalizePhone, normalizeSenderPhone };
