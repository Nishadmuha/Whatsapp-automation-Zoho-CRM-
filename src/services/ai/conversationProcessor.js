'use strict';

const { validateReplyInput, validateReplyOutput, isContactNumberRequest, getBossContactReply } = require('./conversation');
const { createReplyDispatcher } = require('../whatsapp/replyDispatcher');

const SAFE_CODES = new Set([
  'AI_INPUT_INVALID', 'AI_CONFIGURATION_ERROR', 'AI_AUTHENTICATION_ERROR', 'AI_RATE_LIMIT',
  'AI_TIMEOUT', 'AI_UNAVAILABLE', 'AI_MALFORMED_RESPONSE', 'AI_REQUEST_FAILED',
  'AI_RESULT_PERSISTENCE_FAILED', 'MESSAGE_NOT_AUTHORIZED', 'CUSTOMER_SERVICE_WINDOW_EXPIRED',
]);
const RETRYABLE_CODES = new Set(['AI_RATE_LIMIT', 'AI_TIMEOUT', 'AI_UNAVAILABLE', 'AI_RESULT_PERSISTENCE_FAILED']);
const REPLY_WINDOW_MS = 23 * 60 * 60 * 1000;
const failure = (code) => Object.assign(new Error('Conversation processing could not be completed.'), { code });

function createConversationProcessor({ store, ai, whatsapp, config, logger, triggerGate }) {
  const active = () => config.enabled && config.aiProvider === 'openai';
  const authorized = (message) => message.authenticated === true && message.message_type === 'text'
    && message.processing_flow === 'conversation'
    && (!config.allowedSenders.size || config.allowedSenders.has(message.sender_phone));
  function log(level, event, id, details = {}) {
    try { logger?.[level]?.({ event, message_id: id, ...details }); } catch { /* Logs cannot change job outcomes. */ }
  }

  async function processIncomingWhatsAppMessage(job) {
    if (!active()) return;
    const id = job.whatsapp_message_id;
    if (triggerGate && !triggerGate.beginProcessing(id)) {
      log('info', 'ai_trigger_ignored', id, { reason: 'inactive_or_already_processed' });
      return;
    }
    const token = job.lease_token;
    let leaseLost = false;
    let renewal;
    let completionAttempted = false;
    async function assertLease() {
      if (leaseLost || !active() || (triggerGate && !triggerGate.allows(id)) || !(await store.heartbeat(id, token, config.leaseMs))) {
        throw failure('LEASE_LOST');
      }
      if (triggerGate && !triggerGate.allows(id)) throw failure('LEASE_LOST');
    }
    try {
      if (!authorized(job)) throw failure('MESSAGE_NOT_AUTHORIZED');
      const receivedAt = Date.parse(job.received_at);
      if (!Number.isFinite(receivedAt) || receivedAt <= Date.now() - REPLY_WINDOW_MS) {
        throw failure('CUSTOMER_SERVICE_WINDOW_EXPIRED');
      }
      validateReplyInput(job.message_text);
      await assertLease();
      renewal = setInterval(() => {
        store.heartbeat(id, token, config.leaseMs).then((owned) => { if (!owned) leaseLost = true; })
          .catch(() => { leaseLost = true; });
      }, Math.floor(config.leaseMs / 3));
      renewal.unref();
      let reply;
      const bossPhone = (config.bossSenders && config.bossSenders.size)
        ? [...config.bossSenders][0]
        : (process.env.AUTHORIZED_BOSS_PHONES || process.env.BOSS_SENDER_PHONES || '+971502420957');

      const isBooksWorker = config.booksSenders?.has(job.sender_phone) === true;
      if (isBooksWorker) {
        reply = 'Please send the bill image or document.';
      } else if (isContactNumberRequest(job.message_text)) {
        log('info', 'ai_contact_reply_direct', id);
        reply = validateReplyOutput(getBossContactReply(bossPhone));
      } else {
        log('info', 'ai_reply_processing_started', id, { attempt: job.attempts });
        reply = validateReplyOutput(await ai.generateReply(job.message_text));
      }
      await assertLease();
      completionAttempted = true;
      // A generated response and terminal inbox state commit in one transaction.
      // Sending is always a separate, leased outbox operation.
      if (!(await store.completeWithReply(id, token, {
        processing_status: 'SUCCESS', error_message: null, processed_at: new Date().toISOString(), next_attempt_at: null,
      }, reply))) throw failure('LEASE_LOST');
      log('info', 'ai_reply_queued', id);
      await store.appendLog(id, 'ai_reply_queued', { provider: 'openai' }).catch(() => {});
    } catch (error) {
      if (error?.code === 'LEASE_LOST' || leaseLost || (triggerGate && !triggerGate.allows(id))) {
        log('warn', 'ai_reply_lease_lost', id);
        return;
      }
      const code = completionAttempted ? 'AI_RESULT_PERSISTENCE_FAILED'
        : SAFE_CODES.has(error?.code) ? error.code : 'AI_REQUEST_FAILED';
      const retry = !triggerGate && RETRYABLE_CODES.has(code) && (completionAttempted || error?.retryable === true)
        && job.attempts < config.maxAttempts;
      const now = Date.now();
      try {
        const persisted = await store.mark(id, token, {
          processing_status: 'FAILED', error_message: code,
          processed_at: retry ? null : new Date(now).toISOString(),
          next_attempt_at: retry ? new Date(now + Math.min(300000, 5000 * 2 ** (job.attempts - 1))).toISOString() : null,
        });
        log('error', persisted ? 'ai_reply_processing_failed' : 'ai_reply_result_persistence_failed', id,
          { code, retry_scheduled: persisted && retry });
        if (persisted) await store.appendLog(id, 'ai_reply_processing_failed', { code, retry_scheduled: retry }).catch(() => {});
        if (persisted && !retry) triggerGate?.finish(id);
      } catch {
        // Database lease expiry makes unfinished work recoverable, with bounded attempts.
        log('error', 'ai_reply_result_persistence_failed', id, { code });
      }
    } finally {
      clearInterval(renewal);
    }
  }

  const dispatcher = createReplyDispatcher({
    store, whatsapp, config, logger, triggerGate, processingFlow: 'conversation',
    canSendReply(reply) {
      if (!active() || !authorized(reply)) return false;
      try { return validateReplyOutput(reply.text) === reply.text; } catch { return false; }
    },
  });
  return {
    processIncomingWhatsAppMessage,
    async processNextReply() {
      if (!active()) return false;
      return dispatcher.processNextReply();
    },
  };
}

module.exports = { createConversationProcessor };
