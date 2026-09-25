'use strict';
const path = require('node:path');
const dotenv = require('dotenv');
const { createApp } = require('./app');
const { readConfig } = require('./config/env');
const { connectMongoDB, disconnectMongoDB } = require('./config/db');
const { createLogger } = require('./utils/logger');

async function startServer() {
  const loaded = dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true, debug: false });
  if (loaded.error && loaded.error.code !== 'ENOENT') throw new Error('Unable to read .env.');
  const config = readConfig(process.env);
  const logger = createLogger();
  const app = createApp({ config, logger });
  const store = app.locals.store;
  const triggerGate = app.locals.triggerGate;
  try { await app.locals.ready; } catch {
    await store.close().catch(() => {});
    throw new Error('Database initialization failed. Check MONGODB_URI and MongoDB Atlas availability.');
  }
  // Replies and optional internal boss extraction run here. CRM writes stay disconnected.
  let worker;
  let extractionWorker;
  let booksWorker;
  let server;
  const stopWorkers = () => Promise.allSettled([
    Promise.resolve().then(() => worker?.stop()),
    Promise.resolve().then(() => extractionWorker?.stop()),
    Promise.resolve().then(() => booksWorker?.stop()),
    Promise.resolve().then(() => app.locals.outgoingMessages?.stop()),
  ]);
  const closeDatabases = () => Promise.allSettled([
    Promise.resolve().then(() => store.close()),
    Promise.resolve().then(() => disconnectMongoDB()),
  ]);
  try {
    await connectMongoDB({ env: { ...process.env, MONGODB_URI: config.mongoUri }, logger });
    if (config.enabled) {
      const { createWhatsAppService } = require('./services/whatsapp/whatsappService');
      const { createWorker } = require('./worker');
      const { createOutgoingMessages } = require('./services/whatsapp/outgoingMessages');
      const { createAcknowledgementBatcher, isBossBatchBoundary, isBooksBatchBoundary } = require('./services/whatsapp/messageBatching');
      const whatsapp = createWhatsAppService({ logger });
      const outgoingMessages = createOutgoingMessages({ store, whatsapp, config, logger, triggerGate });
      const acknowledgementBatches = createAcknowledgementBatcher({ quietMs: config.messageBatchQuietMs });
      app.locals.outgoingMessages = outgoingMessages;
      app.locals.whatsapp = whatsapp;
      let billStore = null;
      if (config.booksSenders?.size) {
        const { createBillStore } = require('./database/billStore');
        billStore = app.locals.billStore || createBillStore({ store, logger });
        await billStore.init();
        app.locals.billStore = billStore;
      }
      app.locals.onNewMessage = async (message) => {
        const isBooks = Boolean(billStore && config.booksSenders?.has(message.senderPhone));
        const isBoss = !isBooks && config.bossSenders?.has(message.senderPhone);
        const boundary = isBooks ? isBooksBatchBoundary(message) : isBoss ? isBossBatchBoundary(message) : false;
        const groupKey = (isBooks || isBoss) ? acknowledgementBatches.groupFor(message, { boundary }) : null;
        if (isBooks) {
          const isGreeting = /^(hi|hello|hey|salaam)[.!?]*$/i.test((message.text || '').trim());
          const isCustomerSelection = Boolean(message.interactiveId);
          const acknowledgement = message.mediaId || (!isGreeting && !isCustomerSelection)
            ? outgoingMessages.acknowledge(message, { isBooks: true, groupKey }).catch(() => {
              logger.warn({ event: 'books_ack_unavailable', message_id: message.messageId });
            })
            : Promise.resolve();
          const extraction = billStore.enqueueBillExtraction({
              messageId: message.messageId,
              workerPhone: message.senderPhone,
              maxAttempts: config.maxAttempts,
              payload: {
                message_id: message.messageId,
                message_text: message.text,
                message_type: message.messageType,
                media_id: message.mediaId || null,
                media_mime_type: message.mediaMimeType || null,
                media_filename: message.mediaFilename || null,
                interactive_id: message.interactiveId || null,
              },
          });
          await Promise.all([acknowledgement, extraction]);
        } else if (isBoss && !boundary) {
          try { await outgoingMessages.acknowledge(message, { groupKey }); }
          catch { logger.warn({ event: 'boss_ack_unavailable', message_id: message.messageId }); }
        }
      };
      const conversational = config.aiProvider === 'openai';
      let processor;
      let ai = null;
      if (conversational) {
        const { createAiService } = require('./services/ai/aiService');
        const { createConversationProcessor } = require('./services/ai/conversationProcessor');
        ai = createAiService({ logger });
        processor = createConversationProcessor({ store, config, logger, whatsapp, ai, triggerGate });
        if (config.bossSenders.size) {
          const { createBossLeadProcessor } = require('./services/ai/bossLeadProcessor');
          const { createBossLeadWorkflow } = require('./services/leads/bossLeadWorkflow');
          const legacyExtraction = createBossLeadProcessor({ store, ai, config, logger, triggerGate });
          const leadWorkflow = createBossLeadWorkflow({ store, ai, whatsapp, config, logger, triggerGate });
          // A second instance of the existing worker runs independently in this
          // same process, so extraction cannot block customer reply processing.
          extractionWorker = createWorker({
            store: { claimNext: (options) => store.claimLeadExtraction({ ...options,
              batchQuietMs: config.messageBatchQuietMs, batchBoundary: isBossBatchBoundary }) },
            processor: {
              processIncomingWhatsAppMessage(job) {
                return job.processing_flow === 'boss_lead'
                  ? leadWorkflow.processIncomingWhatsAppMessage(job)
                  : legacyExtraction.processIncomingWhatsAppMessage(job);
              },
              processNextReply: leadWorkflow.processNextReply,
            },
            config,
            logger,
            triggerGate,
            concurrency: 4,
          });
        }
      } else {
        const { createAutoReplyProcessor } = require('./services/whatsapp/autoReply');
        processor = createAutoReplyProcessor({ store, config, logger, whatsapp, triggerGate });
      }
      if (conversational && config.booksSenders?.size) {
        const { createZohoBooksClient } = require('./services/books/zohoBooksClient');
        const { createBillExtractionService } = require('./services/ai/billExtractionService');
        const { createBillWorkflow } = require('./services/books/billWorkflow');
        const { createBooksWorker } = require('./services/books/booksWorker');

        const zohoBooksClient = createZohoBooksClient({ config, logger });
        const billExtractionService = createBillExtractionService({ env: process.env, logger });
        const billWorkflow = createBillWorkflow({
          billStore,
          billExtractionService,
          zohoBooksClient,
          whatsappService: whatsapp,
          aiService: ai,
          store,
          config,
          logger,
        });

        booksWorker = createBooksWorker({
          billStore,
          billWorkflow,
          whatsapp,
          config,
          logger,
          triggerGate,
        });
      }
      worker = createWorker({
        store, processor, config, logger, triggerGate, processInbox: conversational,
        inboxClaimOptions: conversational ? { processingFlow: 'conversation' } : {},
        concurrency: conversational ? 4 : 1,
      });
    }
    server = app.listen(config.port, config.host);
  } catch (error) {
    triggerGate?.close();
    await stopWorkers();
    await closeDatabases();
    throw error;
  }
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    triggerGate?.close();
    logger.info({ event: 'shutdown_started' });
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 30000);
    deadline.unref();
    const closed = new Promise((resolve) => server.close(resolve));
    const workerResults = await stopWorkers();
    await closed;
    const databaseResults = await closeDatabases();
    clearTimeout(deadline);
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    if ([...workerResults, ...databaseResults].some(result => result.status === 'rejected')) {
      logger.error({ event: 'shutdown_cleanup_failed' }, 'Some backend resources could not be closed cleanly.');
      process.exitCode = 1;
    } else logger.info({ event: 'shutdown_complete' });
  }
  server.once('listening', () => {
    logger.info({ event: 'server_listening', port: config.port, automation: config.enabled ? 'enabled' : 'disabled' }, `Server running on port ${config.port}`);
    if (!config.appSecret) logger.warn({ event: 'webhook_signatures_disabled' }, 'Local development only: set META_APP_SECRET before exposing /webhook through ngrok.');
    worker?.start();
    extractionWorker?.start();
    booksWorker?.start();
  });
  server.once('error', async (error) => {
    triggerGate?.close();
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    await stopWorkers();
    await closeDatabases();
    console.error(error.code === 'EADDRINUSE'
      ? 'Port ' + config.port + ' is already in use. Stop the other server or change PORT.'
      : 'Unable to start the HTTP server.');
    process.exitCode = 1;
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.shutdown = shutdown;
  return server;
}
if (require.main === module) {
  startServer().catch((error) => {
    console.error('Server startup failed: ' + error.message);
    process.exitCode = 1;
  });
}
module.exports = { createApp, startServer };
