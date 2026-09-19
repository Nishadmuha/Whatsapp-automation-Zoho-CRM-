'use strict';

const { randomUUID } = require('node:crypto');

const sql = (statement, ...values) => ({ sql: statement, values });
const PHONE = /^\+[1-9]\d{6,14}$/;
const SAFE_ERROR = /^[A-Z][A-Z0-9_]{0,99}$/;
const FINAL_STATES = new Set(['SENT', 'FAILED', 'UNKNOWN', 'CANCELLED']);

function outgoingError(code, message) {
  return Object.assign(new Error(message), { code });
}

function identifier(value, name, limit = 512) {
  if (typeof value !== 'string' || !value.length || value.length > limit || !/^[\x21-\x7e]+$/.test(value)) {
    throw outgoingError('OUTGOING_INPUT', `Invalid ${name}.`);
  }
  return value;
}

function decode(row) {
  if (!row) return null;
  return {
    ...row,
    lead_id: row.lead_id ?? null,
    provider_message_id: row.provider_message_id ?? null,
    error_code: row.error_code ?? null,
    sent_at: row.sent_at ?? null,
    ...Object.fromEntries(['created_at', 'sent_at', 'received_at'].filter(key => row[key] != null)
      .map(key => [key, new Date(row[key]).toISOString()]))
  };
}

function createOutgoingRepository({ store }) {
  const driver = store.driver;
  const lock = store.dialect === 'postgres' ? ' FOR UPDATE' : '';

  async function get(id) {
    identifier(id, 'outgoing ID', 128);
    return decode((await driver.query('SELECT * FROM crm_outgoing WHERE id=?', [id])).rows[0]);
  }

  async function getByRequestKey(requestKey) {
    identifier(requestKey, 'request key');
    return decode((await driver.query('SELECT * FROM crm_outgoing WHERE request_key=?', [requestKey])).rows[0]);
  }

  async function latestIncoming(senderPhone) {
    if (!PHONE.test(senderPhone)) throw outgoingError('OUTGOING_INPUT', 'Invalid conversation phone.');
    return decode((await driver.query(
      `SELECT whatsapp_message_id,sender_phone,received_at,authenticated,processing_flow FROM whatsapp_messages
       WHERE sender_phone=? AND authenticated=TRUE ORDER BY received_at DESC,created_at DESC,whatsapp_message_id DESC LIMIT 1`,
      [senderPhone])).rows[0]);
  }

  async function insert({ requestKey, messageId, senderPhone, leadId = null, kind, text }) {
    identifier(requestKey, 'request key');
    identifier(messageId, 'source message ID');
    if (leadId !== null) identifier(leadId, 'lead ID', 128);
    if (!PHONE.test(senderPhone) || !['ack', 'manual'].includes(kind)
      || typeof text !== 'string' || !text.trim() || Array.from(text).length > 4096 || text.includes('\0')) {
      throw outgoingError('OUTGOING_INPUT', 'Invalid outgoing message.');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    return driver.transaction(function* () {
      const source = (yield sql('SELECT sender_phone,authenticated,processing_flow FROM whatsapp_messages WHERE whatsapp_message_id=?', messageId)).rows[0];
      if (!source || source.sender_phone !== senderPhone || ![true, 1].includes(source.authenticated)
        || (kind === 'ack' && !['boss_lead', 'books_bill'].includes(source.processing_flow))) {
        throw outgoingError('OUTGOING_NOT_AUTHORIZED', 'The source message does not authorize this conversation.');
      }
      if (leadId !== null) {
        const lead = (yield sql('SELECT sender_phone FROM leads WHERE id=?', leadId)).rows[0];
        if (!lead || lead.sender_phone !== senderPhone) throw outgoingError('OUTGOING_INPUT', 'Lead does not belong to this conversation.');
      }
      const inserted = yield sql(
        `INSERT INTO crm_outgoing(id,request_key,message_id,sender_phone,lead_id,kind,text,status,created_at)
         VALUES (?,?,?,?,?,?,?,'PENDING',?) ON CONFLICT(request_key) DO NOTHING`,
        id, requestKey, messageId, senderPhone, leadId, kind, text, now);
      const row = (yield sql('SELECT * FROM crm_outgoing WHERE request_key=?', requestKey)).rows[0];
      // A reused key cannot send a different message or reveal another chat's record.
      if (!row || row.sender_phone !== senderPhone || row.kind !== kind || row.text !== text
        || (kind === 'manual' && (row.lead_id ?? null) !== (leadId ?? null))) {
        throw outgoingError('OUTGOING_CONFLICT', 'This request key already belongs to a different message.');
      }
      return { row: decode(row), inserted: inserted.rowCount === 1 };
    });
  }

  async function reserve(id) {
    identifier(id, 'outgoing ID', 128);
    // Only the fresh creator schedules this operation. No expired SENDING row
    // is ever reclaimed, and constructing the service never scans old rows.
    return decode((await driver.query(
      "UPDATE crm_outgoing SET status='SENDING' WHERE id=? AND status='PENDING' RETURNING *", [id])).rows[0]);
  }

  async function finish(id, { status, providerMessageId = null, errorCode = null }) {
    identifier(id, 'outgoing ID', 128);
    if (!FINAL_STATES.has(status) || (errorCode !== null && !SAFE_ERROR.test(errorCode))) {
      throw outgoingError('OUTGOING_INPUT', 'Invalid delivery outcome.');
    }
    if (providerMessageId !== null) identifier(providerMessageId, 'provider message ID');
    if (status === 'SENT' && !providerMessageId) throw outgoingError('OUTGOING_INPUT', 'Provider acceptance requires a message ID.');
    return (await driver.query(
      `UPDATE crm_outgoing SET status=?,provider_message_id=?,error_code=?,sent_at=?
       WHERE id=? AND status='SENDING'`,
      [status, providerMessageId, errorCode, status === 'SENT' ? new Date().toISOString() : null, id])).rowCount === 1;
  }

  async function recordAcceptance(id, providerMessageId) {
    identifier(id, 'outgoing ID', 128);
    identifier(providerMessageId, 'provider message ID');
    return driver.transaction(function* () {
      const row = (yield sql(`SELECT * FROM crm_outgoing WHERE id=?${lock}`, id)).rows[0];
      if (row?.status === 'SENT' && row.provider_message_id === providerMessageId) return 'SENT';
      if (!row || !['SENDING', 'UNKNOWN'].includes(row.status)
        || (row.provider_message_id !== null && row.provider_message_id !== providerMessageId)) return null;
      yield sql(`UPDATE crm_outgoing SET status='UNKNOWN',provider_message_id=?,error_code='PROVIDER_ACCEPTED_RECONCILIATION_REQUIRED'
        WHERE id=? AND status IN ('SENDING','UNKNOWN')`, providerMessageId, id);
      return 'UNKNOWN';
    });
  }

  return { insert, get, getByRequestKey, latestIncoming, reserve, finish, recordAcceptance };
}

module.exports = { createOutgoingRepository, outgoingError };
