'use strict';

const axios = require('axios');
const { parsePhoneNumberFromString } = require('libphonenumber-js/max');
const { normalizePhone } = require('../../utils/phone');
const { createZohoAuthService } = require('./zohoAuthService');
const { ZohoError, configError, validateZohoUrl, requestOptions, safeProviderCode, apiError } = require('./zohoSupport');

const DEFAULT_FIELD_MAPPING = Object.freeze({
  name: null, firstName: 'First_Name', lastName: 'Last_Name',
  phone: 'Phone', email: 'Email', company: 'Company', location: 'City',
  leadSource: 'Lead_Source', originalMessage: 'Description',
  service: null, requirement: null, notes: null,
});

function parseFieldMapping(raw) {
  let overrides = {};
  if (raw) {
    try { overrides = JSON.parse(raw); } catch { throw configError('ZOHO_FIELD_MAPPING must be a JSON object.'); }
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw configError('ZOHO_FIELD_MAPPING must be a JSON object.');
    }
  }
  const mapping = { ...DEFAULT_FIELD_MAPPING };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_FIELD_MAPPING, key) ||
        (value !== null && (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(value) ||
          ['id', 'constructor', 'prototype'].includes(value.toLowerCase())))) {
      throw configError('ZOHO_FIELD_MAPPING contains an unsupported key or field API name.');
    }
    mapping[key] = value;
  }
  // Mapping the canonical full name to Last_Name is a supported alternative to splitting it.
  if (mapping.name === mapping.lastName && mapping.name) {
    mapping.lastName = null;
    if (!Object.hasOwn(overrides, 'firstName')) mapping.firstName = null;
  }
  for (const key of ['phone', 'email', 'leadSource', 'originalMessage']) {
    if (!mapping[key]) throw configError(`ZOHO_FIELD_MAPPING must retain the ${key} mapping.`);
  }
  if (!mapping.name && !mapping.lastName) throw configError('ZOHO_FIELD_MAPPING must retain a name mapping.');
  const fields = Object.values(mapping).filter(Boolean);
  if (new Set(fields).size !== fields.length) {
    throw configError('Each ZOHO_FIELD_MAPPING destination must be unique.');
  }
  return mapping;
}

function inputError(message) { return new ZohoError('ZOHO_INPUT', message); }

function optionalText(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 32000 || /\u0000/.test(value)) {
    throw inputError('Lead fields must contain bounded text values.');
  }
  return value.trim() || undefined;
}

function mapLeadToZoho(lead, originalText, mapping = DEFAULT_FIELD_MAPPING) {
  if (!lead || typeof lead !== 'object' || Array.isArray(lead)) throw inputError('A lead object is required.');
  const name = optionalText(lead.name);
  if (!name) throw inputError('A customer name is required.');
  const parts = name.split(/\s+/);
  const values = {
    name, firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : undefined,
    lastName: parts.at(-1), leadSource: 'WhatsApp',
  };
  for (const field of ['phone', 'email', 'company', 'service', 'location', 'requirement', 'notes']) {
    values[field] = optionalText(lead[field]);
  }
  if (values.phone) {
    values.phone = normalizePhone(values.phone);
    if (!values.phone) throw inputError('A valid customer phone number is required.');
  }
  if (values.email) {
    values.email = normalizeEmail(values.email);
    if (!values.email) throw inputError('A valid customer email address is required.');
  }
  if (!values.phone && !values.email) throw inputError('A customer phone number or email address is required.');

  const original = originalText === undefined ? lead.originalMessage : originalText;
  if (original !== undefined && original !== null &&
      (typeof original !== 'string' || original.length > 32000 || /\u0000/.test(original))) {
    throw inputError('The original message must contain bounded text.');
  }
  const description = [];
  // Do not trim, summarize, or silently truncate the original message.
  if (typeof original === 'string' && original.length) description.push(`Original WhatsApp message:\n${original}`);
  for (const [field, label] of [['service', 'Service'], ['requirement', 'Requirement'], ['notes', 'Notes']]) {
    if (values[field]) description.push(`${label}: ${values[field]}`);
  }
  values.originalMessage = description.length ? description.join('\n\n') : undefined;
  const record = {};
  for (const [source, destination] of Object.entries(mapping)) {
    if (destination && values[source] !== undefined) record[destination] = values[source];
  }
  // Zoho requires its standard Last_Name field even when storing the full name elsewhere.
  if (!record.Last_Name) record.Last_Name = values.lastName;
  for (const value of Object.values(record)) {
    if (value.length > 32000) throw inputError('The CRM description exceeds the supported length; the original message remains in local storage.');
  }
  return record;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@(),:;<>\\]+@[^\s@(),:;<>\\]+\.[^\s@(),:;<>\\]+$/.test(email)) return null;
  return email;
}

function escapeCriteriaValue(value) {
  return String(value).replace(/[\\(),]/g, '\\$&');
}

function validateId(id) {
  if (typeof id !== 'string' || !/^\d{1,40}$/.test(id)) throw inputError('A valid Zoho lead ID is required.');
  return id;
}

function phoneMatches(value, normalized, country) {
  if (normalizePhone(value) === normalized) return true;
  // A CRM record may hold a national-format number. Its candidate region comes
  // from the explicitly normalized search target, never an arbitrary default.
  if (!country || typeof value !== 'string' || value.length > 80 || !/^[\d\s().-]+$/.test(value)) return false;
  try {
    const parsed = parsePhoneNumberFromString(value, { defaultCountry: country, extract: false });
    return Boolean(parsed?.isValid() && !parsed.ext && parsed.number === normalized);
  } catch { return false; }
}

function createZohoLeadService({ env = process.env, http = axios, auth, logger } = {}) {
  const tokenService = auth || createZohoAuthService({ env, http });

  function settings() {
    const apiBase = env.ZOHO_API_BASE_URL || (tokenService.getApiBaseUrl ? tokenService.getApiBaseUrl() : null);
    return {
      baseUrl: validateZohoUrl(apiBase, 'api'),
      options: requestOptions(env), mapping: parseFieldMapping(env.ZOHO_FIELD_MAPPING),
    };
  }

  async function request(method, path, { params, data, headers } = {}) {
    const { baseUrl, options } = settings();
    const mutation = method !== 'GET';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await tokenService.getAccessToken();
      let response;
      try {
        response = await http.request({
          ...options, method, url: `${baseUrl}${path}`, params, data,
          headers: { ...headers, Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
        });
      } catch (error) {
        if (error?.response) response = error.response;
        else throw apiError(undefined, undefined, { mutation, transport: true });
      }
      const status = response?.status;
      const code = safeProviderCode(response?.data);
      // A definite authentication rejection has not executed a mutation.
      if (status === 401 && code !== 'OAUTH_SCOPE_MISMATCH' && attempt === 0) {
        tokenService.invalidate(token);
        continue;
      }
      if (!Number.isInteger(status) || status < 200 || status >= 300 || response?.data?.status === 'error' ||
          (response?.data?.code && response.data.code !== 'SUCCESS')) {
        throw apiError(response?.data, status, { mutation });
      }
      return response;
    }
    throw new ZohoError('ZOHO_AUTH', 'Zoho authentication failed.');
  }

  async function search(criteria, matches) {
    const matched = new Map();
    for (let page = 1; page <= 10; page += 1) {
      const response = await request('GET', '/Leads/search', { params: { criteria, page, per_page: 200 } });
      if (response.status === 204) return matched.size ? [...matched.values()][0] : null;
      if (!Array.isArray(response.data?.data)) {
        throw new ZohoError('ZOHO_RESPONSE', 'Zoho returned an invalid search response.');
      }
      for (const record of response.data.data) {
        if (!record || typeof record !== 'object') throw new ZohoError('ZOHO_RESPONSE', 'Zoho returned an invalid lead record.');
        if (record.status === 'error') throw apiError(record, response.status);
        if (matches(record)) {
          validateId(record.id);
          matched.set(record.id, record);
        }
      }
      if (matched.size > 1) {
        throw new ZohoError('ZOHO_AMBIGUOUS_MATCH', 'More than one CRM lead matches this contact; manual review is required.');
      }
      if (!response.data.info?.more_records) return matched.size ? [...matched.values()][0] : null;
    }
    throw new ZohoError('ZOHO_SEARCH_LIMIT', 'The CRM search could not be checked completely; manual review is required.');
  }

  async function searchLeadByPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) throw inputError('A valid customer phone number is required for CRM search.');
    const { mapping } = settings();
    const fields = [...new Set([mapping.phone, 'Phone', 'Mobile'])];
    const target = parsePhoneNumberFromString(normalized);
    const nationalNumber = target?.nationalNumber;
    const values = [...new Set([normalized, normalized.slice(1), nationalNumber].filter(Boolean))];
    const criteria = `(${fields.flatMap((field) => values.map((value) =>
      `(${field}:equals:${escapeCriteriaValue(value)})`)).join('or')})`;
    logger?.info?.({ event: 'zoho_search', contactType: 'phone' });
    return search(criteria, (record) => fields.some((field) => phoneMatches(record[field], normalized, target?.country)));
  }

  async function searchLeadByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) throw inputError('A valid customer email address is required for CRM search.');
    const { mapping } = settings();
    logger?.info?.({ event: 'zoho_search', contactType: 'email' });
    return search(`(${mapping.email}:equals:${escapeCriteriaValue(normalized)})`,
      (record) => normalizeEmail(record[mapping.email]) === normalized);
  }

  function mutationResult(response, expectedId) {
    const result = response.data?.data?.[0];
    if (!result || response.data.data.length !== 1) {
      throw new ZohoError('ZOHO_RESPONSE', 'Zoho returned an invalid write response; verify the CRM before retrying.', { uncertain: true });
    }
    if (typeof result !== 'object' || !['success', 'error'].includes(result.status) || typeof result.code !== 'string') {
      throw new ZohoError('ZOHO_RESPONSE', 'Zoho returned an invalid write response; verify the CRM before retrying.', { uncertain: true });
    }
    if (result.status !== 'success' || result.code !== 'SUCCESS') {
      throw apiError(result, response.status, { mutation: true });
    }
    const id = result.details?.id;
    if (typeof id !== 'string' || !/^\d{1,40}$/.test(id) || (expectedId && id !== expectedId)) {
      throw new ZohoError('ZOHO_RESPONSE', 'Zoho returned an invalid write identifier; verify the CRM before retrying.', { uncertain: true });
    }
    return { id };
  }

  async function createLead(lead, originalText) {
    const record = mapLeadToZoho(lead, originalText, settings().mapping);
    logger?.info?.({ event: 'zoho_create' });
    const response = await request('POST', '/Leads', { data: { data: [record] } });
    return mutationResult(response);
  }

  async function getLead(id) {
    validateId(id);
    const response = await request('GET', `/Leads/${id}`);
    if (response.status === 204) return null;
    const record = response.data?.data?.[0];
    if (record?.status === 'error') throw apiError(record, response.status);
    if (!record || record.id !== id || response.data.data.length !== 1) {
      throw new ZohoError('ZOHO_RESPONSE', 'Zoho returned an invalid lead response.');
    }
    return record;
  }

  async function updateLead(id, lead, originalText) {
    validateId(id);
    const { mapping } = settings();
    const record = mapLeadToZoho(lead, originalText, mapping);
    const existing = await getLead(id);
    if (!existing) throw new ZohoError('ZOHO_NOT_FOUND', 'The CRM lead no longer exists.');
    const descriptionField = mapping.originalMessage;
    if (record[descriptionField] && typeof existing[descriptionField] === 'string' && existing[descriptionField]) {
      record[descriptionField] = existing[descriptionField].includes(record[descriptionField])
        ? existing[descriptionField]
        : `${existing[descriptionField]}\n\n--- WhatsApp update ---\n${record[descriptionField]}`;
      if (record[descriptionField].length > 32000) {
        throw inputError('The CRM description is full; the original message remains in local storage.');
      }
    }
    const headers = {};
    if (typeof existing.Modified_Time === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(existing.Modified_Time)) {
      headers['If-Unmodified-Since'] = existing.Modified_Time;
    }
    logger?.info?.({ event: 'zoho_update' });
    const response = await request('PUT', `/Leads/${id}`, { headers, data: { data: [{ ...record, id }] } });
    return mutationResult(response, id);
  }

  return { searchLeadByPhone, searchLeadByEmail, createLead, updateLead, getLead };
}

module.exports = { createZohoLeadService, DEFAULT_FIELD_MAPPING, parseFieldMapping, mapLeadToZoho, escapeCriteriaValue };
