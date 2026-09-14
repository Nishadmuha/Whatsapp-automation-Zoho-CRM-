'use strict';
const path = require('node:path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { outputRedactor } = require('./leads');

const PHONE_ID = /^\+[1-9]\d{6,14}$/;
const CONVERSATION_FIELDS = ['id', 'sender_phone', 'sender_name', 'type', 'status', 'last_message',
  'last_message_type', 'last_message_at', 'lead_id', 'session_id'];
const MESSAGE_FIELDS = ['id', 'message_id', 'whatsapp_message_id', 'in_reply_to_message_id', 'direction', 'sender_type', 'text', 'message_type', 'media_id',
  'media_mime_type', 'media_filename', 'transcription', 'extracted_text', 'sender_name', 'created_at', 'received_at', 'status', 'lead_id', 'session_id'];
const LEAD_FIELDS = ['company_name', 'contact_name', 'phone', 'email', 'address', 'trn_no', 'project_name', 'project_location',
  'product_or_service', 'requirement', 'quantity', 'deadline', 'notes'];
const strings = (row, fields) => Object.fromEntries(fields.map(field => [field, typeof row?.[field] === 'string' ? row[field] : null]));

function detailDto(row) {
  const result = strings(row, CONVERSATION_FIELDS);
  result.leads = Array.isArray(row.leads) ? row.leads.map(lead => strings(lead,
    ['id', ...LEAD_FIELDS, 'validation_status', 'created_at'])) : [];
  result.active_session = row.active_session ? {
    ...strings(row.active_session, ['id', 'state', 'pending_action', 'created_at', 'updated_at']),
    lead: strings(row.active_session.result?.lead, LEAD_FIELDS),
  } : null;
  result.archived_sessions = Array.isArray(row.archived_sessions) ? row.archived_sessions.map(session => ({
    ...strings(session, ['id', 'state', 'lead_id', 'original_message', 'created_at', 'updated_at', 'completed_at']),
    lead: strings(session.result?.lead, LEAD_FIELDS),
  })) : [];
  return result;
}

function listQuery(query, messages = false) {
  const fields = new Set(messages ? ['page', 'page_size'] : ['page', 'page_size', 'search']);
  if (Object.entries(query).some(([key, value]) => !fields.has(key) || typeof value !== 'string')) return null;
  const integer = (value, fallback, max) => value === undefined ? fallback
    : /^[1-9]\d{0,6}$/.test(value) && Number(value) <= max ? Number(value) : null;
  const page = integer(query.page, 1, 1_000_000);
  const pageSize = integer(query.page_size, messages ? 100 : 20, messages ? 200 : 100);
  const search = query.search ?? '';
  if (!page || !pageSize || search.length > 200 || /[\u0000-\u001f\u007f]/.test(search)) return null;
  return { page, pageSize, ...(messages ? {} : { search }) };
}

function paginated(result, query, fields) {
  const total = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : 0;
  return { items: result.items.map(row => strings(row, fields)), total,
    page: query.page, page_size: query.pageSize, total_pages: Math.ceil(total / query.pageSize) };
}

function createChatsRouter({ config, store, ready, logger, env = {}, requireAuth }) {
  const router = express.Router();
  const redact = outputRedactor(config, env);
  router.use(rateLimit({ windowMs: 60_000, limit: config.rateLimit || 120,
    standardHeaders: 'draft-8', legacyHeaders: false, message: { success: false, message: 'Too many requests' } }));
  router.use(requireAuth);
  const invalid = res => res.status(400).json({ success: false, message: 'Invalid chat query' });
  const unavailable = (req, res) => {
    logger?.error?.({ event: 'chats_api_unavailable', request_id: req.requestId });
    return res.status(503).json({ success: false, message: 'Temporarily unable to load chats' });
  };
  const missing = res => res.status(404).json({ success: false, message: 'Conversation not found' });
  router.get('/', async (req, res) => {
    const query = listQuery(req.query);
    if (!query) return invalid(res);
    try {
      await ready;
      return res.json(redact(paginated(await store.listConversations(query), query, CONVERSATION_FIELDS)));
    } catch { return unavailable(req, res); }
  });
  router.get('/:id/messages', async (req, res) => {
    const query = listQuery(req.query, true);
    if (!PHONE_ID.test(req.params.id) || !query) return invalid(res);
    try {
      await ready;
      if (!await store.getConversation(req.params.id)) return missing(res);
      return res.json(redact(paginated(await store.listConversationMessages(req.params.id, query), query, MESSAGE_FIELDS)));
    } catch { return unavailable(req, res); }
  });
  router.get('/media/:mediaId', async (req, res) => {
    const mediaId = req.params.mediaId;
    if (!/^\d{1,128}$/.test(mediaId)) return invalid(res);
    try {
      const whatsapp = req.app.locals.whatsapp;
      if (!whatsapp?.downloadMedia) return res.status(404).json({ success: false, message: 'Media service unavailable' });
      const { buffer, mimeType } = await whatsapp.downloadMedia(mediaId);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.send(buffer);
    } catch {
      return res.status(404).json({ success: false, message: 'Media not found or expired' });
    }
  });
  router.get('/:id', async (req, res) => {
    if (!PHONE_ID.test(req.params.id) || Object.keys(req.query).length) return invalid(res);
    try {
      await ready;
      const conversation = await store.getConversation(req.params.id);
      return conversation ? res.json(redact(detailDto(conversation))) : missing(res);
    } catch { return unavailable(req, res); }
  });
  router.post('/:id/messages', async (req, res) => {
    if (!PHONE_ID.test(req.params.id)) return invalid(res);
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > 4096) {
      return res.status(400).json({ success: false, message: 'Provide a valid text message up to 4096 characters' });
    }
    const outgoing = req.app.locals.outgoingMessages;
    if (!outgoing) {
      return res.status(503).json({ success: false, message: 'Outgoing message service is not active' });
    }
    try {
      const requestKey = req.body.requestKey || req.headers['idempotency-key'] || require('node:crypto').randomUUID();
      const result = await outgoing.sendManual({
        senderPhone: req.params.id,
        text,
        requestKey,
        leadId: req.body.leadId || null,
      });
      return res.json({ success: true, data: result });
    } catch (error) {
      const status = error.code === 'OUTGOING_CONFLICT' ? 409
        : error.code === 'OUTGOING_WINDOW_EXPIRED' ? 400
        : error.code === 'OUTGOING_INPUT' ? 400
        : error.code === 'OUTGOING_NOT_FOUND' ? 404 : 500;
      return res.status(status).json({ success: false, message: error.message, code: error.code });
    }
  });
  return router;
}

function createChatsDashboardRouter() {
  const router = express.Router();
  const directory = path.join(__dirname, '../admin');
  router.get(['/chats', '/chats/'], (_req, res) => res.sendFile(path.join(directory, 'chats.html')));
  for (const asset of ['chats.css', 'chats.js']) router.get('/' + asset, (_req, res) => res.sendFile(path.join(directory, asset)));
  return router;
}

module.exports = { createChatsRouter, createChatsDashboardRouter };
