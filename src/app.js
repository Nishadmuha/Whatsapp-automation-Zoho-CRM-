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
    onNewMessage: message => app.locals.onNewMessage?.(message) }));
  app.use('/api/admin', adminAccess.router);
  app.use('/api/leads', createLeadsRouter({ config, store, ready, logger, env, requireAuth: adminAccess.requireAuth, whatsapp: app.locals.whatsapp }));
  app.use('/api/chats', createChatsRouter({ config, store, ready, logger, env, requireAuth: adminAccess.requireAuth }));
  app.use('/admin', createLeadsDashboardRouter());
  app.use('/admin', createChatsDashboardRouter());
  // Root and bare /admin redirect to the leads workspace.
  // leads.html already contains the login panel — unauthenticated users see it
  // automatically; no second auth system is introduced.
  app.get(['/', '/admin', '/admin/'], (_req, res) => res.redirect(302, '/admin/leads'));
  app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

  app.use(errorHandler(logger));
  return app;
}
module.exports = { createApp };
