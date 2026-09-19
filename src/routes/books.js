'use strict';
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { outputRedactor } = require('./leads');
const { createBillStore } = require('../database/billStore');

const QUERY_FIELDS = new Set(['page', 'page_size', 'search', 'status', 'zoho_status', 'worker_phone']);

function listQuery(query) {
  if (Object.entries(query).some(([key, value]) => !QUERY_FIELDS.has(key) || typeof value !== 'string')) {
    return null;
  }
  const integer = (value, fallback, max) => (value === undefined ? fallback
    : /^[1-9]\d{0,6}$/.test(value) && Number(value) <= max ? Number(value) : null);

  const page = integer(query.page, 1, 1_000_000);
  const pageSize = integer(query.page_size, 20, 100);
  const search = query.search ?? '';
  const status = query.status || null;
  const zohoStatus = query.zoho_status || null;
  const workerPhone = query.worker_phone || null;

  if (!page || !pageSize || search.length > 200 || /[\u0000-\u001f\u007f]/.test(search)) {
    return null;
  }

  return { page, pageSize, search, status, zohoStatus, workerPhone };
}

function createBooksRouter({
  config = {},
  billStore = null,
  store = null,
  ready = Promise.resolve(),
  logger = null,
  env = process.env,
  requireAuth,
} = {}) {
  const router = express.Router();
  const redact = outputRedactor(config, env);

  const booksLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.rateLimit || 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests' },
  });

  router.use(booksLimiter);
  if (typeof requireAuth === 'function') {
    router.use(requireAuth);
  }

  const getStore = (req) => {
    return billStore || req.app?.locals?.billStore || (store ? createBillStore({ store, logger }) : null);
  };

  const unavailable = (req, res, err) => {
    logger?.error?.({ event: 'books_api_unavailable', request_id: req.requestId, error: err?.message });
    return res.status(503).json({ success: false, message: 'Temporarily unable to load books data' });
  };

  const invalid = (res) => res.status(400).json({ success: false, message: 'Invalid query parameters' });

  // 1. Overview Statistics
  router.get('/stats', async (req, res) => {
    try {
      await ready;
      const bStore = getStore(req);
      if (!bStore) return unavailable(req, res);
      const stats = await bStore.getBooksOverviewStats();
      return res.json(redact(stats));
    } catch (err) {
      return unavailable(req, res, err);
    }
  });

  // 2. Bills Listing (support / and /bills)
  const handleListBills = async (req, res) => {
    const query = listQuery(req.query);
    if (!query) return invalid(res);

    try {
      await ready;
      const bStore = getStore(req);
      if (!bStore) return unavailable(req, res);

      const result = await bStore.listBills({
        page: query.page,
        pageSize: query.pageSize,
        search: query.search,
        status: query.status,
        zohoStatus: query.zohoStatus,
        workerPhone: query.workerPhone,
      });

      const total = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : 0;
      return res.json(redact({
        items: result.items,
        total,
        page: query.page,
        page_size: query.pageSize,
        total_pages: Math.ceil(total / query.pageSize),
      }));
    } catch (err) {
      return unavailable(req, res, err);
    }
  };

  router.get('/', handleListBills);
  router.get('/bills', handleListBills);

  // 3. Bill Sessions Listing
  router.get('/sessions', async (req, res) => {
    try {
      await ready;
      const bStore = getStore(req);
      if (!bStore) return unavailable(req, res);

      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 20));
      const state = typeof req.query.state === 'string' ? req.query.state : null;
      const workerPhone = typeof req.query.worker_phone === 'string' ? req.query.worker_phone : null;

      const result = await bStore.listBillSessions({ page, pageSize, state, workerPhone });
      return res.json(redact(result));
    } catch (err) {
      return unavailable(req, res, err);
    }
  });

  // 4. Specific Bill Session Details
  router.get('/sessions/:id', async (req, res) => {
    const sessionId = req.params.id;
    if (!sessionId || typeof sessionId !== 'string') return invalid(res);

    try {
      await ready;
      const bStore = getStore(req);
      if (!bStore) return unavailable(req, res);

      const session = await bStore.getBillSession(sessionId);
      if (!session) return res.status(404).json({ success: false, message: 'Bill session not found' });
      return res.json(redact(session));
    } catch (err) {
      return unavailable(req, res, err);
    }
  });

  // 5. Specific Bill Extraction Details
  router.get('/extractions/:id', async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== 'string') return invalid(res);

    try {
      await ready;
      const bStore = getStore(req);
      if (!bStore) return unavailable(req, res);

      let extraction = await bStore.getBillExtraction(id);
      if (!extraction) {
        extraction = await bStore.getBillExtractionByMessageId(id);
      }
      if (!extraction) return res.status(404).json({ success: false, message: 'Extraction record not found' });
      return res.json(redact(extraction));
    } catch (err) {
      return unavailable(req, res, err);
    }
  });

  // 6. Bill Details (support /:id and /bills/:id)
  const handleGetBill = async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== 'string' || id === 'stats' || id === 'bills' || id === 'sessions' || id === 'extractions') {
      return invalid(res);
    }

    try {
      await ready;
      const bStore = getStore(req);
      if (!bStore) return unavailable(req, res);

      const bill = await bStore.getBillWithDetails(id);
      if (!bill) {
        return res.status(404).json({ success: false, message: 'Bill not found' });
      }
      return res.json(redact(bill));
    } catch (err) {
      return unavailable(req, res, err);
    }
  };

  router.get('/:id', handleGetBill);
  router.get('/bills/:id', handleGetBill);

  return router;
}

module.exports = {
  createBooksRouter,
};
