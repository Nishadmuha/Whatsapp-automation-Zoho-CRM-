'use strict';

const { createHash } = require('node:crypto');
const { createOutgoingRepository, outgoingError } = require('../../database/outgoingMessages');
const { validateTextMessage } = require('./whatsappService');

const ACKNOWLEDGEMENT = 'Got it Boss \uD83D\uDC4D Processing the lead...';
const BOOKS_ACKNOWLEDGEMENT = 'Got it \uD83D\uDC4D Processing the bill...';
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const REPLY_WINDOW_MS = 23 * 60 * 60 * 1000;

function createOutgoingMessages({ store, whatsapp, config, logger, triggerGate, now = Date.now }) {
  const repository = createOutgoingRepository({ store });
  const tasks = new Set();
  let stopped = false;
  const allowed = phone => !config.allowedSenders?.size || config.allowedSenders.has(phone);
  const bossActive = phone => !stopped && config.enabled && config.aiProvider === 'openai'
    && config.bossSenders?.has(phone) === true && allowed(phone);
  const booksActive = phone => !stopped && config.enabled
    && config.booksSenders?.has(phone) === true && allowed(phone);
  function log(level, event, row, extra = {}) {
    try { logger?.[level]?.({ event, outgoing_id: row?.id, message_id: row?.message_id, ...extra }); }
    catch { /* Delivery classification is independent of the logger. */ }
  }

  async function persistOutcome(row, outcome) {
    let saved = false;
    try { saved = await repository.finish(row.id, outcome); } catch { /* Preserve accepted provider evidence below. */ }
    if (!saved && outcome.providerMessageId) {
      try { saved = Boolean(await repository.recordAcceptance(row.id, outcome.providerMessageId)); }
      catch { /* A durable SENDING reservation still prevents a repeated send. */ }
    }
    log(saved ? 'info' : 'error', saved ? 'whatsapp_outgoing_completed' : 'whatsapp_outgoing_reconciliation_required', row,
      { status: outcome.status, ...(outcome.providerMessageId ? { provider_message_id: outcome.providerMessageId } : {}), persisted: saved });
    try { return await repository.get(row.id); } catch { return { ...row, status: 'UNKNOWN', error_code: 'OUTGOING_PERSISTENCE_FAILED' }; }
  }

  async function dispatch(id) {
    let row;
    try {
      row = await repository.reserve(id);
      if (!row) return await repository.get(id);
      // Recheck after the asynchronous reservation and immediately before send.
      if (stopped || (row.kind === 'ack' && ((!bossActive(row.sender_phone) && !booksActive(row.sender_phone)) || !triggerGate?.allows(row.message_id)))) {
        return persistOutcome(row, { status: 'CANCELLED', errorCode: 'INACTIVE_TRIGGER' });
      }
      if (row.kind === 'manual') {
        const latest = await repository.latestIncoming(row.sender_phone);
        const age = latest ? now() - new Date(latest.received_at).getTime() : Infinity;
        if (stopped || !allowed(row.sender_phone) || !Number.isFinite(age) || age < 0 || age >= REPLY_WINDOW_MS) {
          return persistOutcome(row, { status: 'CANCELLED', errorCode: 'CUSTOMER_SERVICE_WINDOW_EXPIRED' });
        }
      }
      let providerMessageId;
      try {
        const response = await whatsapp.sendTextMessage(row.sender_phone, row.text);
        providerMessageId = response?.messages?.[0]?.id;
        if (typeof providerMessageId !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(providerMessageId)) {
          return persistOutcome(row, { status: 'UNKNOWN', errorCode: 'INVALID_PROVIDER_RECEIPT' });
        }
      } catch (error) {
        const state = ['NOT_ATTEMPTED', 'ATTEMPTED_FAILED', 'UNKNOWN'].includes(error?.deliveryState)
          ? error.deliveryState : 'UNKNOWN';
        return persistOutcome(row, { status: state === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED', errorCode: state });
      }
      if (row.kind === 'ack') log('info', 'whatsapp_fast_acknowledgement_sent', row);
      return persistOutcome(row, { status: 'SENT', providerMessageId });
    } catch {
      log('error', 'whatsapp_outgoing_persistence_failed', row || { id });
      // Never repeat a possibly dispatched request after an unknown local failure.
      return row ? persistOutcome(row, { status: 'UNKNOWN', errorCode: 'OUTGOING_PERSISTENCE_FAILED' }) : null;
    }
  }

  function track(pending) {
    tasks.add(pending);
    pending.finally(() => tasks.delete(pending)).catch(() => {});
    return pending;
  }

  function schedule(id) { return track(Promise.resolve().then(() => dispatch(id))); }

  async function acknowledge(message, { groupKey, leadId = null, isBooks = false } = {}) {
    const messageId = message.whatsapp_message_id || message.message_id || message.messageId;
    const senderPhone = message.sender_phone || message.senderPhone;
    const books = isBooks || message.processing_flow === 'books_bill'
      || (config.booksSenders?.has(senderPhone) === true && !config.bossSenders?.has(senderPhone));
    const active = books ? booksActive(senderPhone) : bossActive(senderPhone);
    if (!active || !triggerGate?.allows(messageId)) return null;
    const group = groupKey ?? messageId;
    if (typeof group !== 'string' || !group.length || group.length > 512 || /[\u0000-\u001f\u007f]/.test(group)) {
      throw outgoingError('OUTGOING_INPUT', 'Invalid acknowledgement group.');
    }
    const ackText = books ? BOOKS_ACKNOWLEDGEMENT : ACKNOWLEDGEMENT;
    const requestKey = 'ack:' + createHash('sha256').update(senderPhone + '\n' + group).digest('hex');
    const result = await repository.insert({ requestKey, messageId, senderPhone, leadId, kind: 'ack', text: ackText });
    if (result.inserted) schedule(result.row.id);
    return result.row;
  }

  async function sendManual({ senderPhone, text, requestKey, leadId = null }) {
    if (stopped) throw outgoingError('OUTGOING_STOPPED', 'Message sending is unavailable while the backend stops.');
    if (typeof senderPhone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(senderPhone) || !allowed(senderPhone)
      || typeof requestKey !== 'string' || !UUID.test(requestKey) || typeof text !== 'string' || text.includes('\0')) {
      throw outgoingError('OUTGOING_INPUT', 'Provide a valid conversation, message and request ID.');
    }
    try { validateTextMessage(senderPhone, text); }
    catch { throw outgoingError('OUTGOING_INPUT', 'Provide a message of 1 to 4096 characters.'); }
    const key = 'manual:' + requestKey.toLowerCase();
    const existing = await repository.getByRequestKey(key);
    if (existing) {
      if (existing.kind !== 'manual' || existing.sender_phone !== senderPhone || existing.text !== text || existing.lead_id !== leadId) {
        throw outgoingError('OUTGOING_CONFLICT', 'This request ID already belongs to a different message.');
      }
      return existing;
    }
    const latest = await repository.latestIncoming(senderPhone);
    if (!latest) throw outgoingError('OUTGOING_NOT_FOUND', 'Conversation not found.');
    const age = now() - new Date(latest.received_at).getTime();
    if (!Number.isFinite(age) || age < 0 || age >= REPLY_WINDOW_MS) {
      throw outgoingError('OUTGOING_WINDOW_EXPIRED', 'This conversation needs a new incoming WhatsApp message before sending a reply.');
    }
    const result = await repository.insert({ requestKey: key, messageId: latest.whatsapp_message_id,
      senderPhone, leadId, kind: 'manual', text });
    return result.inserted ? schedule(result.row.id) : result.row;
  }

  async function flush() { while (tasks.size) await Promise.allSettled([...tasks]); }
  async function stop() { stopped = true; await flush(); }

  return { acknowledge: (...args) => track(acknowledge(...args)), sendManual: (...args) => track(sendManual(...args)),
    flush, stop, repository };
}

module.exports = { createOutgoingMessages, ACKNOWLEDGEMENT, BOOKS_ACKNOWLEDGEMENT };
