'use strict';

const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const mongoose = require('mongoose');
const { connectMongoDB } = require('../config/db');

const STATUSES = new Set(['PROCESSING', 'SUCCESS', 'FAILED', 'NEEDS_INFORMATION']);
const PATCH_FIELDS = new Set([
  'extracted_lead_data', 'zoho_lead_id', 'crm_action', 'processing_status',
  'error_message', 'processed_at', 'next_attempt_at', 'crm_write_started'
]);
const EXTRACTION_PATCH_FIELDS = new Set(['processing_status', 'result', 'error_message', 'processed_at', 'next_attempt_at']);
const LEAD_LIMITS = Object.freeze({
  company_name: 200, contact_name: 200, phone: 80, email: 254,
  project_name: 200, project_location: 200, product_or_service: 300, requirement: 1000, quantity: 120, deadline: 120, notes: 600,
  address: 1000, trn_no: 40
});
const LEAD_FIELDS = Object.keys(LEAD_LIMITS);
const ADDED_LEAD_FIELDS = ['address', 'trn_no'];
const LEAD_STATUSES = Object.freeze({
  validationStatus: ['pending', 'valid', 'incomplete', 'invalid'],
  extractionStatus: ['pending', 'processing', 'completed', 'failed'],
  zohoStatus: ['not_started', 'pending', 'existing_found', 'creating', 'updating', 'saved', 'failed'],
});
const REPLY_WINDOW_MS = 23 * 60 * 60 * 1000;

function iso(value) {
  if (!value) return new Date().toISOString();
  return new Date(value).toISOString();
}

function addMilliseconds(value, milliseconds) {
  return iso(new Date(value).getTime() + milliseconds);
}

function string(value, name, max, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) {
    throw new TypeError(`Invalid ${name}.`);
  }
  return value;
}

function positiveInteger(value, name, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new TypeError(`Invalid ${name}.`);
  return value;
}

function validateReplyText(value) {
  if (value === null) return;
  string(value, 'reply text', 4096);
  if (!value.trim()) throw new TypeError('Invalid reply text.');
}

function validateMessageIds(ids) {
  if (ids === null) return;
  if (!Array.isArray(ids) || ids.length > 1000) throw new TypeError('Invalid messageIds.');
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !id || id.length > 512 || seen.has(id)) {
      throw new TypeError('Invalid messageId.');
    }
    seen.add(id);
  }
}

function mediaText(value, name) {
  if (value === undefined || value === '') return value;
  return string(value, name, 64000, true);
}

function emptyLeadDraft() {
  return { is_lead: false, lead: Object.fromEntries(LEAD_FIELDS.map(field => [field, null])) };
}

function emptyLeadValidation() {
  return { valid: false, missing_fields: [], errors: ['NOT_A_LEAD'] };
}

function hasLeadInformation(result) {
  return result.is_lead && LEAD_FIELDS.some(field => typeof result.lead[field] === 'string' && result.lead[field].trim());
}

function validateProcessingFlow(value) {
  if (value !== null && value !== 'conversation' && value !== 'boss_lead') throw new TypeError('Invalid processing flow.');
}

function workflowCode(value) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(value)) throw new TypeError('Invalid lead workflow error code.');
  return value;
}

function workflowResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).length !== 2 || Object.keys(result).some(key => !['is_lead', 'lead'].includes(key)) || typeof result.is_lead !== 'boolean'
      || !result.lead || typeof result.lead !== 'object' || Array.isArray(result.lead)
      || LEAD_FIELDS.some(field => !ADDED_LEAD_FIELDS.includes(field) && !Object.hasOwn(result.lead, field))
      || Object.keys(result.lead).some(field => !Object.hasOwn(LEAD_LIMITS, field))) throw new TypeError('Invalid lead workflow result.');
  const lead = {};
  for (const field of LEAD_FIELDS) {
    lead[field] = string(ADDED_LEAD_FIELDS.includes(field) && !Object.hasOwn(result.lead, field) ? null : result.lead[field], field, LEAD_LIMITS[field], true);
    if (lead[field] !== null && (!lead[field].trim() || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(lead[field]))) {
      throw new TypeError('Invalid lead workflow field.');
    }
  }
  if (!result.is_lead && LEAD_FIELDS.some(field => lead[field] !== null)) throw new TypeError('Irrelevant results must not contain lead data.');
  const prepared = { is_lead: result.is_lead, lead };
  if (Buffer.byteLength(JSON.stringify(prepared), 'utf8') > 24000) throw new TypeError('Lead workflow result is too large.');
  return prepared;
}

function workflowValidation(validation) {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)
      || Object.keys(validation).length !== 3 || Object.keys(validation).some(key => !['valid', 'missing_fields', 'errors'].includes(key)) || typeof validation.valid !== 'boolean'
      || !Array.isArray(validation.missing_fields) || !Array.isArray(validation.errors)
      || validation.missing_fields.length > LEAD_FIELDS.length || validation.errors.length > 20
      || validation.missing_fields.some(field => !LEAD_FIELDS.includes(field))) throw new TypeError('Invalid lead validation result.');
  const prepared = { valid: validation.valid, missing_fields: [...new Set(validation.missing_fields)], errors: [...new Set(validation.errors.map(workflowCode))] };
  if (prepared.valid && (prepared.missing_fields.length || prepared.errors.length)) throw new TypeError('Valid leads cannot have validation failures.');
  return prepared;
}

function decode(doc) {
  if (!doc) return null;
  const result = { ...doc };
  delete result._id;
  for (const [key, value] of Object.entries(result)) {
    if (value instanceof Date) result[key] = value.toISOString();
  }
  if (typeof result.extracted_lead_data === 'string') {
    try { result.extracted_lead_data = JSON.parse(result.extracted_lead_data); } catch { /* Keep string if parse fails */ }
  }
  if (typeof result.result === 'string') {
    try { result.result = JSON.parse(result.result); } catch { /* Keep string */ }
  }
  if (result.result && typeof result.result.is_lead === 'boolean' && result.result.lead && typeof result.result.lead === 'object' && !Array.isArray(result.result.lead)) {
    result.result = { ...result.result, lead: { ...Object.fromEntries(ADDED_LEAD_FIELDS.map(field => [field, null])), ...result.result.lead } };
  }
  if (typeof result.validation_result === 'string') {
    try { result.validation_result = JSON.parse(result.validation_result); } catch { /* Keep string */ }
  }
  if ('crm_write_started' in result) result.crm_write_started = Boolean(result.crm_write_started);
  if ('authenticated' in result) result.authenticated = Boolean(result.authenticated);
  if ('uncertain' in result) result.uncertain = Boolean(result.uncertain);
  if (result.whatsapp_message_id !== undefined) {
    result.extracted_text = result.extracted_text ?? null;
    result.transcription = result.transcription ?? null;
  }
  if (result.request_key !== undefined) {
    result.lead_id = result.lead_id ?? null;
    result.provider_message_id = result.provider_message_id ?? null;
    result.error_code = result.error_code ?? null;
    result.sent_at = result.sent_at ?? null;
  }
  return result;
}

function lockError(code) {
  return Object.assign(new Error(code === 'CONTACT_LOCK_TIMEOUT' ? 'Contact is being processed by another worker.' : 'Contact lock ownership was lost.'), { code, retryable: true });
}

function parseSqlSet(setStr, params) {
  const setDoc = {};
  const assignments = setStr.split(',').map(s => s.trim()).filter(Boolean);
  for (const assign of assignments) {
    const eqIdx = assign.indexOf('=');
    if (eqIdx === -1) continue;
    const col = assign.substring(0, eqIdx).trim();
    const val = assign.substring(eqIdx + 1).trim();
    if (val === '?') {
      setDoc[col] = params.shift();
    } else if (val.startsWith("'") && val.endsWith("'")) {
      setDoc[col] = val.slice(1, -1);
    } else if (val.toUpperCase() === 'NULL') {
      setDoc[col] = null;
    } else if (val.toUpperCase() === 'FALSE') {
      setDoc[col] = false;
    } else if (val.toUpperCase() === 'TRUE') {
      setDoc[col] = true;
    } else if (!isNaN(Number(val))) {
      setDoc[col] = Number(val);
    } else {
      setDoc[col] = val;
    }
  }
  return setDoc;
}

function parseSqlWhere(whereStr, params) {
  if (!whereStr || !whereStr.trim()) return {};
  const filter = {};
  const clauses = whereStr.split(/\s+AND\s+/i);
  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (!trimmed) continue;
    if (/IS\s+NULL/i.test(trimmed)) {
      const col = trimmed.replace(/\s+IS\s+NULL/i, '').trim();
      filter[col] = null;
    } else if (/IS\s+NOT\s+NULL/i.test(trimmed)) {
      const col = trimmed.replace(/\s+IS\s+NOT\s+NULL/i, '').trim();
      filter[col] = { $ne: null };
    } else if (/\s+IN\s*\(/i.test(trimmed)) {
      const match = trimmed.match(/^([a-zA-Z0-9_]+)\s+IN\s*\(([\s\S]+?)\)$/i);
      if (match) {
        const colName = match[1].trim();
        const itemsStr = match[2].trim();
        const items = itemsStr.split(',').map(s => s.trim().replace(/^'|'$/g, ''));
        filter[colName] = { $in: items };
      }
    } else {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const col = trimmed.substring(0, eqIdx).trim();
        const val = trimmed.substring(eqIdx + 1).trim();
        if (val === '?') {
          filter[col] = params.shift();
        } else if (val.startsWith("'") && val.endsWith("'")) {
          filter[col] = val.slice(1, -1);
        } else if (val.toUpperCase() === 'NULL') {
          filter[col] = null;
        } else if (val.toUpperCase() === 'FALSE') {
          filter[col] = false;
        } else if (val.toUpperCase() === 'TRUE') {
          filter[col] = true;
        } else if (!isNaN(Number(val))) {
          filter[col] = Number(val);
        } else {
          filter[col] = val;
        }
      }
    }
  }
  return filter;
}

async function executeMongoSql(store, sqlText, params = []) {
  const p = [...(params || [])];
  const trimmed = String(sqlText || '').trim();

  if (/^ALTER\s+TABLE/i.test(trimmed)) {
    return { rows: [], rowCount: 0 };
  }

  if (/schema_migrations/i.test(trimmed)) {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8].map(v => ({ version: v }));
    return { rows, rowCount: rows.length };
  }

  if (/strftime/i.test(trimmed) || /clock_timestamp/i.test(trimmed)) {
    return { rows: [{ now: new Date().toISOString() }], rowCount: 1 };
  }

  const selectMatch = trimmed.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+([\s\S]+?))?(?:\s+LIMIT\s+([0-9?]+))?$/i);
  if (selectMatch) {
    const [, fieldsStr, table, whereStr, orderStr, limitStr] = selectMatch;
    const col = store.col(table);
    const filter = parseSqlWhere(whereStr, p);
    let cursor = col.find(filter);

    if (orderStr) {
      const sort = {};
      const parts = orderStr.split(',');
      for (const part of parts) {
        const [field, dir] = part.trim().split(/\s+/);
        sort[field] = (dir && dir.toUpperCase() === 'DESC') ? -1 : 1;
      }
      cursor = cursor.sort(sort);
    }
    
    if (limitStr) {
      const limitVal = limitStr === '?' ? p.shift() : parseInt(limitStr, 10);
      if (limitVal) cursor = cursor.limit(limitVal);
    }

    const docs = await cursor.toArray();
    let rows = docs.map(doc => {
      const r = decode(doc);
      if (r && r._id && !r.id && typeof r._id === 'string') r.id = r._id;
      return r;
    });

    if (/COUNT\(\*\)\s+AS\s+count/i.test(fieldsStr)) {
      rows = [{ count: docs.length }];
    } else if (fieldsStr.trim() !== '*') {
      const fields = fieldsStr.split(',').map(f => f.trim().replace(/^DISTINCT\s+/i, ''));
      rows = rows.map(r => {
        const projected = {};
        for (const f of fields) {
          projected[f] = r[f];
        }
        return projected;
      });
    }

    return { rows, rowCount: rows.length };
  }

  const updateMatch = trimmed.match(/^UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+?))?(?:\s+RETURNING\s+([\s\S]+?))?$/i);
  if (updateMatch) {
    const [, table, setStr, whereStr, returningStr] = updateMatch;
    const col = store.col(table);
    const setDoc = parseSqlSet(setStr, p);
    const filter = parseSqlWhere(whereStr, p);
    if (returningStr) {
      const updated = await col.findOneAndUpdate(filter, { $set: setDoc }, { returnDocument: 'after' });
      const row = updated ? decode(updated) : null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    const res = await col.updateMany(filter, { $set: setDoc });
    return { rows: [], rowCount: res.matchedCount };
  }

  const insertMatch = trimmed.match(/^INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([\s\S]+?)\)\s*VALUES\s*\(([\s\S]+?)\)(?:\s+ON\s+CONFLICT\s*(?:\(([\s\S]+?)\))?[\s\S]*?)?$/i);
  if (insertMatch) {
    const [, table, colsStr, valsStr, conflictCol] = insertMatch;
    const col = store.col(table);
    const cols = colsStr.split(',').map(c => c.trim());
    const vals = valsStr.split(',').map(v => v.trim());
    const doc = {};
    for (let i = 0; i < cols.length; i++) {
      const v = vals[i];
      if (v === '?') {
        doc[cols[i]] = p.shift();
      } else if (v.startsWith("'") && v.endsWith("'")) {
        doc[cols[i]] = v.slice(1, -1);
      } else if (v.toUpperCase() === 'NULL') {
        doc[cols[i]] = null;
      } else if (v.toUpperCase() === 'TRUE') {
        doc[cols[i]] = true;
      } else if (v.toUpperCase() === 'FALSE') {
        doc[cols[i]] = false;
      } else if (!isNaN(Number(v))) {
        doc[cols[i]] = Number(v);
      } else {
        doc[cols[i]] = v;
      }
    }
    if (conflictCol && doc[conflictCol.trim()] !== undefined) {
      const existing = await col.findOne({ [conflictCol.trim()]: doc[conflictCol.trim()] });
      if (existing) return { rows: [], rowCount: 0 };
    }
    try {
      await col.insertOne(doc);
      return { rows: [], rowCount: 1 };
    } catch (err) {
      if (err.code === 11000 || String(err.message).includes('E11000')) {
        return { rows: [], rowCount: 0 };
      }
      throw err;
    }
  }

  const deleteMatch = trimmed.match(/^DELETE\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+([\s\S]+?))?$/i);
  if (deleteMatch) {
    const [, table, whereStr] = deleteMatch;
    const col = store.col(table);
    const filter = parseSqlWhere(whereStr, p);
    const res = await col.deleteMany(filter);
    return { rows: [], rowCount: res.deletedCount };
  }

  return { rows: [], rowCount: 0 };
}

function getDbNameFromUri(uri) {
  if (!uri || typeof uri !== 'string') return null;
  try {
    const parsed = new URL(uri);
    const name = parsed.pathname.replace(/^\//, '').split('?')[0].trim();
    return name || null;
  } catch {
    const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/i);
    return match ? match[1].trim() : null;
  }
}

class MongoMessageStore {
  constructor({ databaseUrl, mongoUri, databaseName, collectionPrefix = '', client, db, logger } = {}) {
    this.mongoUri = mongoUri || (databaseUrl && !databaseUrl.startsWith('file:') && !databaseUrl.startsWith('postgres') ? databaseUrl : process.env.MONGODB_URI);
    this.databaseName = databaseName || getDbNameFromUri(this.mongoUri) || 'voltronix_crm';
    this.collectionPrefix = collectionPrefix;
    this.client = client || null;
    this.db = db || null;
    this.logger = logger || null;
    this.initialized = false;
    this.dialect = 'mongodb';
    this.driver = {
      dialect: 'mongodb',
      query: async (sqlText, params = []) => executeMongoSql(this, sqlText, params),
      transaction: async (generatorFunc) => {
        const iterator = generatorFunc();
        let state = iterator.next();
        while (!state.done) {
          try {
            const queryObj = state.value;
            const res = await executeMongoSql(this, queryObj.sql, queryObj.values);
            state = iterator.next(res);
          } catch (err) {
            if (typeof iterator.throw === 'function') {
              iterator.throw(err);
            } else {
              throw err;
            }
          }
        }
        return state.value;
      }
    };
  }

  col(name) {
    if (!this.db) throw new Error('Database not initialized. Call init() first.');
    return this.db.collection(this.collectionPrefix + name);
  }

  async init() {
    if (this.initialized) return this;
    if (!this.db) {
      if (mongoose.connection && mongoose.connection.readyState === 1) {
        this.db = mongoose.connection.useDb(this.databaseName).db;
      } else {
        await connectMongoDB({ env: { MONGODB_URI: this.mongoUri }, logger: this.logger });
        this.db = mongoose.connection.useDb(this.databaseName).db;
      }
    }
    await this._ensureIndexes();
    this.initialized = true;
    return this;
  }

  async _ensureIndexes() {
    const indexes = [
      { col: 'whatsapp_messages', key: { whatsapp_message_id: 1 }, options: { unique: true } },
      { col: 'whatsapp_messages', key: { processing_flow: 1, processing_status: 1, next_attempt_at: 1, lease_expires_at: 1 } },
      { col: 'whatsapp_messages', key: { sender_phone: 1, received_at: -1 } },
      { col: 'lead_sessions', key: { id: 1 }, options: { unique: true } },
      { col: 'lead_sessions', key: { sender_phone: 1, state: 1, created_at: -1 } },
      { col: 'leads', key: { id: 1 }, options: { unique: true } },
      { col: 'leads', key: { leadId: 1 }, options: { unique: true, sparse: true } },
      { col: 'leads', key: { whatsapp_message_id: 1 }, options: { sparse: true } },
      { col: 'leads', key: { phone: 1 } },
      { col: 'leads', key: { zoho_lead_id: 1 } },
      { col: 'leads', key: { zoho_status: 1 } },
      { col: 'leads', key: { created_at: -1 } },
      { col: 'lead_extractions', key: { message_id: 1 }, options: { unique: true } },
      { col: 'lead_extractions', key: { processing_status: 1, next_attempt_at: 1, lease_expires_at: 1 } },
      { col: 'reply_outbox', key: { id: 1 }, options: { unique: true } },
      { col: 'reply_outbox', key: { message_id: 1 }, options: { unique: true } },
      { col: 'reply_outbox', key: { status: 1, lease_expires_at: 1, created_at: 1 } },
      { col: 'reply_history', key: { id: 1 }, options: { unique: true } },
      { col: 'message_receipts', key: { sequence: 1 }, options: { unique: true } },
      { col: 'message_receipts', key: { message_id: 1 }, options: { unique: true } },
      { col: 'processing_logs', key: { id: 1 }, options: { unique: true } },
      { col: 'processing_logs', key: { message_id: 1 } },
      { col: 'contact_locks', key: { contact_key: 1 }, options: { unique: true } },
      { col: 'contact_locks', key: { lease_expires_at: 1 } },
      { col: 'crm_contacts', key: { contact_key: 1 }, options: { unique: true } },
      { col: 'crm_outgoing', key: { id: 1 }, options: { unique: true } },
      { col: 'crm_outgoing', key: { request_key: 1 }, options: { unique: true } },
      { col: 'crm_outgoing', key: { message_id: 1 } },
      { col: 'lead_groups', key: { id: 1 }, options: { unique: true } },
      { col: 'lead_messages', key: { message_id: 1 } },
      { col: 'lead_attachments', key: { id: 1 } },
      { col: 'lead_attachments', key: { lead_id: 1 } },
    ];

    for (const idx of indexes) {
      try {
        await this.col(idx.col).createIndex(idx.key, idx.options || {});
      } catch (err) {
        if (err.code !== 85 && err.code !== 86) {
          this.logger?.warn?.({ event: 'mongo_index_warning', collection: idx.col, error: err.message });
        }
      }
    }
  }

  async close() {
    this.initialized = false;
  }

  async ping() {
    if (!this.db) throw new Error('Database not connected.');
    await this.db.command({ ping: 1 });
    return true;
  }

  async _now() {
    return new Date().toISOString();
  }

  async _nextReceiptSequence() {
    const res = await this.col('counters').findOneAndUpdate(
      { _id: 'receipt_sequence' },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    return res?.seq || res?.value?.seq || 1;
  }

  _patch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Invalid message patch.');
    const update = {};
    for (const [key, original] of Object.entries(patch)) {
      if (!PATCH_FIELDS.has(key)) throw new TypeError(`Unsupported message patch field: ${key}.`);
      let value = original;
      if (key === 'processing_status' && !STATUSES.has(value)) throw new TypeError('Invalid processing_status.');
      else if (key === 'crm_write_started') {
        if (typeof value !== 'boolean') throw new TypeError('Invalid crm_write_started.');
      } else if (key === 'extracted_lead_data') {
        if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new TypeError('Invalid extracted_lead_data.');
        if (value) {
          const str = JSON.stringify(value);
          if (str.length > 24000) throw new TypeError('extracted_lead_data is too large.');
        }
      } else if (key === 'processed_at' || key === 'next_attempt_at') {
        value = value === null ? null : iso(value);
      } else if (key !== 'processing_status') {
        value = string(value, key, key === 'error_message' ? 1000 : 128, true);
      }
      update[key] = value;
    }
    if (!Object.keys(update).length) throw new TypeError('Message patch must contain at least one field.');
    if (patch.processing_status && patch.processing_status !== 'PROCESSING') {
      update.lease_token = null;
      update.lease_expires_at = null;
      if (patch.processing_status !== 'FAILED' && !('next_attempt_at' in patch)) update.next_attempt_at = null;
    }
    return update;
  }

  async enqueueMany(messages, { includeInsertedIds = false, replyText = null, processingFlow = null } = {}) {
    if (!Array.isArray(messages) || messages.length > 1000) throw new TypeError('Invalid messages batch.');
    validateReplyText(replyText);
    validateProcessingFlow(processingFlow);
    if (processingFlow !== null && replyText !== null) throw new TypeError('A processing flow cannot be combined with a fixed reply.');
    const prepared = messages.map(message => ({
      id: string(message.whatsapp_message_id, 'whatsapp_message_id', 512),
      sender: string(message.sender_phone, 'sender_phone', 32),
      text: message.message_text === '' ? '' : string(message.message_text, 'message_text', 10000),
      type: string(message.message_type || 'text', 'message_type', 32),
      authenticated: message.authenticated === true,
      requestLeadExtraction: message.request_lead_extraction === true,
      requestLeadWorkflow: message.request_lead_workflow === true,
      senderName: string(message.sender_name ?? null, 'sender_name', 200, true),
      mediaId: string(message.media_id ?? null, 'media_id', 512, true),
      mediaMimeType: string(message.media_mime_type ?? null, 'media_mime_type', 200, true),
      mediaFilename: string(message.media_filename ?? null, 'media_filename', 255, true),
      received: iso(message.received_at)
    }));

    const now = await this._now();
    let inserted = 0;
    const insertedIds = [];

    for (const message of prepared) {
      const eligible = message.authenticated && message.type === 'text' && Boolean(message.text.trim());
      const workflow = message.authenticated && message.requestLeadWorkflow && (message.type !== 'text' || Boolean(message.text.trim()));
      const flow = workflow ? 'boss_lead' : eligible && processingFlow !== 'boss_lead' ? processingFlow : null;

      const doc = {
        whatsapp_message_id: message.id,
        sender_phone: message.sender,
        message_text: message.text,
        message_type: message.type,
        authenticated: message.authenticated,
        received_at: message.received,
        created_at: now,
        processing_flow: flow,
        sender_name: message.senderName,
        media_id: message.mediaId,
        media_mime_type: message.mediaMimeType,
        media_filename: message.mediaFilename,
        processing_status: 'RECEIVED',
        attempts: 0,
        lease_token: null,
        lease_expires_at: null,
        next_attempt_at: null,
        error_message: null,
        session_id: null,
        conversation_kind: null,
        extracted_lead_data: null,
        extracted_text: null,
        transcription: null,
        zoho_lead_id: null,
        crm_action: null,
        crm_write_started: false,
        processed_at: null
      };

      let insertedCurrent;
      try {
        await this.col('whatsapp_messages').insertOne(doc);
        insertedCurrent = true;
      } catch (err) {
        if (err.code === 11000 || String(err.message).includes('E11000')) {
          insertedCurrent = false;
        } else {
          throw err;
        }
      }

      if (insertedCurrent) {
        inserted += 1;
        if (includeInsertedIds) insertedIds.push(message.id);
        const seq = await this._nextReceiptSequence();
        await this.col('message_receipts').insertOne({ sequence: seq, message_id: message.id, created_at: now });

        if (workflow || (eligible && processingFlow === 'conversation' && message.requestLeadExtraction)) {
          await this.col('lead_extractions').insertOne({
            id: randomUUID(),
            message_id: message.id,
            processing_status: 'RECEIVED',
            attempts: 0,
            lease_token: null,
            lease_expires_at: null,
            next_attempt_at: null,
            error_message: null,
            result: null,
            created_at: now
          });
        }

        if (replyText !== null && eligible && !workflow) {
          await this.col('whatsapp_messages').updateOne(
            { whatsapp_message_id: message.id },
            { $set: { processing_status: 'SUCCESS', processed_at: now } }
          );
          await this.col('reply_outbox').insertOne({
            id: randomUUID(),
            message_id: message.id,
            sender_phone: message.sender,
            text: replyText,
            status: 'PENDING',
            created_at: now,
            sent_at: null,
            provider_message_id: null,
            error_message: null,
            lease_token: null,
            lease_expires_at: null
          });
        }
      }
    }

    return { inserted, duplicates: messages.length - inserted, ...(includeInsertedIds ? { insertedIds } : {}) };
  }

  async getMessage(id) {
    const doc = await this.col('whatsapp_messages').findOne({ whatsapp_message_id: id });
    return decode(doc);
  }

  async getLeadExtraction(messageId) {
    string(messageId, 'messageId', 512);
    const doc = await this.col('lead_extractions').findOne({ message_id: messageId });
    return decode(doc);
  }

  async claimLeadExtraction({ leaseMs = 120000, maxAttempts = 3, messageIds = null } = {}) {
    positiveInteger(leaseMs, 'leaseMs', 3600000);
    positiveInteger(maxAttempts, 'maxAttempts', 100);
    validateMessageIds(messageIds);
    if (Array.isArray(messageIds) && messageIds.length === 0) return null;

    const now = await this._now();

    // 1. Mark exhausted jobs
    const exhaustedFilter = {
      attempts: { $gte: maxAttempts },
      $or: [
        { processing_status: 'RECEIVED' },
        { processing_status: 'FAILED', next_attempt_at: { $ne: null } },
        { processing_status: 'PROCESSING', lease_expires_at: { $lte: now } }
      ]
    };
    if (messageIds) exhaustedFilter.message_id = { $in: messageIds };

    const exhaustedJobs = await this.col('lead_extractions').find(exhaustedFilter).toArray();
    for (const job of exhaustedJobs) {
      await this.col('lead_extractions').updateOne(
        { _id: job._id },
        {
          $set: {
            processing_status: 'FAILED',
            error_message: job.error_message || 'PROCESSING_ATTEMPTS_EXHAUSTED',
            processed_at: now,
            next_attempt_at: null,
            lease_token: null,
            lease_expires_at: null
          }
        }
      );

      const msg = await this.col('whatsapp_messages').findOne({ whatsapp_message_id: job.message_id, processing_flow: 'boss_lead' });
      if (msg) {
        await this.col('lead_sessions').updateMany(
          { sender_phone: msg.sender_phone, state: 'awaiting_confirmation' },
          { $set: { state: 'collecting', updated_at: now } }
        );
        await this.col('leads').updateOne(
          { whatsapp_message_id: job.message_id, extraction_status: { $ne: 'completed' }, zoho_status: 'not_started', zoho_lead_id: null },
          { $set: { extraction_status: 'failed', validation_status: 'pending', error_stage: 'extraction', error_code: 'PROCESSING_ATTEMPTS_EXHAUSTED', updated_at: now } }
        );
        await this.col('whatsapp_messages').updateOne(
          { whatsapp_message_id: job.message_id, processing_flow: 'boss_lead' },
          { $set: { processing_status: 'FAILED', error_message: 'PROCESSING_ATTEMPTS_EXHAUSTED', processed_at: now, next_attempt_at: null, lease_token: null, lease_expires_at: null } }
        );
      }
    }

    // 2. Find eligible candidate
    const candidateFilter = {
      attempts: { $lt: maxAttempts },
      $or: [
        { processing_status: 'RECEIVED' },
        { processing_status: 'FAILED', next_attempt_at: { $lte: now } },
        { processing_status: 'PROCESSING', lease_expires_at: { $lte: now } }
      ]
    };
    if (messageIds) candidateFilter.message_id = { $in: messageIds };

    const candidates = await this.col('lead_extractions').find(candidateFilter).toArray();
    if (!candidates.length) return null;

    const messageIdsList = candidates.map(c => c.message_id);
    const receipts = await this.col('message_receipts').find({ message_id: { $in: messageIdsList } }).toArray();
    const receiptMap = new Map(receipts.map(r => [r.message_id, r.sequence]));

    const messages = await this.col('whatsapp_messages').find({
      whatsapp_message_id: { $in: messageIdsList },
      authenticated: true,
      $or: [
        { processing_flow: 'boss_lead' },
        { processing_flow: 'conversation', message_type: 'text' }
      ]
    }).toArray();
    const messageMap = new Map(messages.map(m => [m.whatsapp_message_id, m]));

    const validCandidates = candidates.filter(c => messageMap.has(c.message_id) && receiptMap.has(c.message_id));
    validCandidates.sort((a, b) => (receiptMap.get(a.message_id) || 0) - (receiptMap.get(b.message_id) || 0));

    for (const candidate of validCandidates) {
      const msg = messageMap.get(candidate.message_id);
      if (msg.processing_flow === 'boss_lead') {
        const mySeq = receiptMap.get(candidate.message_id);
        const earlierMessages = await this.col('whatsapp_messages').find({
          sender_phone: msg.sender_phone,
          processing_flow: 'boss_lead',
          authenticated: true,
          whatsapp_message_id: { $ne: candidate.message_id }
        }).toArray();
        if (earlierMessages.length) {
          const earlierIds = earlierMessages.map(m => m.whatsapp_message_id);
          const earlierReceiptsQuery = {
            message_id: { $in: earlierIds },
            sequence: { $lt: mySeq }
          };
          if (messageIds) earlierReceiptsQuery.message_id = { $in: messageIds.filter(id => id !== candidate.message_id) };
          const earlierReceipts = await this.col('message_receipts').find(earlierReceiptsQuery).toArray();
          if (earlierReceipts.length) {
            const earlierExtractions = await this.col('lead_extractions').find({
              message_id: { $in: earlierReceipts.map(r => r.message_id) },
              $or: [
                { processing_status: { $in: ['RECEIVED', 'PROCESSING'] } },
                { processing_status: 'FAILED', next_attempt_at: { $ne: null } }
              ]
            }).toArray();
            if (earlierExtractions.length) {
              continue;
            }
          }
        }
      }

      const leaseToken = randomUUID();
      const leaseExpiresAt = addMilliseconds(now, leaseMs);
      const claimed = await this.col('lead_extractions').findOneAndUpdate(
        {
          message_id: candidate.message_id,
          attempts: candidate.attempts,
          processing_status: candidate.processing_status
        },
        {
          $set: {
            processing_status: 'PROCESSING',
            lease_token: leaseToken,
            lease_expires_at: leaseExpiresAt,
            next_attempt_at: null
          },
          $inc: { attempts: 1 }
        },
        { returnDocument: 'after' }
      );

      const job = claimed?.value || claimed;
      if (job) {
        await this.col('leads').updateOne(
          { whatsapp_message_id: candidate.message_id, extraction_status: { $ne: 'completed' }, zoho_status: 'not_started', zoho_lead_id: null },
          { $set: { extraction_status: 'processing', validation_status: 'pending', validation_result: null, error_stage: null, error_code: null, updated_at: now } }
        );
        return decode({ ...msg, ...job });
      }
    }

    return null;
  }

  async beginLeadExtractionProcessing(messageId, leaseToken, leaseMs = 120000) {
    string(messageId, 'messageId', 512);
    string(leaseToken, 'leaseToken', 128);
    positiveInteger(leaseMs, 'leaseMs', 3600000);
    const now = await this._now();
    const executionToken = randomUUID();

    const msg = await this.col('whatsapp_messages').findOne({ whatsapp_message_id: messageId, processing_flow: 'boss_lead', authenticated: true });
    if (!msg) return null;

    const res = await this.col('lead_extractions').updateOne(
      {
        message_id: messageId,
        lease_token: leaseToken,
        processing_status: 'PROCESSING',
        lease_expires_at: { $gt: now }
      },
      {
        $set: {
          lease_token: executionToken,
          lease_expires_at: addMilliseconds(now, leaseMs)
        }
      }
    );

    return res.matchedCount === 1 ? executionToken : null;
  }

  async heartbeatLeadExtraction(messageId, leaseToken, leaseMs = 120000) {
    string(messageId, 'messageId', 512);
    string(leaseToken, 'leaseToken', 128);
    positiveInteger(leaseMs, 'leaseMs', 3600000);
    const now = await this._now();
    const res = await this.col('lead_extractions').updateOne(
      {
        message_id: messageId,
        lease_token: leaseToken,
        processing_status: 'PROCESSING',
        lease_expires_at: { $gt: now }
      },
      {
        $set: { lease_expires_at: addMilliseconds(now, leaseMs) }
      }
    );
    return res.matchedCount === 1;
  }

  async checkpointLeadMedia(messageId, leaseToken, { transcription, extractedText, storageReference, storageUrl } = {}) {
    string(messageId, 'messageId', 512);
    string(leaseToken, 'leaseToken', 128);
    mediaText(transcription, 'transcription');
    mediaText(extractedText, 'extracted text');
    const entries = [
      ['transcription', transcription],
      ['extracted_text', extractedText],
      ['storage_reference', storageReference],
      ['storage_url', storageUrl]
    ].filter(([, value]) => value !== undefined);
    if (!entries.length) throw new TypeError('A media checkpoint requires text.');
    const now = await this._now();

    const msg = await this.col('whatsapp_messages').findOne({ whatsapp_message_id: messageId, processing_flow: 'boss_lead', authenticated: true });
    if (!msg) return false;

    const extraction = await this.col('lead_extractions').findOne({
      message_id: messageId,
      lease_token: leaseToken,
      processing_status: 'PROCESSING',
      lease_expires_at: { $gt: now }
    });
    if (!extraction) return false;

    const update = Object.fromEntries(entries);
    await this.col('whatsapp_messages').updateOne({ whatsapp_message_id: messageId }, { $set: update });
    return true;
  }

  async saveMediaFile({ messageId, mediaId, buffer, mimeType, filename } = {}) {
    if (!buffer) return null;
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (!this.mediaBucket && this.db) {
      const { GridFSBucket } = require('mongodb');
      this.mediaBucket = new GridFSBucket(this.db, { bucketName: 'lead_media' });
    }
    const fileId = new mongoose.Types.ObjectId();
    const ext = mimeType?.split('/')[1]?.replace(/^jpeg$/, 'jpg') || 'bin';
    const safeFilename = filename || `${mediaId || fileId.toString()}.${ext}`;

    if (this.mediaBucket) {
      const uploadStream = this.mediaBucket.openUploadStreamWithId(fileId, safeFilename, {
        metadata: {
          messageId: messageId || null,
          mediaId: mediaId || null,
          mimeType: mimeType || 'application/octet-stream',
          uploadedAt: new Date().toISOString()
        }
      });
      await new Promise((resolve, reject) => {
        uploadStream.on('finish', resolve);
        uploadStream.on('error', reject);
        uploadStream.end(buf);
      });
    }

    const storageReference = fileId.toString();
    const storageUrl = `/api/media/${storageReference}`;
    return {
      storageReference,
      storageUrl,
      filename: safeFilename,
      sizeBytes: buf.length,
      mimeType: mimeType || 'application/octet-stream'
    };
  }

  async getMediaFile(storageReference) {
    if (!storageReference) return null;
    const ref = typeof storageReference === 'object'
      ? (storageReference.storageReference || storageReference.storage_reference || null)
      : storageReference;
    if (!ref || typeof ref !== 'string') return null;
    if (!this.mediaBucket && this.db) {
      const { GridFSBucket } = require('mongodb');
      this.mediaBucket = new GridFSBucket(this.db, { bucketName: 'lead_media' });
    }
    if (!this.mediaBucket) return null;
    let fileId;
    try {
      fileId = new mongoose.Types.ObjectId(ref);
    } catch {
      return null;
    }
    // Fetch mimeType from GridFS file metadata alongside the binary stream
    let mimeType = 'application/octet-stream';
    try {
      const fileDoc = await this.db.collection('lead_media.files').findOne({ _id: fileId });
      if (fileDoc?.metadata?.mimeType) mimeType = fileDoc.metadata.mimeType;
    } catch { /* fall through with default mimeType */ }
    const chunks = [];
    const buffer = await new Promise((resolve) => {
      const stream = this.mediaBucket.openDownloadStream(fileId);
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', () => resolve(null));
    });
    if (!buffer) return null;
    return { buffer, mimeType };
  }

  async getMediaFileByMediaId(mediaId) {
    if (!mediaId) return null;
    if (!this.mediaBucket && this.db) {
      const { GridFSBucket } = require('mongodb');
      this.mediaBucket = new GridFSBucket(this.db, { bucketName: 'lead_media' });
    }
    if (!this.mediaBucket) return null;
    try {
      const fileDoc = await this.db.collection('lead_media.files').findOne({ 'metadata.mediaId': String(mediaId) });
      if (fileDoc) {
        return this.getMediaFile(fileDoc._id.toString());
      }
      const msg = await this.col('whatsapp_messages').findOne({ media_id: String(mediaId) });
      if (msg?.storage_reference) {
        return this.getMediaFile(msg.storage_reference);
      }
    } catch { /* fall through */ }
    return null;
  }

  async finishLeadExtraction(messageId, leaseToken, patch) {
    string(messageId, 'messageId', 512);
    string(leaseToken, 'leaseToken', 128);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Invalid extraction patch.');
    for (const key of Object.keys(patch)) {
      if (!EXTRACTION_PATCH_FIELDS.has(key)) throw new TypeError(`Unsupported extraction patch field: ${key}.`);
    }
    const processingStatus = patch.processing_status;
    if (!['SUCCESS', 'IRRELEVANT', 'FAILED'].includes(processingStatus)) throw new TypeError('Invalid extraction processing_status.');
    const result = patch.result === undefined ? null : patch.result;
    if (result !== null) {
      if (typeof result !== 'object' || Array.isArray(result)) throw new TypeError('Invalid extraction result.');
      const serialized = JSON.stringify(result);
      if (!serialized || !serialized.startsWith('{')) throw new TypeError('Invalid extraction result.');
      if (Buffer.byteLength(serialized, 'utf8') > 24000) throw new TypeError('Extraction result is too large.');
    }
    const errorMessage = patch.error_message === undefined ? null : patch.error_message;
    if (errorMessage !== null && (typeof errorMessage !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(errorMessage))) {
      throw new TypeError('Invalid extraction error code.');
    }
    const nextAttemptAt = patch.next_attempt_at === undefined || patch.next_attempt_at === null ? null : iso(patch.next_attempt_at);
    if (nextAttemptAt !== null && processingStatus !== 'FAILED') throw new TypeError('Only failed extraction jobs can retry.');
    const processedAt = patch.processed_at === undefined ? undefined : patch.processed_at === null ? null : iso(patch.processed_at);
    const now = await this._now();

    const msg = await this.col('whatsapp_messages').findOne({
      whatsapp_message_id: messageId,
      $or: [{ processing_flow: null }, { processing_flow: { $ne: 'boss_lead' } }]
    });
    if (!msg) return false;

    const res = await this.col('lead_extractions').updateOne(
      {
        message_id: messageId,
        lease_token: leaseToken,
        processing_status: 'PROCESSING',
        lease_expires_at: { $gt: now }
      },
      {
        $set: {
          processing_status: processingStatus,
          result,
          error_message: errorMessage,
          processed_at: processedAt === undefined ? now : processedAt,
          next_attempt_at: nextAttemptAt,
          lease_token: null,
          lease_expires_at: null
        }
      }
    );

    return res.matchedCount === 1;
  }

  async completeLeadWorkflow(messageId, leaseToken, { result, validation, replyText } = {}) {
    string(messageId, 'messageId', 512);
    string(leaseToken, 'leaseToken', 128);
    const prepared = workflowResult(result);
    const checked = workflowValidation(validation);
    validateReplyText(replyText);
    if (replyText === null || replyText === undefined) throw new TypeError('Lead completion requires a reply.');
    if (!prepared.is_lead && checked.valid) throw new TypeError('An irrelevant message cannot be a valid lead.');
    if (prepared.is_lead && !checked.valid && !checked.missing_fields.length && !checked.errors.length) throw new TypeError('Invalid leads require validation details.');
    const validationStatus = checked.valid ? 'valid' : checked.errors.length ? 'invalid' : 'incomplete';
    const now = await this._now();

    const msg = await this.col('whatsapp_messages').findOne({ whatsapp_message_id: messageId, processing_flow: 'boss_lead', authenticated: true });
    if (!msg) return false;

    const owned = await this.col('lead_extractions').updateOne(
      {
        message_id: messageId,
        lease_token: leaseToken,
        processing_status: 'PROCESSING',
        lease_expires_at: { $gt: now }
      },
      {
        $set: {
          processing_status: prepared.is_lead ? 'SUCCESS' : 'IRRELEVANT',
          result: prepared,
          error_message: null,
          processed_at: now,
          next_attempt_at: null,
          lease_token: null,
          lease_expires_at: null
        }
      }
    );
    if (owned.matchedCount !== 1) return false;

    const leadId = randomUUID();
    if (prepared.is_lead) {
      await this.col('leads').updateOne(
        { whatsapp_message_id: messageId },
        {
          $setOnInsert: {
            id: leadId,
            leadId,
            whatsapp_message_id: messageId,
            sender_phone: msg.sender_phone,
            senderPhone: msg.sender_phone,
            original_message: msg.message_text,
            created_at: now
          },
          $set: {
            ...prepared.lead,
            extraction_status: 'completed',
            validation_status: validationStatus,
            zoho_status: checked.valid ? 'pending' : 'not_started',
            validation_result: checked,
            error_stage: checked.errors.length ? 'validation' : null,
            error_code: checked.errors[0] || null,
            updated_at: now
          }
        },
        { upsert: true }
      );
    } else {
      await this.col('leads').deleteOne({
        whatsapp_message_id: messageId,
        extraction_status: { $in: ['pending', 'processing', 'failed'] },
        zoho_status: 'not_started',
        zoho_lead_id: null
      });
    }

    await this.col('whatsapp_messages').updateOne(
      { whatsapp_message_id: messageId, processing_flow: 'boss_lead' },
      {
        $set: {
          processing_status: prepared.is_lead && !checked.valid ? 'NEEDS_INFORMATION' : 'SUCCESS',
          error_message: null,
          processed_at: now,
          next_attempt_at: null,
          lease_token: null,
          lease_expires_at: null
        }
      }
    );

    try {
      await this.col('reply_outbox').insertOne({
        id: randomUUID(),
        message_id: messageId,
        sender_phone: msg.sender_phone,
        text: replyText,
        status: 'PENDING',
        created_at: now,
        sent_at: null,
        provider_message_id: null,
        error_message: null,
        lease_token: null,
        lease_expires_at: null
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }

    return true;
  }

  async failLeadWorkflow(messageId, leaseToken, { code, stage, nextAttemptAt = null, replyText = null } = {}) {
    string(messageId, 'messageId', 512);
    string(leaseToken, 'leaseToken', 128);
    workflowCode(code);
    if (!['extraction', 'schema', 'validation', 'persistence'].includes(stage)) throw new TypeError('Invalid lead error stage.');
    const retryAt = nextAttemptAt === null ? null : iso(nextAttemptAt);
    validateReplyText(replyText);
    if (retryAt !== null && replyText !== null) throw new TypeError('Retrying lead work cannot queue a terminal reply.');
    const now = await this._now();

    const msg = await this.col('whatsapp_messages').findOne({ whatsapp_message_id: messageId, processing_flow: 'boss_lead', authenticated: true });
    if (!msg) return false;

    const owned = await this.col('lead_extractions').updateOne(
      {
        message_id: messageId,
        lease_token: leaseToken,
        processing_status: 'PROCESSING',
        lease_expires_at: { $gt: now }
      },
      {
        $set: {
          processing_status: 'FAILED',
          result: null,
          error_message: code,
          processed_at: retryAt === null ? now : null,
          next_attempt_at: retryAt,
          lease_token: null,
          lease_expires_at: null
        }
      }
    );
    if (owned.matchedCount !== 1) return false;

    await this.col('leads').updateOne(
      { whatsapp_message_id: messageId, extraction_status: { $in: ['pending', 'processing', 'failed'] }, zoho_status: 'not_started', zoho_lead_id: null },
      {
        $set: {
          extraction_status: 'failed',
          validation_status: stage === 'schema' ? 'invalid' : 'pending',
          zoho_status: 'not_started',
          validation_result: { valid: false, missing_fields: [], errors: [code] },
          error_stage: stage,
          error_code: code,
          updated_at: now
        }
      }
    );

    if (retryAt === null) {
      await this.col('lead_sessions').updateMany(
        { sender_phone: msg.sender_phone, state: 'awaiting_confirmation' },
        { $set: { state: 'collecting', updated_at: now } }
      );
      await this.col('whatsapp_messages').updateOne(
        { whatsapp_message_id: messageId, processing_flow: 'boss_lead' },
        {
          $set: {
            processing_status: 'FAILED',
            error_message: code,
            processed_at: now,
            next_attempt_at: null,
            lease_token: null,
            lease_expires_at: null
          }
        }
      );
      if (replyText !== null) {
        try {
          await this.col('reply_outbox').insertOne({
            id: randomUUID(),
            message_id: messageId,
            sender_phone: msg.sender_phone,
            text: replyText,
            status: 'PENDING',
            created_at: now,
            sent_at: null,
            provider_message_id: null,
            error_message: null,
            lease_token: null,
            lease_expires_at: null
          });
        } catch (err) {
          if (err.code !== 11000) throw err;
        }
      }
    }

    return true;
  }

  async getActiveLeadSession(senderPhone) {
    string(senderPhone, 'sender phone', 32);
    const doc = await this.col('lead_sessions').findOne({
      sender_phone: senderPhone,
      state: { $in: ['collecting', 'awaiting_confirmation'] }
    });
    return decode(doc);
  }

  async completeLeadSessionTurn(messageId, leaseToken, { sessionId = null, result = null, validation = null,
    state = null, originalMessage = null, replyText = null, kind = 'details', errorCode = null, errorStage = null,
    pendingAction, startNewSession = false, transcription, extractedText, leadId = null } = {}) {
    string(messageId, 'messageId', 512);
    string(leaseToken, 'leaseToken', 128);
    string(sessionId, 'sessionId', 128, true);
    if (![null, 'collecting', 'awaiting_confirmation', 'completed', 'discarded'].includes(state)) throw new TypeError('Invalid lead session state.');
    if (!['greeting', 'conversation', 'details', 'confirmation', 'defer', 'media_error', 'new_lead', 'discard'].includes(kind)) throw new TypeError('Invalid conversation kind.');
    if (![undefined, null, 'new_lead'].includes(pendingAction)) throw new TypeError('Invalid pending session action.');
    if (typeof startNewSession !== 'boolean' || (startNewSession && state !== 'discarded')) throw new TypeError('Invalid new session transition.');

    const prepared = result === null ? null : workflowResult(result);
    const checked = validation === null ? null : workflowValidation(validation);
    if (originalMessage !== '' || kind !== 'new_lead' || state !== 'collecting') string(originalMessage, 'original message', 64000, true);
    mediaText(transcription, 'transcription');
    mediaText(extractedText, 'extracted text');
    validateReplyText(replyText);
    if (errorCode !== null) workflowCode(errorCode);
    if (errorStage !== null && !['extraction', 'schema', 'validation', 'persistence'].includes(errorStage)) throw new TypeError('Invalid lead error stage.');
    if (errorCode !== null && state !== 'collecting') throw new TypeError('Unprocessed lead details must remain collecting.');

    const now = await this._now();
    const inbox = await this.col('whatsapp_messages').findOne({ whatsapp_message_id: messageId, processing_flow: 'boss_lead', authenticated: true });
    if (!inbox) return false;

    const owned = await this.col('lead_extractions').updateOne(
      {
        message_id: messageId,
        lease_token: leaseToken,
        processing_status: 'PROCESSING',
        lease_expires_at: { $gt: now }
      },
      {
        $set: {
          processing_status: errorCode ? 'FAILED' : prepared?.is_lead || state === 'completed' ? 'SUCCESS' : 'IRRELEVANT',
          result: prepared,
          error_message: errorCode,
          processed_at: now,
          next_attempt_at: null,
          lease_token: null,
          lease_expires_at: null
        }
      }
    );
    if (owned.matchedCount !== 1) return false;

    let active = decode(await this.col('lead_sessions').findOne({
      sender_phone: inbox.sender_phone,
      state: { $in: ['collecting', 'awaiting_confirmation'] }
    }));

    if ((active?.id || null) !== sessionId) throw new Error('Lead session ownership changed.');
    if (originalMessage === '' && active) throw new TypeError('An existing lead draft cannot be reset.');
    if (!active && state === null && pendingAction === 'new_lead') throw new TypeError('Pending actions require an active session.');

    if (state === 'completed') {
      const saveValidation = checked || active?.validation_result;
      if (!active || kind !== 'confirmation' || !hasLeadInformation(workflowResult(active.result)) || !saveValidation.valid) {
        throw new Error('Lead requires available information and explicit save confirmation.');
      }

      const finalLeadId = leadId || randomUUID();

      const sessionMsgs = await this.col('whatsapp_messages').find({
        $or: [
          { session_id: active.id },
          { whatsapp_message_id: active.first_message_id },
          { whatsapp_message_id: messageId },
          {
            sender_phone: inbox.sender_phone,
            received_at: { $gte: active.created_at || active.started_at },
          }
        ]
      }).sort({ received_at: 1 }).toArray();

      const allMsgs = sessionMsgs.length > 0 ? sessionMsgs : [inbox];

      const attachments = [];
      for (const m of allMsgs) {
        if (m.media_id) {
          const attId = randomUUID();
          const ext = m.media_mime_type?.split('/')[1]?.replace(/^jpeg$/, 'jpg') || 'bin';
          const filename = m.media_filename || `${m.media_id}.${ext}`;
          const storageReference = m.storage_reference || m.media_id;
          const storageUrl = m.storage_url || `/api/media/${storageReference}`;
          attachments.push({
            id: attId,
            mediaId: m.media_id,
            whatsappMediaId: m.media_id,
            type: m.message_type || 'image',
            mimeType: m.media_mime_type,
            filename,
            source: 'whatsapp',
            whatsappMessageId: m.whatsapp_message_id,
            storageUrl,
            storageReference,
            transcription: m.transcription || null,
            extractedText: m.extracted_text || null,
            zohoAttachmentId: null,
            zohoUploadStatus: 'pending',
            zohoError: null,
            createdAt: now
          });
        }
      }

      const leadRecord = {
        id: finalLeadId,
        whatsapp_message_id: active.first_message_id,
        sender_phone: inbox.sender_phone,
        senderPhone: inbox.sender_phone,
        source: 'boss',
        original_message: active.original_message,
        originalMessage: active.original_message,
        ...active.result.lead,
        companyName: active.result.lead.company_name,
        contactName: active.result.lead.contact_name,
        productOrService: active.result.lead.product_or_service,
        projectLocation: active.result.lead.project_location,
        projectName: active.result.lead.project_name,
        trnNo: active.result.lead.trn_no,
        extraction_status: 'completed',
        extractionStatus: 'completed',
        validation_status: 'valid',
        validationStatus: 'valid',
        zoho_status: 'not_started',
        zohoStatus: 'not_started',
        zoho_lead_id: null,
        zohoLeadId: null,
        zoho_url: null,
        zohoUrl: null,
        zoho_synced_at: null,
        zohoSyncedAt: null,
        attachments,
        attachment_status: attachments.length > 0 ? 'pending' : 'none',
        attachmentStatus: attachments.length > 0 ? 'pending' : 'none',
        validation_result: saveValidation,
        created_at: now,
        updated_at: now
      };

      await this.col('leads').updateOne(
        { id: finalLeadId },
        { $set: leadRecord },
        { upsert: true }
      );

      await this.col('lead_sessions').updateOne(
        { id: active.id },
        {
          $set: {
            state: 'completed',
            validation_result: saveValidation,
            pending_action: null,
            lead_id: finalLeadId,
            completed_at: now,
            updated_at: now
          }
        }
      );

      await this.col('whatsapp_messages').updateMany(
        { $or: [{ session_id: active.id }, { whatsapp_message_id: messageId }] },
        { $set: { lead_id: finalLeadId, session_id: active.id } }
      );

      await this.col('lead_groups').updateOne(
        { id: active.id },
        {
          $setOnInsert: {
            id: active.id,
            sender_phone: inbox.sender_phone,
            source: 'boss',
            lead_id: finalLeadId,
            state: 'closed',
            last_message_at: now,
            created_at: active.created_at || now
          }
        },
        { upsert: true }
      );

      for (const m of allMsgs) {
        await this.col('lead_messages').updateOne(
          { message_id: m.whatsapp_message_id, lead_id: finalLeadId },
          {
            $setOnInsert: {
              message_id: m.whatsapp_message_id,
              lead_id: finalLeadId,
              group_id: active.id,
              extracted: 1,
              created_at: now
            }
          },
          { upsert: true }
        );

        if (m.media_id) {
          const att = attachments.find(a => a.whatsappMessageId === m.whatsapp_message_id);
          await this.col('lead_attachments').updateOne(
            { message_id: m.whatsapp_message_id, lead_id: finalLeadId },
            {
              $setOnInsert: {
                id: att?.id || randomUUID(),
                message_id: m.whatsapp_message_id,
                lead_id: finalLeadId,
                whatsapp_media_id: m.media_id,
                type: m.message_type,
                mime_type: m.media_mime_type,
                filename: m.media_filename || att?.filename,
                storage_reference: m.storage_reference || att?.storageReference || m.media_id,
                storage_url: m.storage_url || att?.storageUrl || `/api/media/${m.media_id}`,
                transcription: m.transcription || null,
                extracted_text: m.extracted_text || null,
                created_at: now
              }
            },
            { upsert: true }
          );
        }
      }
    } else if (state === 'discarded') {
      if (!active || active.pending_action !== 'new_lead' || kind !== 'discard') throw new Error('Lead is not awaiting explicit discard.');
      await this.col('lead_sessions').updateOne(
        { id: active.id },
        { $set: { state: 'discarded', pending_action: null, completed_at: now, updated_at: now } }
      );
      if (startNewSession) {
        await this.col('lead_sessions').insertOne({
          id: randomUUID(),
          sender_phone: inbox.sender_phone,
          state: 'collecting',
          result: emptyLeadDraft(),
          validation_result: emptyLeadValidation(),
          original_message: '',
          first_message_id: messageId,
          created_at: now,
          updated_at: now
        });
      }
    } else if (state !== null) {
      const intentionalEmpty = !active && state === 'collecting' && kind === 'new_lead' && originalMessage === '';
      const nextResult = prepared || active?.result || (intentionalEmpty ? emptyLeadDraft() : null);
      const nextValidation = checked || active?.validation_result || (intentionalEmpty ? emptyLeadValidation() : null);
      const nextOriginal = originalMessage ?? active?.original_message;
      if (!nextResult || !nextValidation || nextOriginal === undefined || nextOriginal === null) throw new TypeError('Lead session requires details and validation.');
      if (state === 'awaiting_confirmation' && (!hasLeadInformation(nextResult) || !nextValidation.valid)) throw new TypeError('Only valid leads can await confirmation.');
      const nextPendingAction = pendingAction === undefined ? active?.pending_action ?? null : pendingAction;

      if (active) {
        await this.col('lead_sessions').updateOne(
          { id: active.id },
          {
            $set: {
              state,
              result: nextResult,
              validation_result: nextValidation,
              original_message: nextOriginal,
              pending_action: nextPendingAction,
              updated_at: now
            }
          }
        );
      } else {
        active = { id: randomUUID() };
        await this.col('lead_sessions').insertOne({
          id: active.id,
          sender_phone: inbox.sender_phone,
          state,
          result: nextResult,
          validation_result: nextValidation,
          original_message: nextOriginal,
          pending_action: nextPendingAction,
          first_message_id: messageId,
          created_at: now,
          updated_at: now
        });
      }
    } else if (active && pendingAction !== undefined) {
      await this.col('lead_sessions').updateOne(
        { id: active.id },
        { $set: { pending_action: pendingAction, updated_at: now } }
      );
    }

    const mediaEntries = [['transcription', transcription], ['extracted_text', extractedText]].filter(([, value]) => value !== undefined);
    if (mediaEntries.length) {
      await this.col('whatsapp_messages').updateOne({ whatsapp_message_id: messageId }, { $set: Object.fromEntries(mediaEntries) });
    }

    await this.col('whatsapp_messages').updateOne(
      { whatsapp_message_id: messageId },
      {
        $set: {
          processing_status: errorCode ? 'FAILED' : state === 'collecting' || state === 'awaiting_confirmation' ? 'NEEDS_INFORMATION' : 'SUCCESS',
          error_message: errorCode,
          processed_at: now,
          next_attempt_at: null,
          lease_token: null,
          lease_expires_at: null,
          session_id: active?.id || null,
          conversation_kind: kind
        }
      }
    );

    if (errorCode) {
      await this.appendLog(messageId, 'lead_session_error', { code: errorCode, stage: errorStage });
    }

    if (replyText !== null) {
      try {
        await this.col('reply_outbox').insertOne({
          id: randomUUID(),
          message_id: messageId,
          sender_phone: inbox.sender_phone,
          text: replyText,
          status: 'PENDING',
          lead_id: state === 'completed' ? (leadId || active?.lead_id || null) : null,
          session_id: active?.id || null,
          created_at: now,
          sent_at: null,
          provider_message_id: null,
          error_message: null,
          lease_token: null,
          lease_expires_at: null
        });
      } catch (err) {
        if (err.code !== 11000) throw err;
      }
    }

    return true;
  }

  async updateLeadZohoStatus(id, { zohoStatus, zohoLeadId = null, errorCode = null, errorStage = null, zohoUrl = null, zohoSyncedAt = null }) {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) throw new TypeError('Invalid lead id.');
    const now = await this._now();
    const update = {
      zoho_status: zohoStatus,
      zohoStatus,
      updated_at: now
    };
    if (zohoLeadId !== undefined) {
      update.zoho_lead_id = zohoLeadId;
      update.zohoLeadId = zohoLeadId;
    }
    if (zohoUrl !== undefined) {
      update.zoho_url = zohoUrl;
      update.zohoUrl = zohoUrl;
    }
    if (zohoSyncedAt !== undefined) {
      update.zoho_synced_at = zohoSyncedAt;
      update.zohoSyncedAt = zohoSyncedAt;
    }
    if (errorCode !== undefined) {
      update.error_code = errorCode;
    }
    if (errorStage !== undefined) {
      update.error_stage = errorStage;
    }
    const res = await this.col('leads').updateOne(
      { $or: [{ id }, { leadId: id }] },
      { $set: update }
    );
    return res.matchedCount === 1;
  }

  async updateReplyText(messageId, text) {
    string(messageId, 'message id', 128);
    string(text, 'reply text', 4096);
    const res = await this.col('reply_outbox').updateOne(
      { message_id: messageId, status: 'PENDING' },
      { $set: { text } }
    );
    return res.matchedCount === 1;
  }

  async getLead(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) throw new TypeError('Invalid lead id.');
    const row = decode(await this.col('leads').findOne({ $or: [{ id }, { leadId: id }] }));
    if (!row) return null;

    if (!Array.isArray(row.attachments)) {
      try {
        row.attachments = (await this.col('lead_attachments').find({ lead_id: id }).sort({ created_at: 1 }).toArray()).map(decode);
      } catch { row.attachments = []; }
    }
    if (!Array.isArray(row.messages)) {
      try {
        row.messages = (await this.col('lead_messages').find({ lead_id: id }).sort({ created_at: 1 }).toArray()).map(decode);
      } catch { row.messages = []; }
    }
    return row;
  }

  async updateLeadAttachments(leadId, attachments = []) {
    if (typeof leadId !== 'string') return false;
    const now = await this._now();
    const hasFailed = attachments.some(a => a.zohoUploadStatus === 'failed');
    const allUploaded = attachments.length > 0 && attachments.every(a => a.zohoUploadStatus === 'uploaded');
    const attachmentStatus = hasFailed ? 'failed' : allUploaded ? 'uploaded' : 'pending';

    await this.col('leads').updateOne(
      { $or: [{ id: leadId }, { leadId }] },
      {
        $set: {
          attachments,
          attachment_status: attachmentStatus,
          attachmentStatus,
          updated_at: now
        }
      }
    );

    for (const att of attachments) {
      if (att.id || att.messageId || att.whatsappMessageId) {
        await this.col('lead_attachments').updateOne(
          { $or: [{ id: att.id }, { message_id: att.messageId || att.whatsappMessageId, lead_id: leadId }] },
          {
            $set: {
              zoho_attachment_id: att.zohoAttachmentId || null,
              zoho_upload_status: att.zohoUploadStatus || 'pending',
              zoho_error: att.zohoError || null,
              storage_reference: att.storageReference || null,
              storage_url: att.storageUrl || null,
              updated_at: now
            }
          }
        );
      }
    }
    return true;
  }

  async getLeadAttachments(leadId) {
    if (typeof leadId !== 'string') return [];
    const lead = await this.col('leads').findOne({ $or: [{ id: leadId }, { leadId }] });
    if (Array.isArray(lead?.attachments) && lead.attachments.length > 0) {
      return lead.attachments;
    }
    const rows = await this.col('lead_attachments').find({ lead_id: leadId }).sort({ created_at: 1 }).toArray();
    return rows.map(decode);
  }

  async listConversations({ page = 1, pageSize = 20, search = '' } = {}) {
    positiveInteger(page, 'page', 1000000);
    positiveInteger(pageSize, 'pageSize', 1000);
    if (typeof search !== 'string' || search.length > 200 || /[\u0000-\u001f\u007f]/.test(search)) throw new TypeError('Invalid conversation search.');

    let phones = await this.col('whatsapp_messages').distinct('sender_phone');
    if (search.trim()) {
      const q = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matchedMsgs = await this.col('whatsapp_messages').find({
        $or: [
          { sender_phone: { $regex: q, $options: 'i' } },
          { sender_name: { $regex: q, $options: 'i' } },
          { message_text: { $regex: q, $options: 'i' } }
        ]
      }).toArray();
      const matchedReplies = await this.col('reply_outbox').find({
        $or: [
          { sender_phone: { $regex: q, $options: 'i' } },
          { text: { $regex: q, $options: 'i' } }
        ]
      }).toArray();
      const set = new Set([...matchedMsgs.map(m => m.sender_phone), ...matchedReplies.map(r => r.sender_phone)].filter(Boolean));
      phones = phones.filter(p => set.has(p));
    }

    const conversations = [];
    for (const phone of phones) {
      const lastMsg = await this.col('whatsapp_messages').find({ sender_phone: phone }).sort({ created_at: -1 }).limit(1).toArray();
      const lastReply = await this.col('reply_outbox').find({ sender_phone: phone }).sort({ created_at: -1 }).limit(1).toArray();

      let last = lastMsg[0] || null;
      if (lastReply[0] && (!last || new Date(lastReply[0].created_at) > new Date(last.created_at))) {
        last = {
          text: lastReply[0].text,
          message_type: 'text',
          created_at: lastReply[0].sent_at || lastReply[0].created_at
        };
      }

      const senderName = (await this.col('whatsapp_messages').findOne(
        { sender_phone: phone, sender_name: { $ne: null } },
        { sort: { created_at: -1 } }
      ))?.sender_name || null;

      const hasBoss = await this.col('whatsapp_messages').countDocuments({ sender_phone: phone, processing_flow: 'boss_lead' });
      const hasConv = await this.col('whatsapp_messages').countDocuments({ sender_phone: phone, processing_flow: 'conversation' });
      const type = hasBoss ? 'boss_lead' : hasConv ? 'conversation' : 'other';

      const activeSession = await this.col('lead_sessions').findOne(
        { sender_phone: phone },
        { sort: { created_at: -1 } }
      );
      const latestLead = await this.col('leads').findOne(
        { sender_phone: phone },
        { sort: { created_at: -1 } }
      );

      conversations.push({
        id: phone,
        sender_phone: phone,
        sender_name: senderName,
        type,
        status: activeSession?.state || 'active',
        last_message: last?.message_text || last?.text || null,
        last_message_type: last?.message_type || 'text',
        last_message_at: last?.created_at || new Date().toISOString(),
        session_id: activeSession?.id || null,
        lead_id: latestLead?.id || null
      });
    }

    conversations.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
    const total = conversations.length;
    const items = conversations.slice((page - 1) * pageSize, page * pageSize);
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  async getConversation(id) {
    string(id, 'conversation id', 32);
    const list = await this.listConversations({ page: 1, pageSize: 1000, search: id });
    const conversation = list.items.find(c => c.sender_phone === id) || null;
    if (!conversation) return null;

    conversation.leads = (await this.col('leads').find({ sender_phone: id }).sort({ created_at: -1 }).toArray()).map(decode);
    conversation.active_session = decode(await this.col('lead_sessions').findOne({
      sender_phone: id,
      state: { $in: ['collecting', 'awaiting_confirmation'] }
    }));
    conversation.archived_sessions = (await this.col('lead_sessions').find({
      sender_phone: id,
      state: { $in: ['completed', 'discarded'] }
    }).sort({ completed_at: -1, created_at: -1 }).toArray()).map(decode);

    return conversation;
  }

  async listConversationMessages(id, { page = 1, pageSize = 100 } = {}) {
    string(id, 'conversation id', 32);
    positiveInteger(page, 'page', 1000000);
    positiveInteger(pageSize, 'pageSize', 200);

    const incoming = (await this.col('whatsapp_messages').find({ sender_phone: id }).toArray()).map(m => {
      const isBoss = m.processing_flow === 'boss_lead';
      const isCustomer = m.processing_flow === 'conversation';
      return {
        id: 'in:' + m.whatsapp_message_id,
        message_id: m.whatsapp_message_id,
        whatsapp_message_id: m.whatsapp_message_id,
        in_reply_to_message_id: null,
        direction: 'incoming',
        text: m.message_text,
        message_type: m.message_type,
        media_id: m.media_id,
        media_mime_type: m.media_mime_type,
        media_filename: m.media_filename,
        storage_url: m.storage_url || (m.storage_reference ? `/api/media/${m.storage_reference}` : null),
        transcription: m.transcription,
        extracted_text: m.extracted_text,
        sender_name: m.sender_name,
        sender_type: isBoss ? 'boss' : isCustomer ? 'customer' : 'participant',
        created_at: m.created_at,
        received_at: m.received_at,
        status: m.processing_status,
        lead_id: m.lead_id || null,
        session_id: m.session_id || null,
        receipt_sequence: 0,
        direction_order: 0
      };
    });

    const msgIds = incoming.map(m => m.message_id);
    const msgMap = new Map(incoming.map(m => [m.message_id, m]));

    const outbox = (await this.col('reply_outbox').find({ $or: [{ sender_phone: id }, { message_id: { $in: msgIds } }] }).toArray()).map(r => {
      const inc = msgMap.get(r.message_id);
      return {
        id: 'out:' + r.id,
        message_id: r.message_id,
        whatsapp_message_id: r.provider_message_id || null,
        in_reply_to_message_id: r.message_id,
        direction: 'outgoing',
        text: r.text,
        message_type: 'text',
        media_id: null,
        media_mime_type: null,
        media_filename: null,
        transcription: null,
        extracted_text: null,
        sender_name: null,
        sender_type: 'bot',
        created_at: r.sent_at || r.created_at,
        received_at: null,
        status: r.status,
        lead_id: r.lead_id || inc?.lead_id || null,
        session_id: r.session_id || inc?.session_id || null,
        receipt_sequence: 0,
        direction_order: 1
      };
    });

    const historyReplies = (await this.col('reply_history').find({ message_id: { $in: msgIds } }).toArray()).map(r => {
      const inc = msgMap.get(r.message_id);
      return {
        id: 'out:' + r.id,
        message_id: r.message_id,
        whatsapp_message_id: r.provider_message_id || r.message_id,
        in_reply_to_message_id: r.message_id,
        direction: 'outgoing',
        text: r.text,
        message_type: 'text',
        media_id: null,
        media_mime_type: null,
        media_filename: null,
        transcription: null,
        extracted_text: null,
        sender_name: null,
        sender_type: 'bot',
        created_at: r.sent_at || r.created_at,
        received_at: null,
        status: r.status,
        lead_id: r.lead_id || inc?.lead_id || null,
        session_id: r.session_id || inc?.session_id || null,
        receipt_sequence: 0,
        direction_order: 1
      };
    });

    const all = [...incoming, ...outbox, ...historyReplies];
    all.sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.direction_order - b.direction_order);

    const total = all.length;
    const items = all.slice((page - 1) * pageSize, page * pageSize);
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  async listLeads({ page = 1, pageSize = 20, search = '', validationStatus, extractionStatus, zohoStatus } = {}) {
    positiveInteger(page, 'page', 1000000);
    positiveInteger(pageSize, 'pageSize', 100);
    if (typeof search !== 'string' || search.length > 200 || /[\u0000-\u001f\u007f]/.test(search)) throw new TypeError('Invalid lead search.');

    const filter = {};
    if (validationStatus !== undefined) {
      if (!LEAD_STATUSES.validationStatus.includes(validationStatus)) throw new TypeError('Invalid validationStatus.');
      filter.validation_status = validationStatus;
    }
    if (extractionStatus !== undefined) {
      if (!LEAD_STATUSES.extractionStatus.includes(extractionStatus)) throw new TypeError('Invalid extractionStatus.');
      filter.extraction_status = extractionStatus;
    }
    if (zohoStatus !== undefined) {
      if (!LEAD_STATUSES.zohoStatus.includes(zohoStatus)) throw new TypeError('Invalid zohoStatus.');
      filter.zoho_status = zohoStatus;
    }

    if (search.trim()) {
      const q = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { sender_phone: { $regex: q, $options: 'i' } },
        { company_name: { $regex: q, $options: 'i' } },
        { contact_name: { $regex: q, $options: 'i' } },
        { phone: { $regex: q, $options: 'i' } },
        { email: { $regex: q, $options: 'i' } },
        { requirement: { $regex: q, $options: 'i' } },
        { project_name: { $regex: q, $options: 'i' } },
        { original_message: { $regex: q, $options: 'i' } }
      ];
    }

    const total = await this.col('leads').countDocuments(filter);
    const docs = await this.col('leads').find(filter)
      .sort({ created_at: -1, id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();

    return { items: docs.map(decode), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  async getLeadStats() {
    const total = await this.col('leads').countDocuments({});
    const valid = await this.col('leads').countDocuments({ validation_status: 'valid' });
    const incomplete = await this.col('leads').countDocuments({ validation_status: 'incomplete' });
    const extraction_failed = await this.col('leads').countDocuments({ extraction_status: 'failed' });
    const zoho_pending = await this.col('leads').countDocuments({ zoho_status: 'pending' });
    const zoho_saved = await this.col('leads').countDocuments({ zoho_status: 'saved', zoho_lead_id: { $ne: null, $nin: ['', null] } });

    return { total, valid, incomplete, extraction_failed, zoho_pending, zoho_saved };
  }

  async claimNext({ leaseMs = 120000, maxAttempts = 3, processingFlow = null, messageIds = null } = {}) {
    positiveInteger(leaseMs, 'leaseMs', 3600000);
    positiveInteger(maxAttempts, 'maxAttempts', 100);
    validateProcessingFlow(processingFlow);
    if (processingFlow === 'boss_lead') throw new TypeError('Boss lead work requires claimLeadExtraction.');
    validateMessageIds(messageIds);
    if (Array.isArray(messageIds) && messageIds.length === 0) return null;

    const scoped = processingFlow === 'conversation';
    const now = await this._now();
    const oldestReceived = addMilliseconds(now, -REPLY_WINDOW_MS);

    if (scoped) {
      const expireFilter = {
        received_at: { $lte: oldestReceived },
        processing_flow: 'conversation',
        authenticated: true,
        message_type: 'text',
        $or: [
          { processing_status: 'RECEIVED' },
          { processing_status: 'FAILED', next_attempt_at: { $ne: null } },
          { processing_status: 'PROCESSING', lease_expires_at: { $lte: now } }
        ]
      };
      if (messageIds) expireFilter.whatsapp_message_id = { $in: messageIds };
      await this.col('whatsapp_messages').updateMany(expireFilter, {
        $set: {
          processing_status: 'FAILED',
          error_message: 'CUSTOMER_SERVICE_WINDOW_EXPIRED',
          processed_at: now,
          next_attempt_at: null,
          lease_token: null,
          lease_expires_at: null
        }
      });
    }

    const exhaustedFilter = {
      processing_status: 'PROCESSING',
      lease_expires_at: { $lte: now },
      attempts: { $gte: maxAttempts }
    };
    if (scoped) {
      exhaustedFilter.processing_flow = 'conversation';
      exhaustedFilter.authenticated = true;
      exhaustedFilter.message_type = 'text';
    } else {
      exhaustedFilter.$or = [{ processing_flow: null }, { processing_flow: { $ne: 'boss_lead' } }];
      exhaustedFilter.zoho_lead_id = null;
    }
    if (messageIds) exhaustedFilter.whatsapp_message_id = { $in: messageIds };

    await this.col('whatsapp_messages').updateMany(exhaustedFilter, {
      $set: {
        processing_status: 'FAILED',
        error_message: 'PROCESSING_ATTEMPTS_EXHAUSTED',
        processed_at: now,
        next_attempt_at: null,
        lease_token: null,
        lease_expires_at: null
      }
    });

    const statusOr = [
      { processing_status: 'RECEIVED' },
      { processing_status: 'FAILED', next_attempt_at: { $lte: now } },
      { processing_status: 'PROCESSING', lease_expires_at: { $lte: now } }
    ];

    let candidateFilter;
    if (scoped) {
      candidateFilter = {
        $or: statusOr,
        processing_flow: 'conversation',
        authenticated: true,
        message_type: 'text',
        received_at: { $gt: oldestReceived },
        attempts: { $lt: maxAttempts }
      };
    } else {
      candidateFilter = {
        $and: [
          { $or: statusOr },
          {
            $or: [
              { processing_flow: null },
              { processing_flow: { $ne: 'boss_lead' } }
            ]
          },
          {
            $or: [
              { attempts: { $lt: maxAttempts } },
              { zoho_lead_id: { $ne: null } }
            ]
          }
        ]
      };
    }
    if (messageIds) candidateFilter.whatsapp_message_id = { $in: messageIds };

    const candidates = await this.col('whatsapp_messages').find(candidateFilter)
      .sort({ created_at: 1, whatsapp_message_id: 1 })
      .limit(10)
      .toArray();

    for (const candidate of candidates) {
      const leaseToken = randomUUID();
      const leaseExpiresAt = addMilliseconds(now, leaseMs);
      const claimed = await this.col('whatsapp_messages').findOneAndUpdate(
        {
          whatsapp_message_id: candidate.whatsapp_message_id,
          attempts: candidate.attempts,
          processing_status: candidate.processing_status
        },
        {
          $set: {
            processing_status: 'PROCESSING',
            lease_token: leaseToken,
            lease_expires_at: leaseExpiresAt,
            next_attempt_at: null
          },
          $inc: { attempts: 1 }
        },
        { returnDocument: 'after' }
      );

      const job = claimed?.value || claimed;
      if (job) return decode(job);
    }

    return null;
  }

  async mark(id, leaseToken, patch) {
    const update = this._patch(patch);
    const now = await this._now();
    const res = await this.col('whatsapp_messages').updateOne(
      {
        whatsapp_message_id: id,
        lease_token: leaseToken,
        processing_status: 'PROCESSING',
        lease_expires_at: { $gt: now }
      },
      { $set: update }
    );
    return res.matchedCount === 1;
  }

  async heartbeat(id, leaseToken, leaseMs = 120000) {
    positiveInteger(leaseMs, 'leaseMs', 3600000);
    const now = await this._now();
    const res = await this.col('whatsapp_messages').updateOne(
      {
        whatsapp_message_id: id,
        lease_token: leaseToken,
        processing_status: 'PROCESSING',
        lease_expires_at: { $gt: now }
      },
      {
        $set: { lease_expires_at: addMilliseconds(now, leaseMs) }
      }
    );
    return res.matchedCount === 1;
  }

  async appendLog(id, event, details = {}) {
    string(event, 'event', 80);
    const safe = {};
    for (const key of ['attempt', 'action', 'status', 'retryable', 'retry_scheduled', 'reconciliation', 'code', 'duration_ms', 'provider', 'stage']) {
      if (typeof details[key] === 'number' || typeof details[key] === 'boolean') safe[key] = details[key];
      else if (typeof details[key] === 'string') safe[key] = details[key].slice(0, 80);
    }
    const now = await this._now();
    await this.col('processing_logs').insertOne({
      id: randomUUID(),
      message_id: id,
      event,
      details: safe,
      created_at: now
    });
  }

  async getContactState(contactKey) {
    string(contactKey, 'contactKey', 512);
    const doc = await this.col('crm_contacts').findOne({ contact_key: contactKey });
    return decode(doc);
  }

  async getContactLead(contactKey) {
    return (await this.getContactState(contactKey))?.zoho_lead_id || null;
  }

  async beginContactWrite(contactKey) {
    string(contactKey, 'contactKey', 512);
    const now = await this._now();
    await this.col('crm_contacts').updateOne(
      { contact_key: contactKey },
      { $set: { uncertain: true, updated_at: now } },
      { upsert: true }
    );
  }

  async saveContactLead(contactKey, zohoId) {
    string(contactKey, 'contactKey', 512);
    string(zohoId, 'zohoId', 128);
    const now = await this._now();
    await this.col('crm_contacts').updateOne(
      { contact_key: contactKey },
      { $set: { zoho_lead_id: zohoId, uncertain: false, updated_at: now } },
      { upsert: true }
    );
  }

  async saveCrmResult(id, leaseToken, { zohoId, action, contactKey, contactKeys = [] }) {
    string(zohoId, 'zohoId', 128);
    string(action, 'action', 128);
    if (!Array.isArray(contactKeys)) throw new TypeError('Invalid contactKeys.');
    const keys = [...new Set([contactKey, ...contactKeys].filter(Boolean))];
    if (!keys.length || keys.length > 4) throw new TypeError('Between one and four contact keys are required.');
    keys.forEach(key => string(key, 'contactKey', 512));
    const now = await this._now();

    const updated = await this.col('whatsapp_messages').updateOne(
      {
        whatsapp_message_id: id,
        lease_token: leaseToken,
        processing_status: 'PROCESSING',
        lease_expires_at: { $gt: now }
      },
      {
        $set: {
          zoho_lead_id: zohoId,
          crm_action: action,
          crm_write_started: false
        }
      }
    );
    if (updated.matchedCount !== 1) return false;

    for (const key of keys) {
      await this.col('crm_contacts').updateOne(
        { contact_key: key },
        { $set: { zoho_lead_id: zohoId, uncertain: false, updated_at: now } },
        { upsert: true }
      );
    }
    return true;
  }

  async queueReply(messageId, text) {
    string(text, 'reply text', 4096);
    const now = await this._now();
    const msg = await this.col('whatsapp_messages').findOne({
      whatsapp_message_id: messageId,
      processing_status: { $in: ['SUCCESS', 'NEEDS_INFORMATION', 'FAILED'] }
    });
    if (!msg) return false;

    try {
      await this.col('reply_outbox').insertOne({
        id: randomUUID(),
        message_id: messageId,
        sender_phone: msg.sender_phone,
        text,
        status: 'PENDING',
        created_at: now,
        sent_at: null,
        provider_message_id: null,
        error_message: null,
        lease_token: null,
        lease_expires_at: null
      });
      return true;
    } catch (err) {
      if (err.code === 11000) return false;
      throw err;
    }
  }

  async completeWithReply(id, leaseToken, patch, text) {
    if (!['SUCCESS', 'NEEDS_INFORMATION', 'FAILED'].includes(patch?.processing_status)) throw new TypeError('Completion requires a terminal status.');
    if (patch.next_attempt_at) throw new TypeError('A retry cannot be completed with a reply.');
    string(text, 'reply text', 4096);
    const update = this._patch(patch);
    const now = await this._now();

    const result = await this.col('whatsapp_messages').updateOne(
      {
        whatsapp_message_id: id,
        lease_token: leaseToken,
        processing_status: 'PROCESSING',
        lease_expires_at: { $gt: now }
      },
      { $set: update }
    );
    if (result.matchedCount !== 1) return false;

    const msg = await this.col('whatsapp_messages').findOne({ whatsapp_message_id: id });
    try {
      await this.col('reply_outbox').insertOne({
        id: randomUUID(),
        message_id: id,
        sender_phone: msg?.sender_phone || null,
        text,
        status: 'PENDING',
        created_at: now,
        sent_at: null,
        provider_message_id: null,
        error_message: null,
        lease_token: null,
        lease_expires_at: null
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
    return true;
  }

  async claimReply({ leaseMs = 120000, replyText = null, processingFlow = null, messageIds = null } = {}) {
    positiveInteger(leaseMs, 'leaseMs', 3600000);
    validateReplyText(replyText);
    validateProcessingFlow(processingFlow);
    validateMessageIds(messageIds);
    if (Array.isArray(messageIds) && messageIds.length === 0) return null;

    const now = await this._now();

    const sweepFilter = { status: 'SENDING', lease_expires_at: { $lte: now } };
    if (messageIds) sweepFilter.message_id = { $in: messageIds };
    await this.col('reply_outbox').updateMany(
      sweepFilter,
      { $set: { status: 'UNKNOWN', error_message: 'SEND_LEASE_EXPIRED', lease_expires_at: null } }
    );

    const oldestReceived = addMilliseconds(now, -REPLY_WINDOW_MS);
    const expiredQuery = { received_at: { $lte: oldestReceived } };
    if (messageIds) expiredQuery.whatsapp_message_id = { $in: messageIds };
    const expiredMsgs = await this.col('whatsapp_messages').find(expiredQuery).toArray();
    if (expiredMsgs.length) {
      await this.col('reply_outbox').updateMany(
        { status: 'PENDING', message_id: { $in: expiredMsgs.map(m => m.whatsapp_message_id) } },
        { $set: { status: 'FAILED', error_message: 'CUSTOMER_SERVICE_WINDOW_EXPIRED' } }
      );
    }

    const pendingFilter = { status: 'PENDING' };
    if (replyText !== null) pendingFilter.text = replyText;
    if (messageIds) pendingFilter.message_id = { $in: messageIds };

    const candidates = await this.col('reply_outbox').find(pendingFilter)
      .sort({ created_at: 1, id: 1 })
      .limit(20)
      .toArray();

    for (const candidate of candidates) {
      const msg = await this.col('whatsapp_messages').findOne({ whatsapp_message_id: candidate.message_id });
      if (!msg) continue;
      if (new Date(msg.received_at) <= new Date(oldestReceived)) continue;
      if (processingFlow !== null && msg.processing_flow !== processingFlow) continue;

      if (msg.processing_flow === 'boss_lead') {
        const myReceipt = await this.col('message_receipts').findOne({ message_id: candidate.message_id });
        if (myReceipt) {
          const earlierReceiptsQuery = { sequence: { $lt: myReceipt.sequence } };
          if (messageIds) earlierReceiptsQuery.message_id = { $in: messageIds.filter(id => id !== candidate.message_id) };
          const earlierReceipts = await this.col('message_receipts').find(earlierReceiptsQuery).toArray();
          if (earlierReceipts.length) {
            const earlierIds = earlierReceipts.map(r => r.message_id);
            const earlierSending = await this.col('reply_outbox').countDocuments({
              message_id: { $in: earlierIds },
              status: { $in: ['PENDING', 'SENDING'] }
            });
            if (earlierSending > 0) continue;
          }
        }
      }

      const leaseToken = randomUUID();
      const leaseExpiresAt = addMilliseconds(now, leaseMs);
      const claimed = await this.col('reply_outbox').findOneAndUpdate(
        { id: candidate.id, status: 'PENDING' },
        {
          $set: {
            status: 'SENDING',
            lease_token: leaseToken,
            lease_expires_at: leaseExpiresAt
          }
        },
        { returnDocument: 'after' }
      );

      const reply = claimed?.value || claimed;
      if (reply) {
        return decode({
          ...reply,
          sender_phone: msg.sender_phone,
          authenticated: msg.authenticated,
          message_type: msg.message_type,
          processing_flow: msg.processing_flow,
          received_at: msg.received_at
        });
      }
    }

    return null;
  }

  async finishReply(id, leaseToken, { status, error_message = null, provider_message_id = null }) {
    if (!['SENT', 'FAILED', 'UNKNOWN'].includes(status)) throw new TypeError('Invalid reply status.');
    string(error_message, 'error_message', 1000, true);
    string(provider_message_id, 'provider_message_id', 512, true);
    const now = await this._now();

    const res = await this.col('reply_outbox').updateOne(
      {
        id,
        lease_token: leaseToken,
        status: 'SENDING',
        lease_expires_at: { $gt: now }
      },
      {
        $set: {
          status,
          error_message,
          provider_message_id,
          sent_at: status === 'SENT' ? now : null,
          lease_token: null,
          lease_expires_at: null
        }
      }
    );
    return res.matchedCount === 1;
  }

  async getReply(messageId) {
    const doc = await this.col('reply_outbox').findOne({ message_id: messageId });
    return decode(doc);
  }

  async recordReplyReconciliation(id, leaseToken, providerMessageId) {
    string(id, 'reply id', 128);
    string(leaseToken, 'reply lease token', 128);
    string(providerMessageId, 'provider_message_id', 512);

    const row = await this.col('reply_outbox').findOne({ id });
    if (row?.status === 'SENT' && row.provider_message_id === providerMessageId) return 'SENT';
    if (!row || row.lease_token !== leaseToken || !['SENDING', 'UNKNOWN'].includes(row.status)
        || (row.provider_message_id !== null && row.provider_message_id !== providerMessageId)) return null;

    await this.col('reply_outbox').updateOne(
      { id, lease_token: leaseToken, status: { $in: ['SENDING', 'UNKNOWN'] } },
      {
        $set: {
          status: 'UNKNOWN',
          provider_message_id: providerMessageId,
          error_message: 'PROVIDER_ACCEPTED_RECONCILIATION_REQUIRED',
          lease_expires_at: null
        }
      }
    );
    return 'UNKNOWN';
  }

  async withContactLock(contactKey, fn, { timeoutMs = 30000, leaseMs = 120000 } = {}) {
    string(contactKey, 'contactKey', 512);
    positiveInteger(timeoutMs, 'timeoutMs', 300000);
    positiveInteger(leaseMs, 'leaseMs', 3600000);
    if (typeof fn !== 'function') throw new TypeError('Contact lock requires a callback.');

    const token = randomUUID();
    const deadline = Date.now() + timeoutMs;
    let acquired = false;
    let lost = false;

    while (Date.now() < deadline) {
      const now = await this._now();
      const leaseExpiresAt = addMilliseconds(now, leaseMs);

      try {
        const updateRes = await this.col('contact_locks').updateOne(
          {
            contact_key: contactKey,
            lease_expires_at: { $lte: now }
          },
          {
            $set: {
              lease_token: token,
              lease_expires_at: leaseExpiresAt
            }
          }
        );

        if (updateRes.matchedCount === 1) {
          acquired = true;
          break;
        }

        await this.col('contact_locks').insertOne({
          contact_key: contactKey,
          lease_token: token,
          lease_expires_at: leaseExpiresAt,
          created_at: now
        });
        acquired = true;
        break;
      } catch (err) {
        if (err.code === 11000) {
          acquired = false;
        } else {
          throw err;
        }
      }

      await delay(40 + Math.floor(Math.random() * 40));
    }

    if (!acquired) throw lockError('CONTACT_LOCK_TIMEOUT');

    const assertOwned = async () => {
      if (lost) throw lockError('CONTACT_LOCK_LOST');
      const now = await this._now();
      const present = await this.col('contact_locks').findOne({
        contact_key: contactKey,
        lease_token: token,
        lease_expires_at: { $gt: now }
      });
      if (!present) {
        lost = true;
        throw lockError('CONTACT_LOCK_LOST');
      }
    };

    const timer = setInterval(async () => {
      try {
        const now = await this._now();
        const res = await this.col('contact_locks').updateOne(
          {
            contact_key: contactKey,
            lease_token: token,
            lease_expires_at: { $gt: now }
          },
          {
            $set: { lease_expires_at: addMilliseconds(now, leaseMs) }
          }
        );
        if (res.matchedCount !== 1) lost = true;
      } catch {
        lost = true;
      }
    }, Math.max(5, Math.floor(leaseMs / 3)));
    timer.unref();

    try {
      const result = await fn({ assertOwned });
      await assertOwned();
      return result;
    } finally {
      clearInterval(timer);
      await this.col('contact_locks').deleteOne({ contact_key: contactKey, lease_token: token }).catch(() => {});
    }
  }
}

function createMongoMessageStore(options) {
  return new MongoMessageStore(options);
}

module.exports = { MongoMessageStore, createMongoMessageStore };
