'use strict';

const { randomUUID } = require('node:crypto');
const { normalizePhone } = require('../../utils/phone');
const { maskPhone } = require('../../utils/logger');

const sql = (statement, ...values) => ({ sql: statement, values });

class MessagesAdminError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MessagesAdminError';
    this.code = code;
  }
}

function fail(code, message) { throw new MessagesAdminError(code, message); }

function validateId(id) {
  if (typeof id !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(id)) {
    fail('ADMIN_INPUT', 'Provide a valid WhatsApp message ID.');
  }
}

function contactKeys(row) {
  const lead = typeof row.extracted_lead_data === 'string' ? JSON.parse(row.extracted_lead_data) : row.extracted_lead_data;
  if (!lead || typeof lead !== 'object' || Array.isArray(lead)) return [];
  const phone = normalizePhone(lead.phone);
  const email = typeof lead.email === 'string' && lead.email.trim().length <= 254 ? lead.email.trim().toLowerCase() : null;
  return [phone && `phone:${phone}`, email && `email:${email}`].filter(Boolean).sort();
}

function decodeDetails(row) {
  return { ...row, details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details };
}

function withoutLeaseToken(row) {
  if (!row) return null;
  const result = { ...row };
  delete result.lease_token;
  return result;
}

function createMessagesAdmin({ store, config = {} }) {
  const lockSuffix = store.dialect === 'postgres' ? ' FOR UPDATE' : '';

  function assertRetryable(row) {
    if (!row) fail('ADMIN_NOT_FOUND', 'The message was not found.');
    if (row.processing_flow === 'boss_lead') {
      fail('ADMIN_RETRY_REFUSED', 'Internal lead retries are managed separately; this command does not support boss lead messages.');
    }
    if (row.processing_status !== 'FAILED') {
      fail('ADMIN_RETRY_REFUSED', 'Only FAILED messages can be requeued.');
    }
    if (row.authenticated !== true && row.authenticated !== 1) {
      fail('ADMIN_RETRY_REFUSED', 'Unsigned or unauthenticated messages cannot be requeued.');
    }
    if (config.allowedSenders?.size && !config.allowedSenders.has(row.sender_phone)) {
      fail('ADMIN_RETRY_REFUSED', 'The message sender is not in the current authorized sender list.');
    }
    if (row.crm_write_started || row.zoho_lead_id) {
      fail('ADMIN_RETRY_REFUSED', 'This message has a possible or confirmed CRM write; reconcile it manually.');
    }
  }

  async function listMessages(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('ADMIN_INPUT', 'The list limit must be an integer from 1 to 100.');
    const result = await store.driver.query(
      `SELECT whatsapp_message_id,sender_phone,received_at,processing_status,attempts,
       zoho_lead_id,crm_write_started,next_attempt_at,processed_at
       FROM whatsapp_messages ORDER BY created_at DESC,whatsapp_message_id DESC LIMIT ?`, [limit]
    );
    return result.rows.map((row) => ({ ...row, sender_phone: maskPhone(row.sender_phone) }));
  }

  async function showMessage(id) {
    validateId(id);
    const message = await store.getMessage(id);
    if (!message) fail('ADMIN_NOT_FOUND', 'The message was not found.');
    const [reply, result] = await Promise.all([
      store.getReply(id),
      store.driver.query('SELECT id,event,details,created_at FROM processing_logs WHERE message_id=? ORDER BY created_at,id', [id]),
    ]);
    return { message: withoutLeaseToken(message), reply: withoutLeaseToken(reply), audit: result.rows.map(decodeDetails) };
  }

  async function retryMessage(id) {
    validateId(id);
    const snapshot = await store.getMessage(id);
    assertRetryable(snapshot);
    const keys = contactKeys(snapshot);

    async function withLocks(remaining, asserts = []) {
      if (remaining.length) {
        return store.withContactLock(remaining[0], ({ assertOwned }) => withLocks(remaining.slice(1), [...asserts, assertOwned]));
      }
      for (const assertOwned of asserts) await assertOwned();
      const clock = store.dialect === 'postgres'
        ? 'SELECT clock_timestamp() AS now'
        : "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now";
      return store.driver.transaction(function* () {
        // Lock the current message and outbox row, then repeat every safety check
        // inside this transaction: the initial read was only a lock-key snapshot.
        const row = (yield sql(`SELECT * FROM whatsapp_messages WHERE whatsapp_message_id=?${lockSuffix}`, id)).rows[0];
        assertRetryable(row);
        if (JSON.stringify(contactKeys(row)) !== JSON.stringify(keys)) {
          fail('ADMIN_STATE_CHANGED', 'The message contact data changed; inspect it before retrying.');
        }
        for (const key of keys) {
          const state = (yield sql(`SELECT uncertain FROM crm_contacts WHERE contact_key=?${lockSuffix}`, key)).rows[0];
          if (state?.uncertain) fail('ADMIN_RETRY_REFUSED', 'An associated contact has an uncertain CRM write; reconcile it manually.');
        }
        const reply = (yield sql(`SELECT * FROM reply_outbox WHERE message_id=?${lockSuffix}`, id)).rows[0];
        if (reply && !['PENDING', 'FAILED', 'SENT'].includes(reply.status)) {
          fail('ADMIN_RETRY_REFUSED', 'The prior reply is sending or its delivery is uncertain; inspect it before retrying.');
        }
        const timestamp = new Date((yield sql(clock)).rows[0].now).toISOString();
        const details = {
          previous_status: row.processing_status,
          previous_attempts: row.attempts,
          previous_reply: reply ? {
            id: reply.id, status: reply.status, provider_message_id: reply.provider_message_id,
            sent_at: reply.sent_at, error_message: reply.error_message,
          } : null,
        };
        yield sql('INSERT INTO processing_logs(id,message_id,event,details,created_at) VALUES (?,?,?,?,?)',
          randomUUID(), id, 'operator_retry', JSON.stringify(details), timestamp);
        // Keep the full reply in chat history in the same transaction that frees
        // the outbox slot. Unsent replies are cancelled, never sent from history.
        if (reply) {
          yield sql(`INSERT INTO reply_history(id,message_id,text,status,provider_message_id,created_at,sent_at,archived_at)
            VALUES (?,?,?,?,?,?,?,?)`, reply.id, id, reply.text, reply.status === 'PENDING' ? 'CANCELLED' : reply.status,
          reply.provider_message_id, new Date(reply.created_at).toISOString(),
          reply.sent_at ? new Date(reply.sent_at).toISOString() : null, timestamp);
          yield sql('DELETE FROM reply_outbox WHERE id=?', reply.id);
        }
        yield sql(
          `UPDATE whatsapp_messages SET processing_status='RECEIVED',attempts=0,
           next_attempt_at=NULL,error_message=NULL,processed_at=NULL,lease_token=NULL,lease_expires_at=NULL
           WHERE whatsapp_message_id=?`, id
        );
        return {
          whatsapp_message_id: id, status: 'RECEIVED', previous_reply_status: reply?.status || null,
          note: reply
            ? 'Requeued. The prior failure reply remains in chat history and its delivery record in operator_retry; the enabled worker can issue a fresh result confirmation.'
            : 'Requeued. The enabled worker will process this message; this command made no external API calls.',
        };
      });
    }
    return withLocks(keys);
  }

  return { listMessages, showMessage, retryMessage };
}

module.exports = { createMessagesAdmin, MessagesAdminError };
