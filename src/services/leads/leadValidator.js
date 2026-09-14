'use strict';

const { z } = require('zod');
const { leadSchema, LEAD_FIELDS } = require('../ai/leadExtractor');
const { normalizePhone } = require('../../utils/phone');
const { leadExtractionSchema } = require('../ai/leadExtraction');

const emailSchema = z.string().max(254).email();
const placeholders = /^(?:unknown|n\/?a|none|null|not (?:provided|known|available|specified)|unspecified)$/i;

function cleanText(value) {
  if (value === null) return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized && !placeholders.test(normalized) ? normalized : null;
}

function phoneAppearsInMessage(phone, originalText) {
  // Match whole contact-like tokens. Do not concatenate arbitrary digits elsewhere in the message.
  const candidates = originalText.match(/(?<![\p{L}\p{N}])(?:\+|00)?\d[\d .()\t-]{5,}\d(?![\p{L}\p{N}])/gu) || [];
  return candidates.some((candidate) => normalizePhone(candidate) === phone);
}

function emailAppearsInMessage(email, originalText) {
  const candidates = originalText.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/gi) || [];
  return candidates.some((candidate) => candidate.toLowerCase() === email);
}

function validateLead(raw, { originalText } = {}) {
  const parsed = leadSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      lead: Object.fromEntries(LEAD_FIELDS.map((field) => [field, null])),
      missing: ['customer name', 'customer phone number or email address'],
      errors: ['The extracted customer details could not be validated.'],
    };
  }
  const lead = Object.fromEntries(LEAD_FIELDS.map((field) => [field, cleanText(parsed.data[field])]));
  const missing = [];
  const errors = [];
  if (!lead.name || !/\p{L}/u.test(lead.name)) {
    lead.name = null;
    missing.push('customer name');
  }

  if (lead.phone) {
    lead.phone = normalizePhone(lead.phone);
    if (!lead.phone) errors.push('Please provide a valid customer phone number, including the country code for international numbers.');
  }
  if (lead.email) {
    lead.email = lead.email.toLowerCase();
    if (!emailSchema.safeParse(lead.email).success) {
      lead.email = null;
      errors.push('Please provide a valid customer email address.');
    }
  }

  if (originalText !== undefined) {
    if (typeof originalText !== 'string' || originalText.length > 16384) {
      errors.push('The original message could not be verified.');
      lead.phone = null;
      lead.email = null;
    } else {
      if (lead.phone && !phoneAppearsInMessage(lead.phone, originalText)) {
        lead.phone = null;
        errors.push('Please include the customer phone number in the message.');
      }
      if (lead.email && !emailAppearsInMessage(lead.email, originalText)) {
        lead.email = null;
        errors.push('Please include the customer email address in the message.');
      }
    }
  }

  if (!lead.phone && !lead.email) missing.push('customer phone number or email address');
  return { valid: missing.length === 0 && errors.length === 0, lead, missing, errors };
}

function validateLeadBusiness(result) {
  if (!leadExtractionSchema.safeParse(result).success) {
    return { valid: false, missing_fields: [], errors: ['LEAD_SCHEMA_INVALID'] };
  }
  if (!result.is_lead) return { valid: false, missing_fields: [], errors: ['NOT_A_LEAD'] };
  const present = value => typeof value === 'string' && value.trim().length > 0;
  // All individual fields are optional. Any grounded fact can be offered for
  // confirmation; only an explicit boss confirmation authorizes persistence.
  const meaningful = Object.values(result.lead).some(present);
  return { valid: meaningful, missing_fields: [], errors: meaningful ? [] : ['NOT_A_LEAD'] };
}

module.exports = { validateLead, validateLeadBusiness };
