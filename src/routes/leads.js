'use strict';
const path = require('node:path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');

const LEAD_FIELDS = ['company_name', 'contact_name', 'phone', 'email', 'address', 'trn_no', 'project_name', 'project_location',
  'product_or_service', 'requirement', 'quantity', 'deadline', 'notes'];
const DTO_FIELDS = ['id', 'whatsapp_message_id', 'sender_phone', 'original_message', ...LEAD_FIELDS,
  'extraction_status', 'validation_status', 'zoho_status', 'zoho_lead_id', 'error_stage', 'error_code', 'created_at', 'updated_at'];
const STAT_FIELDS = ['total', 'valid', 'incomplete', 'extraction_failed', 'zoho_pending', 'zoho_saved'];
const VALIDATION_STATUSES = ['pending', 'valid', 'incomplete', 'invalid'];
const EXTRACTION_STATUSES = ['pending', 'processing', 'completed', 'failed'];
const ZOHO_STATUSES = ['not_started', 'pending', 'existing_found', 'creating', 'updating', 'saved', 'failed'];
const QUERY_FIELDS = new Set(['page', 'page_size', 'search', 'status', 'validation_status', 'extraction_status', 'zoho_status']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,99}$/;
const SECRET_ENV_KEYS = ['ADMIN_API_TOKEN', 'ADMIN_PASSWORD', 'WHATSAPP_ACCESS_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'META_APP_SECRET', 'WHATSAPP_APP_SECRET', 'WEBHOOK_VERIFY_TOKEN', 'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET',
  'ZOHO_REFRESH_TOKEN', 'ZOHO_ACCESS_TOKEN', 'DATABASE_URL', 'MONGODB_URI'];

function outputRedactor(config, env) {
  // Do not read process.env here. Only redact known credentials supplied by the
  // existing app configuration, preserving exact source data in the database.
  const values = [...new Set([...SECRET_ENV_KEYS.map(key => env[key]), config.adminPassword, config.adminApiToken,
    config.appSecret, config.verifyToken, config.databaseUrl]
    .filter(value => typeof value === 'string' && value.trim()).flatMap(value => [value, value.trim()]))]
    .sort((a, b) => b.length - a.length);
  const redact = value => {
    if (typeof value === 'string') return values.reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    return value;
  };
  return redact;
}

function leadDto(row) {
  const result = Object.fromEntries(DTO_FIELDS.map(field => [field, typeof row[field] === 'string' ? row[field] : null]));
  if (typeof row.zoho_url === 'string') result.zoho_url = row.zoho_url;
  if (typeof row.zoho_synced_at === 'string') result.zoho_synced_at = row.zoho_synced_at;
  // A lead belongs to its WhatsApp sender's conversation, even when it contains
  // another customer's phone number. Do not join chats by extracted contact.
  result.conversation_id = /^\+[1-9]\d{6,14}$/.test(row.sender_phone) ? row.sender_phone : null;
  const validation = row.validation_result;
  result.validation_result = validation && typeof validation.valid === 'boolean' ? {
    valid: validation.valid,
    missing_fields: Array.isArray(validation.missing_fields) ? validation.missing_fields.filter(field => LEAD_FIELDS.includes(field)) : [],
    errors: Array.isArray(validation.errors) ? validation.errors.filter(code => typeof code === 'string' && SAFE_CODE.test(code)) : [],
  } : null;
  if (Array.isArray(row.attachments)) result.attachments = row.attachments;
  if (Array.isArray(row.messages)) result.messages = row.messages;
  return result;
}

function listQuery(query) {
  if (Object.entries(query).some(([key, value]) => !QUERY_FIELDS.has(key) || typeof value !== 'string')) return null;
  const integer = (value, fallback, max) => value === undefined ? fallback
    : /^[1-9]\d{0,6}$/.test(value) && Number(value) <= max ? Number(value) : null;
  const page = integer(query.page, 1, 1_000_000);
  const pageSize = integer(query.page_size, 20, 100);
  const search = query.search ?? '';
  const validationStatus = query.validation_status ?? query.status;
  if (!page || !pageSize || search.length > 200 || /[\u0000-\u001f\u007f]/.test(search)
    || (query.status !== undefined && query.validation_status !== undefined && query.status !== query.validation_status)
    || (validationStatus !== undefined && !VALIDATION_STATUSES.includes(validationStatus))
    || (query.extraction_status !== undefined && !EXTRACTION_STATUSES.includes(query.extraction_status))
    || (query.zoho_status !== undefined && !ZOHO_STATUSES.includes(query.zoho_status))) return null;
  return { page, pageSize, search, validationStatus,
    extractionStatus: query.extraction_status, zohoStatus: query.zoho_status };
}

function createLeadsRouter({ config, store, ready, logger, env = {}, requireAuth }) {
  const router = express.Router();
  const redact = outputRedactor(config, env);
  router.use(rateLimit({ windowMs: 60_000, limit: config.rateLimit || 120,
    standardHeaders: 'draft-8', legacyHeaders: false, message: { success: false, message: 'Too many requests' } }));
  router.use(requireAuth);
  const unavailable = (req, res) => {
    logger?.error?.({ event: 'leads_api_unavailable', request_id: req.requestId });
    return res.status(503).json({ success: false, message: 'Temporarily unable to load leads' });
  };
  const invalid = res => res.status(400).json({ success: false, message: 'Invalid lead query' });
  router.get('/stats', async (req, res) => {
    if (Object.keys(req.query).length) return invalid(res);
    try {
      await ready;
      const stats = await store.getLeadStats();
      return res.json(Object.fromEntries(STAT_FIELDS.map(field => [field, Number.isSafeInteger(stats[field]) && stats[field] >= 0 ? stats[field] : 0])));
    } catch { return unavailable(req, res); }
  });
  router.get('/', async (req, res) => {
    const query = listQuery(req.query);
    if (!query) return invalid(res);
    try {
      await ready;
      const result = await store.listLeads(query);
      const total = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : 0;
      return res.json(redact({ items: result.items.map(leadDto), total,
        page: query.page, page_size: query.pageSize, total_pages: Math.ceil(total / query.pageSize) }));
    } catch { return unavailable(req, res); }
  });
  router.get('/:id', async (req, res) => {
    if (!UUID.test(req.params.id) || Object.keys(req.query).length) return invalid(res);
    try {
      await ready;
      const lead = await store.getLead(req.params.id);
      return lead ? res.json(redact(leadDto(lead))) : res.status(404).json({ success: false, message: 'Lead not found' });
    } catch { return unavailable(req, res); }
  });
  router.post('/:id/sync-zoho', async (req, res) => {
    if (!UUID.test(req.params.id)) return invalid(res);
    try {
      await ready;
      const lead = await store.getLead(req.params.id);
      if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
      const { handleZohoSync } = require('../services/leads/bossLeadWorkflow');
      const syncResult = await handleZohoSync({
        leadId: req.params.id,
        store,
        config,
        logger,
        force: true
      });
      const updated = await store.getLead(req.params.id);
      if (syncResult && syncResult.success) {
        return res.json({
          success: true,
          message: 'Lead synced to Zoho successfully',
          lead: redact(leadDto(updated)),
          zoho_lead_id: syncResult.zohoLeadId,
          zoho_url: syncResult.zohoUrl
        });
      }
      return res.status(400).json({
        success: false,
        message: syncResult?.error || 'Zoho push failed',
        lead: redact(leadDto(updated))
      });
    } catch { return unavailable(req, res); }
  });
  return router;
}

function createLeadsDashboardRouter() {
  const router = express.Router();
  const directory = path.join(__dirname, '../admin');
  router.get(['/leads', '/leads/'], (_req, res) => res.sendFile(path.join(directory, 'leads.html')));
  for (const asset of ['leads.css', 'leads.js']) router.get('/' + asset, (_req, res) => res.sendFile(path.join(directory, asset)));
  return router;
}

module.exports = { createLeadsRouter, createLeadsDashboardRouter, outputRedactor };
