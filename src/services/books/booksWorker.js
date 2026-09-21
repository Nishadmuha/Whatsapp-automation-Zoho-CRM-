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
  let running = null;
  let stopped = true;

  function log(level, event, details = {}) {
    try {
      logger?.[level]?.({ event, ...details });
    } catch {
      /* Safe logger */
    }
  }

  async function tick() {
    if (running) return;
    running = (async () => {
      let heartbeatTimer = null;
      let claimedJob = null;
      let claimedJobs = [];
      let replyReserved = false;

      try {
        const leaseMs = config.leaseMs || 120000;
        const maxAttempts = config.maxAttempts || 3;

        claimedJob = await billStore.claimBillExtraction({
          leaseMs,
          maxAttempts,
          batchQuietMs: config.messageBatchQuietMs || 0,
          batchBoundary: isBooksBatchBoundary,
        });

        if (!claimedJob) return;

        claimedJobs = claimedJob.batch_items || [claimedJob];
        const activeJobs = [];
        for (const job of claimedJobs) {
          if (!triggerGate || triggerGate.allows(job.message_id)) activeJobs.push(job);
          else {
            log('info', 'books_job_trigger_not_allowed', { jobId: job.job_id, messageId: job.message_id });
            await billStore.failBillExtraction(job.job_id, job.lease_token, { error: 'TRIGGER_NOT_ALLOWED' });
          }
        }
        if (!activeJobs.length) return;
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

        const result = await billWorkflow.processMessage(incoming);

        let replyDelivery = 'NOT_REQUIRED';
        let providerMessageId = null;
        const hasReply = Boolean(result?.replyInteractive || result?.replyText);
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

        if (replyReserved && result?.replyInteractive && whatsapp && typeof whatsapp.sendInteractiveList === 'function') {
          try {
            const sent = await whatsapp.sendInteractiveList(anchor.worker_phone, result.replyInteractive);
            providerMessageId = sent?.messages?.[0]?.id || null;
            replyDelivery = 'ACCEPTED';
          } catch (sendErr) {
            replyDelivery = sendErr.deliveryState || 'UNKNOWN';
            log('error', 'books_interactive_reply_send_failed', { jobId, deliveryState: replyDelivery });
          }
        } else if (replyReserved && result?.replyText && whatsapp && typeof whatsapp.sendTextMessage === 'function') {
          try {
            const sent = await whatsapp.sendTextMessage(anchor.worker_phone, result.replyText);
            providerMessageId = sent?.messages?.[0]?.id || null;
            replyDelivery = 'ACCEPTED';
          } catch (sendErr) {
            replyDelivery = sendErr.deliveryState || 'UNKNOWN';
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
          });
        } else {
          const errMsg = result?.error?.message || result?.replyText || 'EXTRACTION_PROCESSING_FAILED';
          await Promise.all(activeJobs.map(job => billStore.failBillExtraction(job.job_id, job.lease_token, { error: errMsg })));
          log('warn', 'books_job_processing_failed', { jobId, error: result?.error });
        }
      } catch (err) {
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
    })();

    await running;
    running = null;
  }

  function start() {
    if (!stopped || !config.enabled) return;
    stopped = false;
    timer = setInterval(() => { void tick(); }, config.pollMs || 1000);
    timer.unref();
    void tick();
  }

  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    await running;
  }

  return {
    start,
    stop,
    tick,
  };
}

module.exports = {
  createBooksWorker,
};
