'use strict';
const axios = require('axios');
const { Agent } = require('node:https');
const { createHash } = require('node:crypto');
const { createLogger } = require('../../utils/logger');
const { normalizeMediaMimeType, mediaKind, mediaSizeLimit } = require('../../utils/media');
const httpsAgent = new Agent({ rejectUnauthorized: true });
const SAFE_TRANSPORT_CODES = new Set(['ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ERR_NETWORK', 'ERR_CANCELED', 'ERR_BAD_RESPONSE', 'ERR_BAD_REQUEST']);
function failure(message, code, deliveryState = 'NOT_ATTEMPTED', details = {}) {
  return Object.assign(new Error(message), details, {
    code, deliveryState, attempted: deliveryState !== 'NOT_ATTEMPTED', uncertain: deliveryState === 'UNKNOWN',
  });
}

function readWhatsAppSendConfig(env = process.env) {
  const clean = (value) => typeof value === 'string' ? value.trim() : '';
  const accessToken = clean(env.WHATSAPP_ACCESS_TOKEN);
  const phoneNumberId = clean(env.WHATSAPP_PHONE_NUMBER_ID);
  const apiVersion = clean(env.META_GRAPH_API_VERSION || env.WHATSAPP_API_VERSION);
  if (!accessToken || accessToken.length > 4096 || /[^\x21-\x7e]/.test(accessToken)
      || !/^\d+$/.test(phoneNumberId) || !/^v\d+\.\d+$/.test(apiVersion)) {
    throw failure('Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID and META_GRAPH_API_VERSION (or WHATSAPP_API_VERSION).', 'ERR_WHATSAPP_CONFIG');
  }
  return { accessToken, phoneNumberId, apiVersion };
}

function validateRecipient(to) {
  if (typeof to !== 'string' || !/^\+?[1-9]\d{6,14}$/.test(to)) {
    throw failure('A valid international recipient is required.', 'ERR_WHATSAPP_INPUT');
  }
}

function validateTextMessage(to, text) {
  validateRecipient(to);
  if (typeof text !== 'string' || !text.trim() || Array.from(text).length > 4096) {
    throw failure('A 1–4096 character message is required.', 'ERR_WHATSAPP_INPUT');
  }
}

function validateTemplateMessage(to, templateName, languageCode) {
  validateRecipient(to);
  if (typeof templateName !== 'string' || !/^[a-z0-9_]{1,512}$/.test(templateName)
      || typeof languageCode !== 'string' || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(languageCode)) {
    throw failure('A valid template name and language code are required.', 'ERR_WHATSAPP_INPUT');
  }
}

function safeDetails(response, error) {
  const details = {};
  const status = response?.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) details.httpStatus = status;
  for (const [key, value] of [['metaCode', response?.data?.error?.code], ['metaSubcode', response?.data?.error?.error_subcode]]) {
    if (Number.isSafeInteger(value) && value >= 0) details[key] = value;
  }
  if (SAFE_TRANSPORT_CODES.has(error?.code)) details.transportCode = error.code;
  return details;
}

function explicitlyRejected(response, details) {
  if (details.httpStatus && (details.httpStatus < 200 || details.httpStatus >= 300)) return true;
  const error = response?.data?.error;
  return error && typeof error === 'object' && !Array.isArray(error)
    && (Number.isSafeInteger(error.code) || typeof error.message === 'string');
}

function createWhatsAppService({ env = process.env, http = axios, logger = createLogger(env) } = {}) {
  function log(level, metadata) {
    // A logger failure cannot change whether Meta accepted a message.
    try { logger?.[level]?.(metadata); } catch { /* Preserve delivery classification. */ }
  }
  async function send(payload) {
    const { accessToken, phoneNumberId, apiVersion } = readWhatsAppSendConfig(env);
    const options = {
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      timeout: 15000, signal: AbortSignal.timeout(15000), maxRedirects: 0, httpsAgent, proxy: false,
      maxContentLength: 1024 * 1024, maxBodyLength: 64 * 1024,
    };
    let response;
    let transportError;
    log('info', { event: 'whatsapp_send_started', type: payload.type });
    try {
      response = await http.post('https://graph.facebook.com/' + apiVersion + '/' + phoneNumberId + '/messages', payload, options);
    } catch (error) {
      transportError = error;
      response = error?.response;
    }
    const details = safeDetails(response, transportError);
    const rejected = explicitlyRejected(response, details);
    const id = response?.data?.messages?.[0]?.id;
    if (!transportError && !rejected && !response?.data?.error && typeof id === 'string' && /^[\x21-\x7e]{1,512}$/.test(id)
        && (response.status === undefined || (details.httpStatus >= 200 && details.httpStatus < 300))) {
      log('info', { event: 'whatsapp_send_accepted', type: payload.type });
      return response.data;
    }
    const deliveryState = rejected ? 'ATTEMPTED_FAILED' : 'UNKNOWN';
    log('error', { event: 'whatsapp_reply_failed', deliveryState, ...details });
    throw failure('WhatsApp message delivery failed.', 'ERR_WHATSAPP_SEND', deliveryState, details);
  }
  async function sendTextMessage(to, text) {
    validateTextMessage(to, text);
    return send({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
  }
  async function sendTemplateMessage(to, templateName, languageCode) {
    validateTemplateMessage(to, templateName, languageCode);
    return send({
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name: templateName, language: { code: languageCode } },
    });
  }
  async function downloadMedia(mediaId) {
    if (typeof mediaId !== 'string' || !/^\d{1,128}$/.test(mediaId)) {
      throw failure('A valid WhatsApp media identifier is required.', 'ERR_WHATSAPP_MEDIA');
    }
    const { accessToken, phoneNumberId, apiVersion } = readWhatsAppSendConfig(env);
    const options = {
      headers: { Authorization: 'Bearer ' + accessToken },
      timeout: 15000, signal: AbortSignal.timeout(15000), maxRedirects: 0, httpsAgent, proxy: false,
      maxContentLength: 64 * 1024, maxBodyLength: 1024,
      responseType: 'json', validateStatus: (status) => status >= 200 && status < 300,
    };
    try {
      // The ID is received through the signed webhook; never accept a caller-supplied URL.
      const metadata = await http.get('https://graph.facebook.com/' + apiVersion + '/' + mediaId, {
        ...options, params: { phone_number_id: phoneNumberId },
      });
      if (metadata.status !== undefined && (metadata.status < 200 || metadata.status >= 300)) throw new Error();
      const { url, mime_type: rawMimeType, file_size: fileSize, sha256, id } = metadata.data || {};
      const mimeType = normalizeMediaMimeType(rawMimeType);
      const kind = mediaKind(mimeType);
      const sizeLimit = mediaSizeLimit(mimeType);
      if (!kind || !Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > sizeLimit
          || typeof url !== 'string' || url.length > 8192) throw new Error();
      if (id !== undefined && id !== mediaId) throw new Error();
      // Meta media metadata supplies a checksum. Validate it when present before
      // handing bytes to OCR/transcription; legacy metadata without it still works.
      if (sha256 !== undefined && (typeof sha256 !== 'string'
          || !/^(?:[a-f\d]{64}|[A-Za-z\d+/]{43}=)$/iu.test(sha256))) throw new Error();
      const location = new URL(url);
      // This is Meta's private Cloud API attachment host. Never forward the bearer
      // token to redirects, alternate hosts, userinfo URLs, or arbitrary ports.
      if (location.protocol !== 'https:' || location.hostname !== 'lookaside.fbsbx.com'
          || location.port || location.username || location.password || location.hash
          || !location.pathname.startsWith('/whatsapp_business/attachments/')) throw new Error();
      const response = await http.get(location.href, {
        ...options, responseType: 'arraybuffer', maxContentLength: sizeLimit,
      });
      if (response.status !== undefined && (response.status < 200 || response.status >= 300)) throw new Error();
      const downloadedType = normalizeMediaMimeType(response.headers?.['content-type']);
      const buffer = Buffer.isBuffer(response.data) ? response.data
        : response.data instanceof globalThis.ArrayBuffer ? Buffer.from(response.data) : null;
      if (downloadedType !== mimeType || !buffer || !buffer.length || buffer.length > sizeLimit
          || buffer.length !== fileSize) throw new Error();
      if (sha256 !== undefined) {
        const encoding = /^[a-f\d]{64}$/iu.test(sha256) ? 'hex' : 'base64';
        if (!createHash('sha256').update(buffer).digest().equals(Buffer.from(sha256, encoding))) throw new Error();
      }
      return { buffer, mimeType };
    } catch {
      log('warn', { event: 'whatsapp_media_download_failed', code: 'ERR_WHATSAPP_MEDIA' });
      // Axios errors include private URLs and Authorization headers. Retain neither.
      throw failure('WhatsApp media could not be read.', 'ERR_WHATSAPP_MEDIA');
    }
  }
  return { sendTextMessage, sendTemplateMessage, downloadMedia };
}
module.exports = { createWhatsAppService, readWhatsAppSendConfig, validateTextMessage, validateTemplateMessage };
