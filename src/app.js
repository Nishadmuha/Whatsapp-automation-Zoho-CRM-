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
const { createLeadsRouter, createLeadsDashboardRouter } = require('./routes/leads');
const { createChatsRouter, createChatsDashboardRouter } = require('./routes/chats');
const { createAdminAccess } = require('./middleware/adminAuth');
const { createIncomingTriggerGate } = require('./services/whatsapp/incomingTriggerGate');

function createApp({ env = process.env, config = readConfig(env), logger = createLogger(env), store } = {}) {
  store ||= createMessageStore({ databaseUrl: config.databaseUrl, logger });
  const ready = Promise.resolve().then(() => store.init());
  ready.catch(() => logger.error({ event: 'database_initialization_failed' }));
  const app = express();
  const adminAccess = createAdminAccess(config);
  const triggerGate = createIncomingTriggerGate({ logger });
  Object.assign(app.locals, { store, ready, config, triggerGate });
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (config.corsOrigins.length) app.use(cors({ origin: config.corsOrigins }));
  app.use(requestLogger(logger));
  app.use(express.json({ limit: '3mb', inflate: false, verify(req, _res, buffer) { req.rawBody = buffer; } }));
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'voltronix-whatsapp-backend' }));
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
  app.use('/webhook', createWebhookRouter({ config, store, ready, logger, triggerGate,
    onNewMessage: message => app.locals.onNewMessage?.(message) }));
  app.use('/api/admin', adminAccess.router);
  app.use('/api/leads', createLeadsRouter({ config, store, ready, logger, env, requireAuth: adminAccess.requireAuth }));
  app.use('/api/chats', createChatsRouter({ config, store, ready, logger, env, requireAuth: adminAccess.requireAuth }));
  app.use('/admin', createLeadsDashboardRouter());
  app.use('/admin', createChatsDashboardRouter());
  app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
  app.use(errorHandler(logger));
  return app;
}
module.exports = { createApp };
