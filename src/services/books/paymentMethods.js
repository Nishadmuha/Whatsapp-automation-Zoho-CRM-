'use strict';

const PAYMENT_METHODS = Object.freeze([
  'Cash',
  'Bank Remittance',
  'Bank Transfer',
  'Credit Card',
  'Cheque',
]);

function normalizePaymentMethod(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return PAYMENT_METHODS.find(method => method.toLowerCase() === normalized) || null;
}

module.exports = { PAYMENT_METHODS, normalizePaymentMethod };
