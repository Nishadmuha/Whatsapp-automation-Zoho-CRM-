'use strict';
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { parseWhatsAppWebhook } = require('../services/whatsapp/whatsappParser');
const { maskPhone } = require('../utils/logger');
const { AUTO_REPLY_TEXT } = require('../services/whatsapp/autoReply');
const { createIncomingTriggerGate } = require('../services/whatsapp/incomingTriggerGate');

function tokensMatch(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string' || !expected) return false;
  return timingSafeEqual(createHash('sha256').update(received).digest(), createHash('sha256').update(expected).digest());
}
function validSignature(req, appSecret) {
  const signature = req.get('x-hub-signature-256');
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature) || !Buffer.isBuffer(req.rawBody)) return false;
  const expected = createHmac('sha256', appSecret).update(req.rawBody).digest();
  const received = Buffer.from(signature.slice(7), 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
function createWebhookRouter({ config, store, ready, logger, onNewMessage, triggerGate = createIncomingTriggerGate({ logger }) }) {
  const router = express.Router();
  router.use(rateLimit({
    windowMs: 60_000, limit: config.rateLimit, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { success: false, message: 'Too many requests' },
  }));
  router.get('/', (req, res) => {
    logger.info({ event: 'webhook_verification_ignored', request_id: req.requestId }, '[WEBHOOK] Ignored verification request for AI processing');
    const challenge = req.query['hub.challenge'];
    if (req.query['hub.mode'] === 'subscribe' && typeof challenge === 'string' && challenge.length > 0 &&
        tokensMatch(req.query['hub.verify_token'], config.verifyToken)) {
      return res.status(200).type('text/plain').send(challenge);
    }
    return res.status(403).type('text/plain').send('Forbidden');
  });
  router.post('/', async (req, res) => {
    if ((config.production || config.enabled) && !config.appSecret) return res.status(503).json({ success: false, message: 'Webhook security is unavailable' });
    if (config.appSecret && !validSignature(req, config.appSecret)) {
      logger.warn({ event: 'webhook_signature_invalid', request_id: req.requestId }, 'Invalid WhatsApp webhook signature');
      return res.status(403).type('text/plain').send('Forbidden');
    }
    if (!req.is('application/json')) return res.status(415).json({ success: false, message: 'Use application/json' });
    const unsupported = new Map();
    const ignored = new Map();
    const parsed = parseWhatsAppWebhook(req.body, {
      ...config,
      onUnsupported({ messageType }) { unsupported.set(messageType, (unsupported.get(messageType) || 0) + 1); },
      onIgnored({ reason, count }) { ignored.set(reason, (ignored.get(reason) || 0) + count); },
    });
    for (const [reason, count] of ignored) logger.info({ event: 'webhook_ignored', request_id: req.requestId, reason, count },
      reason === 'status' ? '[WEBHOOK] Ignored status event' : '[WEBHOOK] Ignored outgoing message');
    const messages = parsed.filter(message => {
      const reason = triggerGate.reason(message.timestamp);
      if (!reason) return true;
      logger.info({ event: 'webhook_ignored', request_id: req.requestId, reason, message_id: message.messageId },
        '[WEBHOOK] Ignored historical or inactive message');
      return false;
    });
    for (const [messageType, count] of unsupported) {
      logger.info({ event: 'whatsapp_message_unsupported', request_id: req.requestId, message_type: messageType, count }, 'WhatsApp message retained without automatic content processing');
    }
    // Status notifications and irrelevant/malformed event structures need no database work.
    if (!messages.length) {
      logger.info({ event: 'webhook_received', request_id: req.requestId, inserted: 0, duplicates: 0 });
      return res.status(200).type('text/plain').send('EVENT_RECEIVED');
    }
    try {
      await ready;
      let inserted = 0;
      let duplicates = 0;
      // Bound each transaction to the existing repository batch size.
      for (let offset = 0; offset < messages.length; offset += 1000) {
        const batch = messages.slice(offset, offset + 1000);
        const result = await store.enqueueMany(batch.map((message) => ({
          whatsapp_message_id: message.messageId, sender_phone: message.senderPhone,
          message_text: message.text, message_type: message.messageType,
          sender_name: message.senderName || null,
          media_id: message.mediaId || null,
          media_mime_type: message.mediaMimeType || null,
          media_filename: message.mediaFilename || null,
          received_at: new Date(Number(message.timestamp) * 1000).toISOString(),
          authenticated: Boolean(config.appSecret),
          request_lead_workflow: config.enabled && config.aiProvider === 'openai'
            && config.bossSenders?.has(message.senderPhone) === true,
        })), {
          includeInsertedIds: true,
          replyText: config.enabled && config.aiProvider !== 'openai' ? AUTO_REPLY_TEXT : null,
          processingFlow: config.enabled && config.aiProvider === 'openai' ? 'conversation' : null,
        });
        inserted += result.inserted;
        duplicates += result.duplicates;
        const newIds = new Set(result.insertedIds);
        for (const message of batch) {
          if (!newIds.delete(message.messageId)) {
            logger.info({ event: 'webhook_ignored', request_id: req.requestId, reason: 'duplicate', message_id: message.messageId },
              '[WEBHOOK] Ignored duplicate message');
            continue;
          }
          // Admission follows the durable unique-ID insert. A replay can never
          // reactivate an old job or add an ID to this process's trigger list.
          const hasAutomation = config.enabled && (message.messageType === 'text'
            || (config.aiProvider === 'openai' && config.bossSenders?.has(message.senderPhone)));
          if (hasAutomation && !triggerGate.admit(message.messageId, message.timestamp)) {
            logger.info({ event: 'webhook_ignored', request_id: req.requestId, reason: 'expired', message_id: message.messageId },
              '[WEBHOOK] Ignored expired message trigger');
            continue;
          }
          // Bodies and profile names may contain personal data or pasted credentials.
          logger.info({
            event: 'whatsapp_message_received', request_id: req.requestId,
            message_id: message.messageId,
            ...(config.bossSenders?.has(message.senderPhone) ? {} : { sender: maskPhone(message.senderPhone) }),
            message_type: message.messageType, text_characters: Array.from(message.text).length,
            timestamp: message.timestamp,
          }, '[WEBHOOK] Processing new incoming message: WhatsApp message received');
          if (hasAutomation && triggerGate.allows(message.messageId) && onNewMessage) {
            // Only this successfully inserted, admitted receipt may schedule an
            // acknowledgement. The callback does not run media, AI or CRM work.
            try { await onNewMessage(message); }
            catch { logger.error({ event: 'crm_intake_queue_failed', message_id: message.messageId }); }
          }
        }
      }
      logger.info({ event: 'webhook_received', request_id: req.requestId, inserted, duplicates });
      // Commit before ACK so a crash/retry cannot lose an accepted message.
      return res.status(200).type('text/plain').send('EVENT_RECEIVED');
    } catch {
      logger.error({ event: 'webhook_persistence_failed', request_id: req.requestId });
      res.set('Retry-After', '5');
      return res.status(503).json({ success: false, message: 'Temporarily unable to accept webhook' });
    }
  });
  return router;
}
module.exports = { createWebhookRouter, tokensMatch, validSignature };
