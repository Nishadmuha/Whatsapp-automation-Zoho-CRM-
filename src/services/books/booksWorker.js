'use strict';
const { isBooksBatchBoundary } = require('../whatsapp/messageBatching');

function createBooksWorker({
  billStore,
  billWorkflow,
  whatsapp = null,
  config = {},
  logger = null,
  triggerGate = null,
} = {}) {
  let timer = null;
  let dispatching = null;
  let pumpRequested = false;
  let stopped = true;
  let halted = false;
  const concurrency = Number.isInteger(config.booksConcurrency) && config.booksConcurrency >= 1
    && config.booksConcurrency <= 3 ? config.booksConcurrency : 3;
  const activeWorkers = new Map();
  const retryWorkers = new Set();

  function log(level, event, details = {}) {
    try {
      logger?.[level]?.({ event, ...details });
    } catch {
      /* Safe logger */
    }
  }

  async function processJob(claimedJob) {
    let heartbeatTimer = null;
    let claimedJobs = [];
    let replyReserved = false;
    let retryAfterPoll = false;
    const jobStartedAt = Date.now();

    try {
      const leaseMs = config.leaseMs || 120000;
      claimedJobs = claimedJob.batch_items || [claimedJob];
      const activeJobs = [];
      for (const job of claimedJobs) {
        if (!triggerGate || triggerGate.allows(job.message_id)) activeJobs.push(job);
        else {
          log('info', 'books_job_trigger_not_allowed', { jobId: job.job_id, messageId: job.message_id });
          await billStore.failBillExtraction(job.job_id, job.lease_token, { error: 'TRIGGER_NOT_ALLOWED' });
        }
      }
      if (!activeJobs.length) return true;
      claimedJobs = activeJobs;
      const anchor = activeJobs.at(-1);
      const jobId = anchor.job_id;
      const messageId = anchor.message_id;

      // Setup lease heartbeat during asynchronous processing
      const heartbeatIntervalMs = Math.max(5000, Math.floor(leaseMs / 3));
      heartbeatTimer = setInterval(async () => {
        await Promise.allSettled(activeJobs.map(async job => {
          try { await billStore.heartbeatBillExtraction(job.job_id, job.lease_token, leaseMs); }
          catch (hbErr) { log('warn', 'books_job_heartbeat_failed', { jobId: job.job_id, error: hbErr.message }); }
        }));
      }, heartbeatIntervalMs);
      heartbeatTimer.unref();

      const payload = anchor.payload || {};
      const items = activeJobs.map(job => ({
        messageId: job.message_id,
        senderPhone: job.worker_phone,
        messageType: job.payload?.message_type || 'text',
        text: job.payload?.message_text || '',
        mediaId: job.payload?.media_id || null,
        mediaMimeType: job.payload?.media_mime_type || null,
        mediaFilename: job.payload?.media_filename || null,
        mediaBuffer: job.payload?.media_buffer || null,
        interactiveId: job.payload?.interactive_id || null,
      }));
      const incoming = {
        messageId,
        senderPhone: anchor.worker_phone,
        messageType: payload.message_type || 'text',
        text: payload.message_text || '',
        mediaId: payload.media_id || null,
        mediaMimeType: payload.media_mime_type || null,
        mediaFilename: payload.media_filename || null,
        mediaBuffer: payload.media_buffer || null,
        interactiveId: payload.interactive_id || null,
        items,
      };

      const processingStartedAt = Date.now();
      const createdTimes = activeJobs.map(job => new Date(job.created_at).getTime()).filter(Number.isFinite);
      const queueWaitMs = createdTimes.length ? Math.max(0, processingStartedAt - Math.min(...createdTimes)) : null;
      const result = await billWorkflow.processMessage(incoming);
      log('info', 'books_reply_ready', {
        messageId,
        batchSize: activeJobs.length,
        durationMs: Date.now() - processingStartedAt,
        queueWaitMs,
      });

      let replyDelivery = 'NOT_REQUIRED';
      let providerMessageId = null;
      const replyMessages = Array.isArray(result?.replyMessages)
        ? result.replyMessages.filter(message => typeof message === 'string' && message.trim()) : [];
      const hasReply = Boolean(result?.replyInteractive || result?.replyText || replyMessages.length);
      if (hasReply && typeof billStore.reserveBillReply === 'function') {
        const reservations = await Promise.all(activeJobs.map(job =>
          billStore.reserveBillReply(job.job_id, job.lease_token)));
        replyReserved = reservations.every(Boolean);
        if (!replyReserved) {
          replyDelivery = 'DUPLICATE_SUPPRESSED';
          await Promise.allSettled(activeJobs.map((job, index) => reservations[index]
            ? billStore.finishBillReply(job.job_id, job.lease_token, { status: 'UNKNOWN' })
            : Promise.resolve()));
        }
      } else if (hasReply) replyReserved = true;

      if (replyReserved) {
        let sentCount = 0;
        try {
          // Reserve the entire sequence before sending any part. A partially
          // delivered sequence is never automatically replayed on retry.
          for (const message of replyMessages) {
            if (typeof whatsapp?.sendTextMessage !== 'function') throw Object.assign(new Error('TEXT_TRANSPORT_UNAVAILABLE'), { deliveryState: 'NOT_ATTEMPTED' });
            const sent = await whatsapp.sendTextMessage(anchor.worker_phone, message);
            providerMessageId = sent?.messages?.[0]?.id || null;
            sentCount += 1;
          }
          if (result?.replyInteractive && typeof whatsapp?.sendInteractiveList === 'function') {
            const sent = await whatsapp.sendInteractiveList(anchor.worker_phone, result.replyInteractive);
            providerMessageId = sent?.messages?.[0]?.id || null;
            sentCount += 1;
          } else if (result?.replyText && typeof whatsapp?.sendTextMessage === 'function') {
            const sent = await whatsapp.sendTextMessage(anchor.worker_phone, result.replyText);
            providerMessageId = sent?.messages?.[0]?.id || null;
            sentCount += 1;
          } else if (result?.replyInteractive || result?.replyText) {
            throw Object.assign(new Error('REPLY_TRANSPORT_UNAVAILABLE'), { deliveryState: 'NOT_ATTEMPTED' });
          }
          replyDelivery = sentCount ? 'ACCEPTED' : 'NOT_ATTEMPTED';
        } catch (sendErr) {
          replyDelivery = sentCount ? 'UNKNOWN' : sendErr.deliveryState || 'UNKNOWN';
          log('error', 'books_reply_send_failed', { jobId, deliveryState: replyDelivery });
        }
      }
      if (replyReserved && typeof billStore.finishBillReply === 'function') {
        const replyStatus = replyDelivery === 'ACCEPTED' ? 'ACCEPTED'
          : ['NOT_ATTEMPTED', 'ATTEMPTED_FAILED'].includes(replyDelivery) ? 'FAILED' : 'UNKNOWN';
        await Promise.all(activeJobs.map(job => billStore.finishBillReply(job.job_id, job.lease_token, {
          status: replyStatus, providerMessageId,
        })));
      }

      if (result?.success) {
        await Promise.all(activeJobs.map(job => billStore.completeBillExtraction(job.job_id, job.lease_token, {
          sessionId: result.sessionId, state: result.state, billId: result.billId,
          replyText: job.job_id === jobId ? result.replyText : null,
          replyDelivery: job.job_id === jobId ? replyDelivery : 'BATCHED',
        })));
        log('info', 'books_job_completed', {
          jobId,
          batchSize: activeJobs.length,
          sessionId: result.sessionId,
          state: result.state,
          durationMs: Date.now() - jobStartedAt,
          queueWaitMs,
        });
      } else {
        retryAfterPoll = true;
        const errMsg = result?.error?.message || result?.replyText || 'EXTRACTION_PROCESSING_FAILED';
        await Promise.all(activeJobs.map(job => billStore.failBillExtraction(job.job_id, job.lease_token, { error: errMsg })));
        log('warn', 'books_job_processing_failed', { jobId, error: result?.error });
      }
    } catch (err) {
      retryAfterPoll = true;
      log('error', 'books_job_unhandled_error', { jobId: claimedJob?.job_id, error: err.message });
      if (replyReserved) {
        await Promise.allSettled(claimedJobs.map(job => billStore.completeBillExtraction(job.job_id, job.lease_token, {
          state: 'REPLY_RECONCILIATION_REQUIRED', replyDelivery: 'UNKNOWN', error: 'WORKER_COMPLETION_FAILED',
        })));
      } else {
        await Promise.allSettled(claimedJobs.map(job =>
          billStore.failBillExtraction(job.job_id, job.lease_token, { error: err.message })));
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (triggerGate) for (const job of claimedJobs) {
        try { triggerGate.finish(job.message_id); } catch { /* Safe gate finish */ }
      }
    }
    return retryAfterPoll;
  }

  function pump() {
    if (halted) return Promise.resolve();
    pumpRequested = true;
    if (dispatching) return dispatching;
    dispatching = Promise.resolve().then(async () => {
      do {
        pumpRequested = false;
        while (!halted && activeWorkers.size < concurrency) {
          // One claim at a time prevents two local slots racing for a sender.
          const job = await billStore.claimBillExtraction({
            leaseMs: config.leaseMs || 120000,
            maxAttempts: config.maxAttempts || 3,
            batchQuietMs: config.messageBatchQuietMs || 0,
            batchBoundary: isBooksBatchBoundary,
            batchSessionAware: true,
            excludeWorkerPhones: [...new Set([...activeWorkers.keys(), ...retryWorkers])],
          });
          if (!job) break;
          const phone = job.worker_phone;
          // A claim already in flight at stop still finishes its full sequence.
          const processing = Promise.resolve().then(() => processJob(job)).then(retryAfterPoll => {
            if (retryAfterPoll) retryWorkers.add(phone);
          }).catch(error => {
            retryWorkers.add(phone);
            log('error', 'books_job_unhandled_error', { jobId: job.job_id, error: error.message });
          }).finally(() => {
            activeWorkers.delete(phone);
            if (!halted) void pump();
          });
          activeWorkers.set(phone, processing);
        }
      } while (pumpRequested && !halted);
    }).catch(error => {
      log('error', 'books_job_claim_failed', { error: error.message });
    }).finally(() => {
      dispatching = null;
      if (pumpRequested && !halted) void pump();
    });
    return dispatching;
  }

  async function waitForIdle() {
    while (dispatching || activeWorkers.size) {
      await Promise.allSettled([dispatching, ...activeWorkers.values()].filter(Boolean));
    }
  }

  async function tick() {
    if (halted) return;
    retryWorkers.clear();
    await pump();
    await waitForIdle();
  }

  function wake() {
    if (stopped || halted) return;
    retryWorkers.clear();
    void pump();
  }

  function start() {
    if (!stopped || !config.enabled) return;
    stopped = false;
    halted = false;
    timer = setInterval(wake, config.pollMs || 1000);
    timer.unref();
    wake();
  }

  async function stop() {
    stopped = true;
    halted = true;
    if (timer) clearInterval(timer);
    timer = null;
    await waitForIdle();
  }

  return {
    start,
    stop,
    tick,
    wake,
  };
}

module.exports = {
  createBooksWorker,
};
