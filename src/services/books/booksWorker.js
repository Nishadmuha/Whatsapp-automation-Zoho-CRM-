'use strict';

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
      let leaseToken = null;

      try {
        const leaseMs = config.leaseMs || 120000;
        const maxAttempts = config.maxAttempts || 3;

        claimedJob = await billStore.claimBillExtraction({
          leaseMs,
          maxAttempts,
        });

        if (!claimedJob) return;

        leaseToken = claimedJob.lease_token;
        const jobId = claimedJob.job_id;
        const messageId = claimedJob.message_id;

        // Verify trigger gate admission if enabled
        if (triggerGate && !triggerGate.allows(messageId)) {
          log('info', 'books_job_trigger_not_allowed', { jobId, messageId });
          await billStore.failBillExtraction(jobId, leaseToken, { error: 'TRIGGER_NOT_ALLOWED' });
          return;
        }

        // Setup lease heartbeat during asynchronous processing
        const heartbeatIntervalMs = Math.max(5000, Math.floor(leaseMs / 3));
        heartbeatTimer = setInterval(async () => {
          try {
            await billStore.heartbeatBillExtraction(jobId, leaseToken, leaseMs);
          } catch (hbErr) {
            log('warn', 'books_job_heartbeat_failed', { jobId, error: hbErr.message });
          }
        }, heartbeatIntervalMs);
        heartbeatTimer.unref();

        const payload = claimedJob.payload || {};
        const incoming = {
          messageId,
          senderPhone: claimedJob.worker_phone,
          messageType: payload.message_type || 'text',
          text: payload.message_text || '',
          mediaId: payload.media_id || null,
          mediaMimeType: payload.media_mime_type || null,
          mediaFilename: payload.media_filename || null,
          mediaBuffer: payload.media_buffer || null,
          interactiveId: payload.interactive_id || null,
        };

        const result = await billWorkflow.processMessage(incoming);

        let replyDelivery = 'NOT_REQUIRED';
        if (result?.replyInteractive && whatsapp && typeof whatsapp.sendInteractiveList === 'function') {
          try {
            await whatsapp.sendInteractiveList(claimedJob.worker_phone, result.replyInteractive);
            replyDelivery = 'ACCEPTED';
          } catch (sendErr) {
            replyDelivery = sendErr.deliveryState || 'UNKNOWN';
            log('error', 'books_interactive_reply_send_failed', { jobId, deliveryState: replyDelivery });
          }
        } else if (result?.replyText && whatsapp && typeof whatsapp.sendTextMessage === 'function') {
          try {
            await whatsapp.sendTextMessage(claimedJob.worker_phone, result.replyText);
            replyDelivery = 'ACCEPTED';
          } catch (sendErr) {
            replyDelivery = sendErr.deliveryState || 'UNKNOWN';
            log('error', 'books_reply_send_failed', { jobId, deliveryState: replyDelivery });
          }
        }

        if (result?.success) {
          await billStore.completeBillExtraction(jobId, leaseToken, {
            sessionId: result.sessionId,
            state: result.state,
            billId: result.billId,
            replyText: result.replyText,
            replyDelivery,
          });
          log('info', 'books_job_completed', {
            jobId,
            sessionId: result.sessionId,
            state: result.state,
          });
        } else {
          const errMsg = result?.error?.message || result?.replyText || 'EXTRACTION_PROCESSING_FAILED';
          await billStore.failBillExtraction(jobId, leaseToken, { error: errMsg });
          log('warn', 'books_job_processing_failed', { jobId, error: result?.error });
        }
      } catch (err) {
        log('error', 'books_job_unhandled_error', { jobId: claimedJob?.job_id, error: err.message });
        if (claimedJob && leaseToken) {
          try {
            await billStore.failBillExtraction(claimedJob.job_id, leaseToken, { error: err.message });
          } catch {
            /* Safe failure persistence */
          }
        }
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (claimedJob && triggerGate) {
          try {
            triggerGate.finish(claimedJob.message_id);
          } catch {
            /* Safe gate finish */
          }
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
