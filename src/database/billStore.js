'use strict';

const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const {
  ACTIVE_SESSION_STATES,
  SESSION_STATES,
  BILL_STATUSES,
  ZOHO_STATUSES,
} = require('../models/billModel');

function cleanDoc(doc) {
  if (!doc) return null;
  const copy = { ...doc };
  delete copy._id;
  delete copy.__v;
  return copy;
}

class BillStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BillStoreError';
    this.code = code;
  }
}

class BillStore {
  constructor({ db = null, store = null, collectionPrefix = '', logger = null } = {}) {
    this.store = store;
    this.explicitDb = db;
    this.collectionPrefix = collectionPrefix;
    this.logger = logger;
    this.initialized = false;
  }

  get db() {
    if (this.explicitDb) return this.explicitDb;
    if (this.store?.db) return this.store.db;
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      return mongoose.connection.db;
    }
    return null;
  }

  col(name) {
    if (this.store && typeof this.store.col === 'function') {
      return this.store.col(name);
    }
    const currentDb = this.db;
    if (!currentDb) {
      throw new BillStoreError('DATABASE_NOT_INITIALIZED', 'Database not connected. Initialize connection first.');
    }
    return currentDb.collection(this.collectionPrefix + name);
  }

  async init() {
    if (this.initialized) return this;
    await this.ensureIndexes();
    this.initialized = true;
    return this;
  }

  async ensureIndexes() {
    const db = this.db;
    if (!db) return;

    // 1. bill_extractions indexes
    try {
      await this.col('bill_extractions').createIndex({ job_id: 1 }, { unique: true });
      await this.col('bill_extractions').createIndex({ message_id: 1 }, { unique: true });
      await this.col('bill_extractions').createIndex({ status: 1, attempts: 1, lease_until: 1, created_at: 1 });
      await this.col('bill_extractions').createIndex({ worker_phone: 1 });
    } catch (err) {
      this.logger?.warn?.({ event: 'bill_extractions_index_warning', error: err.message });
      throw new BillStoreError('BILL_INDEX_FAILED', 'Bill extraction uniqueness could not be established.');
    }

    // 2. bill_sessions indexes (including partial unique index for active session per worker)
    try {
      const sessions = this.col('bill_sessions');
      await sessions.createIndex({ session_id: 1 }, { unique: true });
      await sessions.createIndex({ worker_phone: 1, state: 1 });
      const activeIndexName = 'unique_active_session_per_worker';
      const desiredStates = [...ACTIVE_SESSION_STATES].sort();
      const existingActiveIndex = (await sessions.listIndexes().toArray())
        .find(index => index.name === activeIndexName);
      if (existingActiveIndex) {
        const existingStates = [...(existingActiveIndex.partialFilterExpression?.state?.$in || [])].sort();
        const sameDefinition = JSON.stringify(existingActiveIndex.key) === JSON.stringify({ worker_phone: 1 })
          && existingActiveIndex.unique === true
          && JSON.stringify(existingStates) === JSON.stringify(desiredStates);
        if (!sameDefinition) {
          if (JSON.stringify(existingActiveIndex.key) !== JSON.stringify({ worker_phone: 1 }) || existingActiveIndex.unique !== true) {
            throw new BillStoreError('BILL_INDEX_FAILED', 'Active bill session uniqueness index has an incompatible definition.');
          }
          await sessions.dropIndex(activeIndexName);
        }
      }
      await sessions.createIndex(
        { worker_phone: 1 },
        {
          unique: true,
          partialFilterExpression: { state: { $in: desiredStates } },
          name: activeIndexName,
        }
      );
    } catch (err) {
      this.logger?.warn?.({ event: 'bill_sessions_index_warning', error: err.message });
      throw new BillStoreError('BILL_INDEX_FAILED', 'Active bill session uniqueness could not be established.');
    }

    // 3. bills indexes
    try {
      await this.col('bills').createIndex({ bill_id: 1 }, { unique: true });
      await this.col('bills').createIndex({ session_id: 1 });
      await this.col('bills').createIndex({ worker_phone: 1, created_at: -1 });
      await this.col('bills').createIndex({ bill_number: 1, vendor_name: 1 });
      await this.col('bills').createIndex({ status: 1 });
      await this.col('bills').createIndex({ zoho_status: 1 });
    } catch (err) {
      this.logger?.warn?.({ event: 'bills_index_warning', error: err.message });
      throw new BillStoreError('BILL_INDEX_FAILED', 'Bill uniqueness could not be established.');
    }
  }

  // ==========================================
  // BILL EXTRACTION JOBS PERSISTENCE
  // ==========================================

  async enqueueBillExtraction({ messageId, workerPhone, maxAttempts = 3, payload = {} } = {}) {
    if (!messageId || typeof messageId !== 'string') {
      throw new BillStoreError('INVALID_INPUT', 'messageId is required.');
    }
    if (!workerPhone || typeof workerPhone !== 'string') {
      throw new BillStoreError('INVALID_INPUT', 'workerPhone is required.');
    }

    const existing = await this.col('bill_extractions').findOne({ message_id: messageId });
    if (existing) {
      return cleanDoc(existing);
    }

    const now = new Date();
    const doc = {
      job_id: randomUUID(),
      message_id: messageId,
      worker_phone: workerPhone,
      status: 'PENDING',
      attempts: 0,
      max_attempts: Number(maxAttempts) || 3,
      lease_token: null,
      lease_until: null,
      last_error: null,
      reply_status: null,
      reply_provider_message_id: null,
      payload: payload || {},
      result: null,
      created_at: now,
      updated_at: now,
    };

    try {
      await this.col('bill_extractions').insertOne(doc);
      return cleanDoc(doc);
    } catch (err) {
      if (err.code === 11000 || String(err.message).includes('E11000')) {
        const raceExisting = await this.col('bill_extractions').findOne({ message_id: messageId });
        return cleanDoc(raceExisting);
      }
      throw err;
    }
  }

  async claimBillExtraction({ leaseMs = 120000, maxAttempts = null, workerPhone = null,
    batchQuietMs = 0, batchBoundary = null } = {}) {
    if (!Number.isInteger(batchQuietMs) || batchQuietMs < 0 || batchQuietMs > 60000) {
      throw new BillStoreError('INVALID_INPUT', 'batchQuietMs is invalid.');
    }
    if (batchBoundary !== null && typeof batchBoundary !== 'function') {
      throw new BillStoreError('INVALID_INPUT', 'batchBoundary is invalid.');
    }
    const now = new Date();

    const candidateFilter = {
      reply_status: null,
      $expr: { $lt: ['$attempts', '$max_attempts'] },
      $or: [
        { status: 'PENDING' },
        { status: 'PROCESSING', lease_until: { $lte: now } },
        { status: 'FAILED' },
      ],
    };

    if (typeof maxAttempts === 'number') {
      candidateFilter.attempts = { $lt: maxAttempts };
    }

    if (workerPhone) {
      candidateFilter.worker_phone = workerPhone;
    }

    const candidates = await this.col('bill_extractions')
      .find(candidateFilter)
      .sort({ created_at: 1 })
      .limit(10)
      .toArray();

    const deferredWorkers = new Set();
    for (const candidate of candidates) {
      if (deferredWorkers.has(candidate.worker_phone)) continue;
      let batchCandidates = [candidate];
      if (batchQuietMs > 0) {
        const sameWorker = candidates.filter(item => item.worker_phone === candidate.worker_phone);
        const start = sameWorker.findIndex(item => item.job_id === candidate.job_id);
        let closedByBoundary = false;
        if (!batchBoundary?.(candidate.payload || {})) {
          batchCandidates = [];
          for (const item of sameWorker.slice(start)) {
            const previous = batchCandidates.at(-1);
            if (previous && new Date(item.created_at).getTime() - new Date(previous.created_at).getTime() >= batchQuietMs) {
              closedByBoundary = true;
              break;
            }
            if (batchCandidates.length && batchBoundary?.(item.payload || {})) {
              closedByBoundary = true;
              break;
            }
            batchCandidates.push(item);
          }
          const newestCreated = Math.max(...batchCandidates.map(item => new Date(item.created_at).getTime()));
          if (!closedByBoundary && now.getTime() - newestCreated < batchQuietMs) {
            deferredWorkers.add(candidate.worker_phone);
            continue;
          }
        }

        const active = await this.col('bill_extractions').countDocuments({
          worker_phone: candidate.worker_phone,
          status: 'PROCESSING',
          lease_until: { $gt: now },
        });
        if (active) {
          deferredWorkers.add(candidate.worker_phone);
          continue;
        }
      }
      const leaseToken = randomUUID();
      const leaseUntil = new Date(Date.now() + leaseMs);

      const claimed = await this.col('bill_extractions').findOneAndUpdate(
        {
          job_id: candidate.job_id,
          status: candidate.status,
          attempts: candidate.attempts,
          $expr: { $lt: ['$attempts', '$max_attempts'] },
        },
        {
          $set: {
            status: 'PROCESSING',
            lease_token: leaseToken,
            lease_until: leaseUntil,
            updated_at: now,
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after' }
      );

      const job = claimed?.value || claimed;
      if (job) {
        const batchItems = [cleanDoc(job)];
        for (const sibling of batchCandidates.slice(1)) {
          const siblingToken = randomUUID();
          const siblingClaim = await this.col('bill_extractions').findOneAndUpdate(
            {
              job_id: sibling.job_id,
              status: sibling.status,
              attempts: sibling.attempts,
              $expr: { $lt: ['$attempts', '$max_attempts'] },
            },
            {
              $set: {
                status: 'PROCESSING', lease_token: siblingToken,
                lease_until: leaseUntil, updated_at: now,
              },
              $inc: { attempts: 1 },
            },
            { returnDocument: 'after' }
          );
          const siblingJob = siblingClaim?.value || siblingClaim;
          if (siblingJob) batchItems.push(cleanDoc(siblingJob));
        }
        return cleanDoc({ ...job, ...(batchQuietMs > 0 ? { batch_items: batchItems } : {}) });
      }
      if (batchQuietMs > 0) deferredWorkers.add(candidate.worker_phone);
    }

    return null;
  }

  async beginBillExtractionProcessing(jobId, leaseToken, leaseMs = 120000) {
    if (!jobId || !leaseToken) return null;
    const now = new Date();
    const executionToken = randomUUID();
    const newLeaseUntil = new Date(Date.now() + leaseMs);

    const res = await this.col('bill_extractions').updateOne(
      {
        job_id: jobId,
        lease_token: leaseToken,
        status: 'PROCESSING',
        lease_until: { $gt: now },
      },
      {
        $set: {
          lease_token: executionToken,
          lease_until: newLeaseUntil,
          updated_at: now,
        },
      }
    );

    return res.matchedCount === 1 ? executionToken : null;
  }

  async heartbeatBillExtraction(jobId, leaseToken, leaseMs = 120000) {
    if (!jobId || !leaseToken) return false;
    const now = new Date();
    const newLeaseUntil = new Date(Date.now() + leaseMs);

    const res = await this.col('bill_extractions').updateOne(
      {
        job_id: jobId,
        lease_token: leaseToken,
        status: 'PROCESSING',
        lease_until: { $gt: now },
      },
      {
        $set: {
          lease_until: newLeaseUntil,
          updated_at: now,
        },
      }
    );

    return res.matchedCount === 1;
  }

  async reserveBillReply(jobId, leaseToken) {
    if (!jobId || !leaseToken) return false;
    const now = new Date();
    const res = await this.col('bill_extractions').updateOne({
      job_id: jobId, lease_token: leaseToken, status: 'PROCESSING',
      lease_until: { $gt: now }, reply_status: null,
    }, { $set: { reply_status: 'SENDING', updated_at: now } });
    return res.matchedCount === 1;
  }

  async finishBillReply(jobId, leaseToken, { status, providerMessageId = null } = {}) {
    if (!jobId || !leaseToken || !['ACCEPTED', 'FAILED', 'UNKNOWN'].includes(status)) return false;
    const res = await this.col('bill_extractions').updateOne({
      job_id: jobId, lease_token: leaseToken, reply_status: 'SENDING',
    }, { $set: {
      reply_status: status,
      reply_provider_message_id: typeof providerMessageId === 'string' ? providerMessageId : null,
      updated_at: new Date(),
    } });
    return res.matchedCount === 1;
  }

  async completeBillExtraction(jobId, leaseToken, result = null) {
    if (!jobId) return false;
    const now = new Date();

    const query = { job_id: jobId };
    if (leaseToken) {
      query.lease_token = leaseToken;
    }

    const res = await this.col('bill_extractions').updateOne(query, {
      $set: {
        status: 'COMPLETED',
        result: result || null,
        lease_token: null,
        lease_until: null,
        updated_at: now,
      },
    });

    return res.matchedCount === 1;
  }

  async failBillExtraction(jobId, leaseToken, { error = null } = {}) {
    if (!jobId) return false;
    const now = new Date();
    const errorMessage = typeof error === 'string' ? error : error?.message || 'EXTRACTION_FAILED';

    const query = { job_id: jobId };
    if (leaseToken) {
      query.lease_token = leaseToken;
    }

    const res = await this.col('bill_extractions').updateOne(query, {
      $set: {
        status: 'FAILED',
        last_error: errorMessage,
        lease_token: null,
        lease_until: null,
        updated_at: now,
      },
    });

    return res.matchedCount === 1;
  }

  async getBillExtraction(jobId) {
    if (!jobId) return null;
    const doc = await this.col('bill_extractions').findOne({ job_id: jobId });
    return cleanDoc(doc);
  }

  async getBillExtractionByMessageId(messageId) {
    if (!messageId) return null;
    const doc = await this.col('bill_extractions').findOne({ message_id: messageId });
    return cleanDoc(doc);
  }

  // ==========================================
  // BILL SESSION STORE METHODS
  // ==========================================

  async getActiveBillSession(workerPhone) {
    if (!workerPhone || typeof workerPhone !== 'string') return null;

    const session = await this.col('bill_sessions').findOne({
      worker_phone: workerPhone,
      state: { $in: [...ACTIVE_SESSION_STATES] },
    });

    if (!session) return null;

    // Check expiration if expires_at is set
    if (session.state !== 'CREATING_IN_ZOHO' && session.expires_at && new Date(session.expires_at) <= new Date()) {
      await this.col('bill_sessions').updateOne(
        { session_id: session.session_id },
        {
          $set: {
            state: 'FAILED',
            last_error: 'SESSION_EXPIRED',
            updated_at: new Date(),
          },
        }
      );
      return null;
    }

    return cleanDoc(session);
  }

  async createBillSession(sessionData = {}) {
    const workerPhone = sessionData.worker_phone;
    if (!workerPhone || typeof workerPhone !== 'string') {
      throw new BillStoreError('INVALID_INPUT', 'worker_phone is required.');
    }

    // Active session protection: prevent two concurrent active sessions for the same worker
    const active = await this.getActiveBillSession(workerPhone);
    if (active) {
      throw new BillStoreError('ACTIVE_SESSION_EXISTS', `Worker ${workerPhone} already has an active bill session (${active.session_id}).`);
    }

    const now = new Date();
    const sessionId = sessionData.session_id || randomUUID();
    const billId = sessionData.bill_id || randomUUID();
    const state = sessionData.state || 'EXTRACTING';

    if (!SESSION_STATES.includes(state)) {
      throw new BillStoreError('INVALID_STATE', `State '${state}' is not a valid session state.`);
    }

    const doc = {
      session_id: sessionId,
      worker_phone: workerPhone,
      bill_id: billId,
      state,
      last_message_id: sessionData.last_message_id || null,
      expires_at: sessionData.expires_at ? new Date(sessionData.expires_at) : new Date(Date.now() + 24 * 60 * 60 * 1000),
      bill_data: sessionData.bill_data || {},
      customer_options: Array.isArray(sessionData.customer_options) ? sessionData.customer_options : [],
      attachments: Array.isArray(sessionData.attachments) ? sessionData.attachments : [],
      created_at: now,
      updated_at: now,
    };

    try {
      await this.col('bill_sessions').insertOne(doc);
      return cleanDoc(doc);
    } catch (err) {
      if (err.code === 11000 || String(err.message).includes('E11000')) {
        throw new BillStoreError('ACTIVE_SESSION_EXISTS', `Active bill session already exists for worker ${workerPhone}.`);
      }
      throw err;
    }
  }

  async getBillSession(sessionId) {
    if (!sessionId) return null;
    const doc = await this.col('bill_sessions').findOne({ session_id: sessionId });
    return cleanDoc(doc);
  }

  async updateBillSession(sessionId, updates = {}) {
    if (!sessionId) {
      throw new BillStoreError('INVALID_INPUT', 'sessionId is required.');
    }

    const safeUpdates = { ...updates };
    delete safeUpdates.session_id;
    delete safeUpdates._id;
    delete safeUpdates.created_at;

    if (safeUpdates.state && !SESSION_STATES.includes(safeUpdates.state)) {
      throw new BillStoreError('INVALID_STATE', `State '${safeUpdates.state}' is not a valid session state.`);
    }

    safeUpdates.updated_at = new Date();

    const updated = await this.col('bill_sessions').findOneAndUpdate(
      { session_id: sessionId },
      { $set: safeUpdates },
      { returnDocument: 'after' }
    );

    const result = updated?.value || updated;
    return cleanDoc(result);
  }

  async completeBillSession(sessionId) {
    return this.updateBillSession(sessionId, { state: 'COMPLETED' });
  }

  async claimBillSave(sessionId, messageId) {
    const result = await this.col('bill_sessions').updateOne({
      session_id: sessionId,
      state: { $in: [...ACTIVE_SESSION_STATES].filter(state => state !== 'CREATING_IN_ZOHO' && state !== 'EXTRACTING') },
    }, { $set: { state: 'CREATING_IN_ZOHO', last_message_id: messageId, updated_at: new Date() } });
    return result.modifiedCount === 1;
  }

  async cancelBillSession(sessionId) {
    return this.updateBillSession(sessionId, { state: 'CANCELLED' });
  }

  // ==========================================
  // BILL CRUD PERSISTENCE
  // ==========================================

  async saveBill(billData = {}) {
    const workerPhone = billData.worker_phone;
    if (!workerPhone || typeof workerPhone !== 'string') {
      throw new BillStoreError('INVALID_INPUT', 'worker_phone is required.');
    }

    const billId = billData.bill_id || randomUUID();
    const now = new Date();

    const status = billData.status || 'DRAFT';
    if (!BILL_STATUSES.includes(status)) {
      throw new BillStoreError('INVALID_STATUS', `Status '${status}' is not a valid bill status.`);
    }

    const zohoStatus = billData.zoho_status || 'NOT_SYNCED';
    if (!ZOHO_STATUSES.includes(zohoStatus)) {
      throw new BillStoreError('INVALID_ZOHO_STATUS', `Zoho status '${zohoStatus}' is not a valid zoho status.`);
    }

    const doc = {
      bill_id: billId,
      session_id: billData.session_id || null,
      source_message_id: billData.source_message_id || null,
      worker_phone: workerPhone,

      status,
      zoho_status: zohoStatus,

      vendor_name: billData.vendor_name || null,
      vendor_phone: billData.vendor_phone || null,
      vendor_email: billData.vendor_email || null,
      vendor_trn: billData.vendor_trn || null,
      zoho_vendor_id: billData.zoho_vendor_id || null,

      payment_type: billData.payment_type || null,
      customer_details: billData.customer_details || null,

      bill_number: billData.bill_number || null,
      bill_date: billData.bill_date || null,
      due_date: billData.due_date || null,
      currency: billData.currency || null,

      subtotal: typeof billData.subtotal === 'number' ? billData.subtotal : null,
      tax_amount: typeof billData.tax_amount === 'number' ? billData.tax_amount : null,
      discount_amount: typeof billData.discount_amount === 'number' ? billData.discount_amount : 0,
      total_amount: typeof billData.total_amount === 'number' ? billData.total_amount : null,

      line_items: Array.isArray(billData.line_items) ? billData.line_items : [],

      notes: billData.notes || null,
      additional_information: billData.additional_information || null,

      attachments: Array.isArray(billData.attachments) ? billData.attachments : [],

      zoho_bill_id: billData.zoho_bill_id || null,
      zoho_bill_url: billData.zoho_bill_url || null,
      zoho_error: billData.zoho_error || null,

      edit_history: Array.isArray(billData.edit_history) ? billData.edit_history : [],

      updated_at: now,
    };

    const saved = await this.col('bills').findOneAndUpdate(
      { bill_id: billId },
      {
        $set: doc,
        $setOnInsert: { created_at: now },
      },
      { upsert: true, returnDocument: 'after' }
    );

    const result = saved?.value || saved;
    return cleanDoc(result);
  }

  async getBill(billId) {
    if (!billId || typeof billId !== 'string') return null;
    const doc = await this.col('bills').findOne({ bill_id: billId });
    return cleanDoc(doc);
  }

  async updateBill(billId, updates = {}) {
    if (!billId || typeof billId !== 'string') {
      throw new BillStoreError('INVALID_INPUT', 'billId is required.');
    }

    const safeUpdates = { ...updates };
    delete safeUpdates.bill_id;
    delete safeUpdates._id;
    delete safeUpdates.created_at;

    if (safeUpdates.status && !BILL_STATUSES.includes(safeUpdates.status)) {
      throw new BillStoreError('INVALID_STATUS', `Status '${safeUpdates.status}' is not a valid bill status.`);
    }
    if (safeUpdates.zoho_status && !ZOHO_STATUSES.includes(safeUpdates.zoho_status)) {
      throw new BillStoreError('INVALID_ZOHO_STATUS', `Zoho status '${safeUpdates.zoho_status}' is not a valid zoho status.`);
    }

    safeUpdates.updated_at = new Date();

    const updateOps = { $set: safeUpdates };
    if (updates.new_edit_history) {
      updateOps.$push = { edit_history: updates.new_edit_history };
      delete safeUpdates.new_edit_history;
    }

    const updated = await this.col('bills').findOneAndUpdate(
      { bill_id: billId },
      updateOps,
      { returnDocument: 'after' }
    );

    const result = updated?.value || updated;
    return cleanDoc(result);
  }

  async listBills({ page = 1, pageSize = 20, status = null, zohoStatus = null, workerPhone = null, search = '' } = {}) {
    const filter = {};

    if (status) filter.status = status;
    if (zohoStatus) filter.zoho_status = zohoStatus;
    if (workerPhone) filter.worker_phone = workerPhone;

    if (search && typeof search === 'string') {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { vendor_name: regex },
        { bill_number: regex },
        { worker_phone: regex },
        { notes: regex },
      ];
    }

    const validPage = Math.max(1, Number(page) || 1);
    const validPageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const skip = (validPage - 1) * validPageSize;

    const [total, items] = await Promise.all([
      this.col('bills').countDocuments(filter),
      this.col('bills')
        .find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(validPageSize)
        .toArray(),
    ]);

    return {
      items: items.map(cleanDoc),
      total,
      page: validPage,
      pageSize: validPageSize,
      totalPages: Math.ceil(total / validPageSize),
    };
  }

  async getBillStats() {
    const pipeline = [
      {
        $group: {
            _id: null,
            total: { $sum: 1 },
            total_amount: { $sum: { $ifNull: ['$total_amount', 0] } },
            pending_amount: {
              $sum: {
                $cond: [
                  { $in: ['$status', ['DRAFT', 'PENDING_REVIEW', 'READY_FOR_CONFIRMATION', 'CREATING']] },
                  { $ifNull: ['$total_amount', 0] },
                  0,
                ],
              },
            },
          draft: { $sum: { $cond: [{ $eq: ['$status', 'DRAFT'] }, 1, 0] } },
          pending_review: { $sum: { $cond: [{ $eq: ['$status', 'PENDING_REVIEW'] }, 1, 0] } },
          ready_for_confirmation: { $sum: { $cond: [{ $eq: ['$status', 'READY_FOR_CONFIRMATION'] }, 1, 0] } },
          creating: { $sum: { $cond: [{ $eq: ['$status', 'CREATING'] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] } },
          zoho_not_synced: { $sum: { $cond: [{ $eq: ['$zoho_status', 'NOT_SYNCED'] }, 1, 0] } },
          zoho_syncing: { $sum: { $cond: [{ $eq: ['$zoho_status', 'SYNCING'] }, 1, 0] } },
          zoho_synced: { $sum: { $cond: [{ $eq: ['$zoho_status', 'SYNCED'] }, 1, 0] } },
          zoho_failed: { $sum: { $cond: [{ $eq: ['$zoho_status', 'FAILED'] }, 1, 0] } },
        },
      },
    ];

    const res = await this.col('bills').aggregate(pipeline).toArray();
    const stats = res[0] || {};
    delete stats._id;

      return {
        total: stats.total || 0,
        total_amount: Number(stats.total_amount) || 0,
        pending_amount: Number(stats.pending_amount) || 0,
      draft: stats.draft || 0,
      pending_review: stats.pending_review || 0,
      ready_for_confirmation: stats.ready_for_confirmation || 0,
      creating: stats.creating || 0,
      completed: stats.completed || 0,
      cancelled: stats.cancelled || 0,
      failed: stats.failed || 0,
      zoho_not_synced: stats.zoho_not_synced || 0,
      zoho_syncing: stats.zoho_syncing || 0,
      zoho_synced: stats.zoho_synced || 0,
      zoho_failed: stats.zoho_failed || 0,
    };
  }

  async getBooksOverviewStats() {
    const billStats = await this.getBillStats();

    const sessionPipeline = [
      {
        $group: {
          _id: null,
          extracting: { $sum: { $cond: [{ $eq: ['$state', 'EXTRACTING'] }, 1, 0] } },
          awaiting_additional_info: {
            $sum: {
              $cond: [
                { $in: ['$state', ['AWAITING_ADDITIONAL_INFO', 'WAITING_FOR_ADDITIONAL_INFO']] },
                1,
                0,
              ],
            },
          },
          awaiting_edit: {
            $sum: {
              $cond: [
                { $in: ['$state', ['AWAITING_EDIT', 'WAITING_FOR_EDIT_INSTRUCTION']] },
                1,
                0,
              ],
            },
          },
          awaiting_final_confirmation: {
            $sum: { $cond: [{ $eq: ['$state', 'AWAITING_FINAL_CONFIRMATION'] }, 1, 0] },
          },
          creating_in_zoho: {
            $sum: { $cond: [{ $eq: ['$state', 'CREATING_IN_ZOHO'] }, 1, 0] },
          },
          completed: { $sum: { $cond: [{ $eq: ['$state', 'COMPLETED'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$state', 'CANCELLED'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$state', 'FAILED'] }, 1, 0] } },
        },
      },
    ];

    let sessionStats;
    try {
      const sessionRes = await this.col('bill_sessions').aggregate(sessionPipeline).toArray();
      sessionStats = sessionRes[0] || {};
      delete sessionStats._id;
    } catch {
      sessionStats = {};
    }

    const processing = Math.max(sessionStats.extracting || 0, billStats.draft || 0);
    const awaitingInfo = sessionStats.awaiting_additional_info || 0;
    const awaitingEdit = sessionStats.awaiting_edit || 0;
    const awaitingConfirmation = Math.max(
      sessionStats.awaiting_final_confirmation || 0,
      billStats.ready_for_confirmation || 0
    );
    const creatingInZoho = Math.max(
      sessionStats.creating_in_zoho || 0,
      billStats.creating || 0,
      billStats.zoho_syncing || 0
    );
    const completed = Math.max(billStats.completed || 0, sessionStats.completed || 0);
    const cancelled = Math.max(billStats.cancelled || 0, sessionStats.cancelled || 0);
    const failed = Math.max(billStats.failed || 0, sessionStats.failed || 0);

    return {
      total: billStats.total || 0,
      processing,
      awaiting_additional_info: awaitingInfo,
      awaiting_edit: awaitingEdit,
      awaiting_final_confirmation: awaitingConfirmation,
      creating_in_zoho: creatingInZoho,
      completed,
      cancelled,
      failed,
      ...billStats,
    };
  }

  async getBillWithDetails(billId) {
    const bill = await this.getBill(billId);
    if (!bill) return null;

    let session = null;
    if (bill.session_id) {
      session = await this.getBillSession(bill.session_id);
    }
    if (!session && bill.bill_id) {
      const foundSession = await this.col('bill_sessions').findOne({ bill_id: bill.bill_id });
      if (foundSession) session = cleanDoc(foundSession);
    }

    let extraction = null;
    if (bill.source_message_id) {
      extraction = await this.getBillExtractionByMessageId(bill.source_message_id);
    }
    if (!extraction && session?.last_message_id) {
      extraction = await this.getBillExtractionByMessageId(session.last_message_id);
    }

    let pendingAction;
    const state = session?.state || (bill.status === 'READY_FOR_CONFIRMATION' ? 'AWAITING_FINAL_CONFIRMATION' : bill.status);
    switch (state) {
      case 'EXTRACTING':
        pendingAction = 'Extracting bill details from document';
        break;
      case 'AWAITING_ADDITIONAL_INFO':
        pendingAction = 'Waiting for SAVE, EDIT or DELETE';
        break;
      case 'WAITING_FOR_ADDITIONAL_INFO':
        pendingAction = 'Waiting for worker to provide additional info text';
        break;
      case 'WAITING_FOR_CURRENCY':
        pendingAction = 'Waiting for worker to provide the bill currency';
        break;
      case 'WAITING_FOR_CUSTOMER_SELECTION':
        pendingAction = 'Waiting for worker to select a Zoho Books customer';
        break;
      case 'AWAITING_EDIT':
        pendingAction = 'Waiting for SAVE, EDIT or DELETE';
        break;
      case 'WAITING_FOR_EDIT_INSTRUCTION':
        pendingAction = 'Waiting for worker to provide field edit instructions';
        break;
      case 'AWAITING_FINAL_CONFIRMATION':
        pendingAction = 'Waiting for SAVE/1, EDIT/2 or DELETE/3';
        break;
      case 'CREATING_IN_ZOHO':
        pendingAction = 'Submitting bill and attachments to Zoho Books API';
        break;
      case 'COMPLETED':
        pendingAction = 'Bill successfully created in Zoho Books';
        break;
      case 'CANCELLED':
        pendingAction = 'Session cancelled by worker';
        break;
      case 'FAILED':
        pendingAction = session?.last_error ? `Failed: ${session.last_error}` : 'Processing failed';
        break;
      default:
        pendingAction = null;
    }

    return {
      ...bill,
      session: session ? {
        session_id: session.session_id,
        worker_phone: session.worker_phone,
        bill_id: session.bill_id,
        state: session.state,
        last_message_id: session.last_message_id,
        expires_at: session.expires_at,
        created_at: session.created_at,
        updated_at: session.updated_at,
        pending_action: pendingAction,
      } : null,
      extraction: extraction ? {
        job_id: extraction.job_id,
        message_id: extraction.message_id,
        worker_phone: extraction.worker_phone,
        status: extraction.status,
        attempts: extraction.attempts,
        max_attempts: extraction.max_attempts,
        last_error: extraction.last_error,
        model: extraction.payload?.model || extraction.result?.model || 'gpt-4o-mini',
        confidence: extraction.result?.confidence || null,
        grounding: extraction.result?.grounding || null,
        validation: extraction.result?.validation || null,
        created_at: extraction.created_at,
        updated_at: extraction.updated_at,
      } : null,
      pending_action: pendingAction,
    };
  }

  async listBillSessions({ page = 1, pageSize = 20, state = null, workerPhone = null } = {}) {
    const filter = {};
    if (state) filter.state = state;
    if (workerPhone) filter.worker_phone = workerPhone;

    const validPage = Math.max(1, Number(page) || 1);
    const validPageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const skip = (validPage - 1) * validPageSize;

    const [total, items] = await Promise.all([
      this.col('bill_sessions').countDocuments(filter),
      this.col('bill_sessions')
        .find(filter)
        .sort({ updated_at: -1 })
        .skip(skip)
        .limit(validPageSize)
        .toArray(),
    ]);

    return {
      items: items.map(cleanDoc),
      total,
      page: validPage,
      pageSize: validPageSize,
      totalPages: Math.ceil(total / validPageSize),
    };
  }
}

function createBillStore(options = {}) {
  return new BillStore(options);
}

module.exports = {
  BillStore,
  createBillStore,
  BillStoreError,
};
