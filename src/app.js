'use strict';
const express = require('express');
const path = require('node:path');
const cors = require('cors');
const helmet = require('helmet');
const { readConfig } = require('./config/env');
const { createLogger } = require('./utils/logger');
const { createMessageStore } = require('./database');
const { requestLogger } = require('./middleware/requestLogger');
const { errorHandler } = require('./middleware/errorHandler');
const { createWebhookRouter } = require('./routes/webhook');
const { createLeadsRouter } = require('./routes/leads');
const { createChatsRouter } = require('./routes/chats');
const { createBooksRouter } = require('./routes/books');
const { createAdminPagesRouter } = require('./routes/adminPages');
const { createBillStore } = require('./database/billStore');
const { createAdminAccess } = require('./middleware/adminAuth');
const { createIncomingTriggerGate } = require('./services/whatsapp/incomingTriggerGate');

function createApp({ env = process.env, config = readConfig(env), logger = createLogger(env), store, billStore } = {}) {
  store ||= createMessageStore({ databaseUrl: config.databaseUrl, logger });
  billStore ||= createBillStore({ store, logger });
  const ready = Promise.resolve().then(() => store.init());
  ready.catch(() => logger.error({ event: 'database_initialization_failed' }));
  const app = express();
  const adminAccess = createAdminAccess({ ...config, cookiePath: '/' });
  const triggerGate = createIncomingTriggerGate({ logger });
  Object.assign(app.locals, { store, billStore, ready, config, triggerGate });
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (config.corsOrigins.length) app.use(cors({ origin: config.corsOrigins }));
  app.use(requestLogger(logger));
  app.use(express.json({ limit: '3mb', inflate: false, verify(req, _res, buffer) { req.rawBody = buffer; } }));
  const getHealthStatus = async () => {
    let mongoStatus;
    try {
      await store.ping();
      mongoStatus = 'CONNECTED';
    } catch {
      mongoStatus = 'DISCONNECTED';
    }

    const whatsappHealthy = Boolean(config.accessToken && config.phoneNumberId);
    const openaiHealthy = Boolean(config.openaiApiKey || env.OPENAI_API_KEY);
    const zohoHealthy = Boolean(config.zohoClientId || env.ZOHO_CLIENT_ID);

    return {
      backend: 'ONLINE',
      mongodb: mongoStatus,
      whatsapp: whatsappHealthy ? 'CONFIGURED / HEALTHY' : 'NOT_CONFIGURED',
      openai: openaiHealthy ? 'CONFIGURED / READY' : 'NOT_CONFIGURED',
      zoho_oauth: zohoHealthy ? 'HEALTHY' : 'NOT_CONFIGURED',
      zoho_crm: zohoHealthy ? 'HEALTHY' : 'NOT_CONFIGURED',
      checks: {
        backend: '🟢 ONLINE',
        mongodb: mongoStatus === 'CONNECTED' ? '🟢 CONNECTED' : '🔴 DISCONNECTED',
        whatsapp_api: whatsappHealthy ? '🟢 CONNECTED' : '⚪ NOT_CONFIGURED',
        openai: openaiHealthy ? '🟢 READY' : '⚪ NOT_CONFIGURED',
        zoho_crm: zohoHealthy ? '🟢 CONNECTED' : '⚪ NOT_CONFIGURED',
      },
    };
  };

  app.get('/health', async (req, res) => {
    if (req.query && (req.query.detailed === 'true' || req.query.status === 'true')) {
      const details = await getHealthStatus();
      return res.json({ status: 'ok', service: 'voltronix-whatsapp-backend', ...details });
    }
    return res.json({ status: 'ok', service: 'voltronix-whatsapp-backend' });
  });
  app.get(['/health/status', '/health/detailed', '/api/health/status'], async (_req, res) => {
    const details = await getHealthStatus();
    return res.json({ status: 'ok', service: 'voltronix-whatsapp-backend', ...details });
  });
  app.get('/api/health', (_req, res) => res.json({ success: true, message: 'Voltronix WhatsApp backend is running' }));
  app.get('/favicon.svg', (_req, res) => res.sendFile(path.join(__dirname, 'admin/favicon.svg')));
  app.get('/favicon.ico', (_req, res) => res.status(204).end());
  app.get('/ready', async (_req, res) => {
    try {
      await ready;
      await store.ping();
      return res.json({ status: 'ready', automation: config.enabled ? 'enabled' : 'disabled' });
    } catch {
      return res.status(503).json({ status: 'unavailable' });
    }
  });
  app.get('/api/media/:reference', adminAccess.requireAuth, async (req, res) => {
    const ref = req.params.reference;
    if (!ref || typeof ref !== 'string') return res.status(400).json({ success: false, message: 'Invalid media reference' });
    try {
      if (typeof store.getMediaFile === 'function') {
        const result = await store.getMediaFile(ref);
        if (result) {
          const { buffer, mimeType } = result;
          res.setHeader('Content-Type', mimeType || 'application/octet-stream');
          res.setHeader('Cache-Control', 'private, max-age=86400');
          return res.send(buffer);
        }
      }
      return res.status(404).json({ success: false, message: 'Media not found' });
    } catch {
      return res.status(500).json({ success: false, message: 'Failed to retrieve media' });
    }
  });
  app.use('/webhook', createWebhookRouter({ config, store, ready, logger, triggerGate,
    onNewMessage: message => app.locals.onNewMessage?.(message),
    billStore: { getActiveBillSession: (p) => app.locals.billStore?.getActiveBillSession(p) } }));
  app.use('/api/admin', adminAccess.router);
  app.use('/api/leads', createLeadsRouter({ config, store, ready, logger, env, requireAuth: adminAccess.requireLeadAuth, whatsapp: app.locals.whatsapp }));
  app.use('/api/chats', createChatsRouter({ config, store, ready, logger, env, requireAuth: adminAccess.requireChatAuth, whatsapp: app.locals.whatsapp }));
  app.use('/api/books', createBooksRouter({ config, billStore, store, ready, logger, env, requireAuth: adminAccess.requireBooksAuth }));
  const adminDir = path.join(__dirname, 'admin');

  // Every dashboard URL is rendered through the same admin shell. Feature
  // routers do not serve complete HTML documents of their own.
  app.use(createAdminPagesRouter({ adminAccess }));

  // One sign-in page, followed by the workspace allowed by the existing session.
  app.get(['/', '/admin', '/admin/'], (req, res) => {
    const session = adminAccess.getSession(req);
    if (!session) return res.redirect(302, '/login');
    if (session.isAdmin || session.permittedPages?.includes('dashboard')) return res.redirect(302, '/dashboard');
    if (session.permittedPages?.includes('bills')) return res.redirect(302, '/bills');
    if (session.permittedPages?.includes('chats')) return res.redirect(302, '/chats');
    return res.redirect(302, '/leads');
  });

  app.get(['/login', '/admin/login', '/login.html', '/admin/login.html'], (req, res) => {
    if (adminAccess.getSession(req)) return res.redirect(302, '/');
    return res.sendFile(path.join(adminDir, 'login.html'));
  });

  // Static assets and direct navigation routes for overview / dashboard
  app.use(express.static(adminDir, { index: false }));
  app.use('/admin', express.static(adminDir, { index: false }));

  // Dashboard & login convenience routes
  app.get(['/bills/login', '/admin/bills-login'], (_req, res) => res.sendFile(path.join(adminDir, 'bills-login.html')));

  app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

  app.use(errorHandler(logger));
  return app;
}
module.exports = { createApp };
