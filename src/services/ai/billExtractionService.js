'use strict';

const https = require('node:https');
const axios = require('axios');
const { billExtractionJsonSchema, extractedBillEnvelopeSchema, TRACKED_FIELDS } = require('../books/billSchema');
const { validateBill } = require('../books/billValidator');
const { resolveModel, openAiReasoning, formatRouterLog } = require('./modelRouter');

const verifiedAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: true });

const MAX_BILL_INPUT_CHARS = 32768;
const MAX_BILL_INPUT_BYTES = 65536;

const BILL_EXTRACTION_INSTRUCTIONS = [
  'You are an expert purchase-bill and supplier-invoice extraction engine.',
  'You are an extraction engine, not an accounting decision-maker.',
  'Extract only facts strictly grounded in the supplied invoice, receipt, purchase bill, or delivery note.',
  'Never invent vendor names, invoice/bill numbers, dates, prices, quantities, tax amounts, currency, or line items.',
  'The seller or supplier issuing the document is the vendor_name. The recipient/buyer is NOT the vendor.',
  'bill_number is the invoice, bill, or receipt reference number.',
  'bill_date is the date of issuance.',
  'due_date is the payment due date if stated.',
  'currency is the 3-letter ISO currency code (e.g. AED, USD, EUR, GBP) or currency symbol if stated; otherwise null.',
  'payment_type is the explicitly stated payment method if present; use only Cash, Bank Remittance, Bank Transfer, Credit Card, or Cheque; otherwise null.',
  'subtotal is the net monetary amount before tax/VAT.',
  'tax_amount is the VAT or tax amount. If no tax is mentioned, leave it null; do NOT fabricate tax or assume 0 unless explicitly stated.',
  'total_amount is the final gross amount payable.',
  'line_items is the list of purchased goods or services, each with name, description, quantity, rate, and amount.',
  'Delivery notes often do not contain prices; leave rate and amount null rather than inventing numbers.',
  'Treat receipts differently from formal supplier invoices when necessary.',
  'Avoid duplicating the grand total or subtotal as a line item.',
  'Return null for any field that is missing, unknown, or ambiguous in the source text.',
  'For confidence, provide a number between 0 and 1 representing extraction certainty for each core field.',
  'Output strictly valid JSON matching the schema.',
].join(' ');

function safeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readInteger(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw safeError('AI_CONFIGURATION_ERROR', 'AI configuration is invalid.');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw safeError('AI_CONFIGURATION_ERROR', 'AI configuration is invalid.');
  }
  return number;
}

function getConfiguration(env) {
  const key = env.OPENAI_API_KEY;
  const model = env.OPENAI_MODEL_DEFAULT || env.OPENAI_MODEL;
  if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n]/.test(key)
      || typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(model)) {
    throw safeError('AI_CONFIGURATION_ERROR', 'Configure the AI provider API key and model.');
  }
  return {
    key: key.trim(),
    model,
    timeout: readInteger(env.AI_TIMEOUT_MS, 20000, 1000, 60000),
    maxOutputTokens: readInteger(env.AI_MAX_OUTPUT_TOKENS, 4096, 256, 16384),
  };
}

function openAiText(data) {
  if (!data || data.status !== 'completed' || data.error || data.incomplete_details || !Array.isArray(data.output)) {
    throw safeError('AI_MALFORMED_RESPONSE', 'Incomplete model response.');
  }
  const messages = data.output.filter((item) => item?.type === 'message');
  if (messages.length !== 1 || data.output.some((item) => !['message', 'reasoning'].includes(item?.type))) {
    throw safeError('AI_MALFORMED_RESPONSE', 'Unexpected model response structure.');
  }
  const message = messages[0];
  if (message.role !== 'assistant' || message.status !== 'completed' || !Array.isArray(message.content)
      || message.content.length === 0 || message.content.some((part) => part?.type !== 'output_text' || typeof part.text !== 'string')) {
    throw safeError('AI_MALFORMED_RESPONSE', 'Refused or invalid model response.');
  }
  return message.content.map((part) => part.text).join('');
}

function requestOptions(timeout) {
  return {
    timeout,
    signal: AbortSignal.timeout(timeout),
    maxRedirects: 0,
    maxBodyLength: 65536,
    maxContentLength: 262144,
    httpsAgent: verifiedAgent,
    proxy: false,
    responseType: 'json',
    transitional: { silentJSONParsing: false },
    validateStatus: (status) => status >= 200 && status < 300,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  };
}

function classifyError(error) {
  const status = error?.response?.status;
  if (status === 401 || status === 403) {
    return safeError('AI_AUTHENTICATION_ERROR', 'AI authentication failed.');
  }
  if (status === 429) {
    return safeError('AI_RATE_LIMIT', 'AI rate limit exceeded.');
  }
  if (status === 408) {
    return safeError('AI_TIMEOUT', 'AI request timed out.');
  }
  if (Number.isInteger(status) && status >= 500 && status <= 599) {
    return safeError('AI_UNAVAILABLE', 'AI service is temporarily unavailable.');
  }
  if (['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED'].includes(error?.code)) {
    return safeError('AI_TIMEOUT', 'AI request timed out.');
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK', 'EPIPE'].includes(error?.code)) {
    return safeError('AI_UNAVAILABLE', 'AI connection failure.');
  }
  if (error?.code === 'AI_MALFORMED_RESPONSE' || error?.code === 'ERR_BAD_RESPONSE') {
    return safeError('AI_MALFORMED_RESPONSE', 'AI returned an unparseable response.');
  }
  if (error?.code === 'AI_CONFIGURATION_ERROR' || error?.code === 'AI_INPUT_INVALID') {
    return error;
  }
  return safeError('AI_REQUEST_FAILED', 'AI request failed.');
}

/**
 * Checks whether a given string value appears verbatim in the text (case-insensitive).
 */
function textContains(sourceText, candidate) {
  if (!candidate || typeof candidate !== 'string') return false;
  const cleanSource = sourceText.replace(/\s+/gu, ' ').toLowerCase();
  const cleanCand = candidate.replace(/\s+/gu, ' ').trim().toLowerCase();
  if (!cleanCand) return false;
  return cleanSource.includes(cleanCand);
}

/**
 * Checks whether a numeric value appears in the text in various standard formats.
 */
function numberAppearsInText(sourceText, num) {
  if (num === null || num === undefined || !Number.isFinite(num)) return false;
  const s = sourceText.replace(/\s+/gu, ' ');
  const numStr = String(num);
  const formattedWithCommas = num.toLocaleString('en-US');
  const twoDecimals = num.toFixed(2);
  const twoDecimalsCommas = num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const candidates = [numStr, formattedWithCommas, twoDecimals, twoDecimalsCommas];
  return candidates.some((cand) => s.includes(cand));
}

/**
 * Determines grounding state ('explicit', 'inferred', 'missing') for each tracked field.
 */
function computeGrounding(bill, originalText) {
  const grounding = {};

  // vendor_name
  if (!bill.vendor_name) {
    grounding.vendor_name = 'missing';
  } else if (textContains(originalText, bill.vendor_name)) {
    grounding.vendor_name = 'explicit';
  } else {
    grounding.vendor_name = 'inferred';
  }

  // bill_number
  if (!bill.bill_number) {
    grounding.bill_number = 'missing';
  } else if (textContains(originalText, bill.bill_number)) {
    grounding.bill_number = 'explicit';
  } else {
    grounding.bill_number = 'inferred';
  }

  // bill_date
  if (!bill.bill_date) {
    grounding.bill_date = 'missing';
  } else if (textContains(originalText, bill.bill_date)) {
    grounding.bill_date = 'explicit';
  } else {
    // Check if parts of the date appear
    const parts = bill.bill_date.split('-');
    if (parts.length === 3 && originalText.includes(parts[0]) && originalText.includes(parts[2])) {
      grounding.bill_date = 'explicit';
    } else {
      grounding.bill_date = 'inferred';
    }
  }

  // due_date
  if (!bill.due_date) {
    grounding.due_date = 'missing';
  } else if (textContains(originalText, bill.due_date)) {
    grounding.due_date = 'explicit';
  } else {
    grounding.due_date = 'inferred';
  }

  // currency
  if (!bill.currency) {
    grounding.currency = 'missing';
  } else if (textContains(originalText, bill.currency)) {
    grounding.currency = 'explicit';
  } else {
    grounding.currency = 'inferred';
  }

  // subtotal
  if (bill.subtotal === null || bill.subtotal === undefined) {
    grounding.subtotal = 'missing';
  } else if (numberAppearsInText(originalText, bill.subtotal)) {
    grounding.subtotal = 'explicit';
  } else {
    grounding.subtotal = 'inferred';
  }

  // tax_amount
  if (bill.tax_amount === null || bill.tax_amount === undefined) {
    grounding.tax_amount = 'missing';
  } else if (numberAppearsInText(originalText, bill.tax_amount)) {
    grounding.tax_amount = 'explicit';
  } else {
    grounding.tax_amount = 'inferred';
  }

  // total_amount
  if (bill.total_amount === null || bill.total_amount === undefined) {
    grounding.total_amount = 'missing';
  } else if (numberAppearsInText(originalText, bill.total_amount)) {
    grounding.total_amount = 'explicit';
  } else {
    grounding.total_amount = 'inferred';
  }

  // line_items
  if (!Array.isArray(bill.line_items) || bill.line_items.length === 0) {
    grounding.line_items = 'missing';
  } else {
    const allExplicit = bill.line_items.every((item) => textContains(originalText, item.name));
    grounding.line_items = allExplicit ? 'explicit' : 'inferred';
  }

  return grounding;
}

/**
 * Computes or adjusts confidence based on model confidence and groundedness.
 */
function resolveConfidence(modelConfidence = {}, grounding = {}) {
  const resolved = {};
  for (const field of TRACKED_FIELDS) {
    const ground = grounding[field] || 'missing';
    const rawVal = modelConfidence[field];

    if (ground === 'missing') {
      resolved[field] = 0.0;
    } else if (typeof rawVal === 'number' && Number.isFinite(rawVal) && rawVal >= 0 && rawVal <= 1) {
      resolved[field] = ground === 'inferred' ? Math.min(rawVal, 0.85) : rawVal;
    } else if (ground === 'explicit') {
      resolved[field] = 0.95;
    } else {
      resolved[field] = 0.75;
    }
  }
  return resolved;
}

function createBillExtractionService({ env = process.env, http = axios, logger } = {}) {
  function log(level, metadata) {
    try { logger?.[level]?.(metadata); } catch { /* Ignore logger errors */ }
  }

  async function extractBillFromText({ text, sourceType = 'document_text', options = {} } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_BILL_INPUT_CHARS
        || Buffer.byteLength(text, 'utf8') > MAX_BILL_INPUT_BYTES) {
      return {
        success: false,
        bill: null,
        error: {
          code: 'AI_INPUT_INVALID',
          message: 'A nonempty text within supported size limits is required for bill extraction.',
        },
      };
    }

    let configuration;
    try {
      configuration = getConfiguration(env);
    } catch (err) {
      return {
        success: false,
        bill: null,
        error: {
          code: err.code || 'AI_CONFIGURATION_ERROR',
          message: err.message || 'AI configuration error.',
        },
      };
    }

    const { key, timeout, maxOutputTokens } = configuration;
    const opts = typeof options === 'object' && options !== null ? options : {};
    const routing = resolveModel({ task: 'bill_extraction', text, ...opts }, env);
    const model = routing.model;

    log('info', { event: 'ai.bill_extraction.started', tier: routing.tier, model });
    try { logger?.info?.(formatRouterLog(routing)); } catch { /* Ignore */ }

    const reqOpts = requestOptions(timeout);
    reqOpts.headers.Authorization = `Bearer ${key}`;

    let response;
    try {
      response = await http.post('https://api.openai.com/v1/responses', {
        model,
        store: false,
        ...openAiReasoning(model, env),
        input: [
          { role: 'system', content: BILL_EXTRACTION_INSTRUCTIONS },
          { role: 'user', content: JSON.stringify({ document_text: text, source_type: sourceType }) },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'purchase_bill',
            strict: true,
            schema: billExtractionJsonSchema,
          },
        },
        max_output_tokens: maxOutputTokens,
        truncation: 'disabled',
      }, reqOpts);
    } catch (err) {
      const classified = classifyError(err);
      log('error', { event: 'ai.bill_extraction.failed', code: classified.code });
      return {
        success: false,
        bill: null,
        error: {
          code: classified.code,
          message: classified.message,
        },
      };
    }

    if (response?.status !== undefined && (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300)) {
      const classified = classifyError({ response });
      return {
        success: false,
        bill: null,
        error: {
          code: classified.code,
          message: classified.message,
        },
      };
    }

    let parsedText;
    try {
      parsedText = openAiText(response?.data);
    } catch (err) {
      const classified = classifyError(err);
      return {
        success: false,
        bill: null,
        error: {
          code: classified.code,
          message: classified.message,
        },
      };
    }

    let rawJson;
    try {
      rawJson = JSON.parse(parsedText);
    } catch {
      return {
        success: false,
        bill: null,
        error: {
          code: 'AI_MALFORMED_RESPONSE',
          message: 'Model response could not be parsed as JSON.',
        },
      };
    }

    // Validate envelope with Zod schema
    const envelopeParsed = extractedBillEnvelopeSchema.safeParse(rawJson);
    if (!envelopeParsed.success) {
      return {
        success: false,
        bill: null,
        error: {
          code: 'AI_MALFORMED_RESPONSE',
          message: 'Model response violated structured bill schema.',
          details: envelopeParsed.error.issues.map((i) => i.message),
        },
      };
    }

    const { bill: rawBill, confidence: rawConfidence } = envelopeParsed.data;

    // Grounding determination against original source text
    const grounding = computeGrounding(rawBill, text);

    // Confidence resolution
    const confidence = resolveConfidence(rawConfidence, grounding);

    // Business accounting validation & normalization
    const validation = validateBill(rawBill);

    log('info', { event: 'ai.bill_extraction.succeeded', valid: validation.valid });

    return {
      success: true,
      bill: validation.normalizedBill,
      grounding,
      confidence,
      validation: {
        valid: validation.valid,
        issues: validation.issues,
      },
    };
  }

  async function mergeAdditionalInfo({ currentBill = {}, additionalText = '', options = {} } = {}) {
    if (!additionalText || typeof additionalText !== 'string' || !additionalText.trim()) {
      return {
        success: true,
        bill: currentBill,
        validation: validateBill(currentBill),
      };
    }

    let configuration;
    try {
      configuration = getConfiguration(env);
    } catch {
      // Offline / fallback heuristic merge
      const merged = { ...currentBill };
      if (/vendor\s+(?:is|name\s+is)?\s*[:=]?\s*([^\n,]+)/i.test(additionalText)) {
        merged.vendor_name = additionalText.match(/vendor\s+(?:is|name\s+is)?\s*[:=]?\s*([^\n,]+)/i)[1].trim();
      }
      if (/bill\s*(?:no|number|#)?\s*(?:is)?\s*[:=]?\s*([^\n,\s]+)/i.test(additionalText)) {
        merged.bill_number = additionalText.match(/bill\s*(?:no|number|#)?\s*(?:is)?\s*[:=]?\s*([^\n,\s]+)/i)[1].trim();
      }
      if (/(?:tax|vat)\s*(?:is)?\s*[:=]?\s*([\d.]+)/i.test(additionalText)) {
        merged.tax_amount = parseFloat(additionalText.match(/(?:tax|vat)\s*(?:is)?\s*[:=]?\s*([\d.]+)/i)[1]);
      }
      if (/total\s*(?:is|amount)?\s*[:=]?\s*([\d.]+)/i.test(additionalText)) {
        merged.total_amount = parseFloat(additionalText.match(/total\s*(?:is|amount)?\s*[:=]?\s*([\d.]+)/i)[1]);
      }
      const val = validateBill(merged);
      return { success: true, bill: val.normalizedBill, validation: val };
    }

    const { key, timeout, maxOutputTokens } = configuration;
    const opts = typeof options === 'object' && options !== null ? options : {};
    const routing = resolveModel({ task: 'bill_merge', text: additionalText, ...opts }, env);
    const model = routing.model;

    const reqOpts = requestOptions(timeout);
    reqOpts.headers.Authorization = `Bearer ${key}`;

    const prompt = [
      'You are an expert purchase-bill refinement assistant.',
      'Merge the user\'s additional details into the existing bill.',
      'Retain existing valid fields unless the new information specifically updates or adds to them.',
      'Never invent information.',
      'Output strictly valid JSON matching the schema.',
    ].join(' ');

    try {
      const response = await http.post('https://api.openai.com/v1/responses', {
        model,
        store: false,
        ...openAiReasoning(model, env),
        input: [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: JSON.stringify({
              current_bill: currentBill,
              additional_information: additionalText,
            }),
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'purchase_bill',
            strict: true,
            schema: billExtractionJsonSchema,
          },
        },
        max_output_tokens: maxOutputTokens,
        truncation: 'disabled',
      }, reqOpts);

      const parsedText = openAiText(response?.data);
      const rawJson = JSON.parse(parsedText);
      const envelopeParsed = extractedBillEnvelopeSchema.safeParse(rawJson);
      if (envelopeParsed.success) {
        const mergedBill = envelopeParsed.data.bill;
        const val = validateBill(mergedBill);
        return { success: true, bill: val.normalizedBill, validation: val };
      }
    } catch {
      // Fall back safely to heuristic merge on error
    }

    const fallbackMerged = { ...currentBill };
    if (/vendor\s+(?:is|name\s+is)?\s*[:=]?\s*([^\n,]+)/i.test(additionalText)) {
      fallbackMerged.vendor_name = additionalText.match(/vendor\s+(?:is|name\s+is)?\s*[:=]?\s*([^\n,]+)/i)[1].trim();
    }
    if (/bill\s*(?:no|number|#)?\s*(?:is)?\s*[:=]?\s*([^\n,\s]+)/i.test(additionalText)) {
      fallbackMerged.bill_number = additionalText.match(/bill\s*(?:no|number|#)?\s*(?:is)?\s*[:=]?\s*([^\n,\s]+)/i)[1].trim();
    }
    if (/(?:tax|vat)\s*(?:is)?\s*[:=]?\s*([\d.]+)/i.test(additionalText)) {
      fallbackMerged.tax_amount = parseFloat(additionalText.match(/(?:tax|vat)\s*(?:is)?\s*[:=]?\s*([\d.]+)/i)[1]);
    }
    if (/total\s*(?:is|amount)?\s*[:=]?\s*([\d.]+)/i.test(additionalText)) {
      fallbackMerged.total_amount = parseFloat(additionalText.match(/total\s*(?:is|amount)?\s*[:=]?\s*([\d.]+)/i)[1]);
    }
    const val = validateBill(fallbackMerged);
    return { success: true, bill: val.normalizedBill, validation: val };
  }

  async function applyEditInstructions({ currentBill = {}, editInstruction = '', options = {} } = {}) {
    if (!editInstruction || typeof editInstruction !== 'string' || !editInstruction.trim()) {
      return {
        success: true,
        bill: currentBill,
        validation: validateBill(currentBill),
      };
    }

    let configuration;
    try {
      configuration = getConfiguration(env);
    } catch {
      // Offline / fallback heuristic edit
      const edited = { ...currentBill };
      if (/change\s+total\s+(?:to)?\s*([\d.]+)/i.test(editInstruction)) {
        edited.total_amount = parseFloat(editInstruction.match(/change\s+total\s+(?:to)?\s*([\d.]+)/i)[1]);
      }
      if (/change\s+vendor\s+(?:to)?\s*([^\n,]+)/i.test(editInstruction)) {
        edited.vendor_name = editInstruction.match(/change\s+vendor\s+(?:to)?\s*([^\n,]+)/i)[1].trim();
      }
      if (/change\s+date\s+(?:to)?\s*([^\n,]+)/i.test(editInstruction)) {
        edited.bill_date = editInstruction.match(/change\s+date\s+(?:to)?\s*([^\n,]+)/i)[1].trim();
      }
      if (/change\s+bill\s*(?:number|#)?\s*(?:to)?\s*([^\n,\s]+)/i.test(editInstruction)) {
        edited.bill_number = editInstruction.match(/change\s+bill\s*(?:number|#)?\s*(?:to)?\s*([^\n,\s]+)/i)[1].trim();
      }
      const val = validateBill(edited);
      return { success: true, bill: val.normalizedBill, validation: val };
    }

    const { key, timeout, maxOutputTokens } = configuration;
    const opts = typeof options === 'object' && options !== null ? options : {};
    const routing = resolveModel({ task: 'bill_edit', text: editInstruction, ...opts }, env);
    const model = routing.model;

    const reqOpts = requestOptions(timeout);
    reqOpts.headers.Authorization = `Bearer ${key}`;

    const prompt = [
      'You are an expert purchase-bill editing assistant.',
      'Apply only the requested user changes to the existing bill.',
      'Preserve all other fields unchanged. Never invent information.',
      'Output strictly valid JSON matching the schema.',
    ].join(' ');

    try {
      const response = await http.post('https://api.openai.com/v1/responses', {
        model,
        store: false,
        ...openAiReasoning(model, env),
        input: [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: JSON.stringify({
              current_bill: currentBill,
              edit_instruction: editInstruction,
            }),
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'purchase_bill',
            strict: true,
            schema: billExtractionJsonSchema,
          },
        },
        max_output_tokens: maxOutputTokens,
        truncation: 'disabled',
      }, reqOpts);

      const parsedText = openAiText(response?.data);
      const rawJson = JSON.parse(parsedText);
      const envelopeParsed = extractedBillEnvelopeSchema.safeParse(rawJson);
      if (envelopeParsed.success) {
        const editedBill = envelopeParsed.data.bill;
        const val = validateBill(editedBill);
        return { success: true, bill: val.normalizedBill, validation: val };
      }
    } catch {
      // Fall back safely to heuristic edit on error
    }

    const fallbackEdited = { ...currentBill };
    if (/change\s+total\s+(?:to)?\s*([\d.]+)/i.test(editInstruction)) {
      fallbackEdited.total_amount = parseFloat(editInstruction.match(/change\s+total\s+(?:to)?\s*([\d.]+)/i)[1]);
    }
    if (/change\s+vendor\s+(?:to)?\s*([^\n,]+)/i.test(editInstruction)) {
      fallbackEdited.vendor_name = editInstruction.match(/change\s+vendor\s+(?:to)?\s*([^\n,]+)/i)[1].trim();
    }
    if (/change\s+date\s+(?:to)?\s*([^\n,]+)/i.test(editInstruction)) {
      fallbackEdited.bill_date = editInstruction.match(/change\s+date\s+(?:to)?\s*([^\n,]+)/i)[1].trim();
    }
    if (/change\s+bill\s*(?:number|#)?\s*(?:to)?\s*([^\n,\s]+)/i.test(editInstruction)) {
      fallbackEdited.bill_number = editInstruction.match(/change\s+bill\s*(?:number|#)?\s*(?:to)?\s*([^\n,\s]+)/i)[1].trim();
    }
    const val = validateBill(fallbackEdited);
    return { success: true, bill: val.normalizedBill, validation: val };
  }

  return {
    extractBillFromText,
    mergeAdditionalInfo,
    applyEditInstructions,
  };
}

module.exports = {
  createBillExtractionService,
  BILL_EXTRACTION_INSTRUCTIONS,
  computeGrounding,
  resolveConfidence,
  classifyError,
};
