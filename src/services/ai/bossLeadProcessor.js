'use strict';

const { validateReplyInput } = require('./conversation');
const { validateLeadExtraction, LEAD_FIELDS } = require('./leadExtraction');

const SAFE_CODES = new Set([
  'AI_INPUT_INVALID', 'AI_CONFIGURATION_ERROR', 'AI_AUTHENTICATION_ERROR', 'AI_RATE_LIMIT',
  'AI_TIMEOUT', 'AI_UNAVAILABLE', 'AI_MALFORMED_RESPONSE', 'AI_REQUEST_FAILED',
  'LEAD_EXTRACTION_PERSISTENCE_FAILED', 'MESSAGE_NOT_AUTHORIZED',
]);
const RETRYABLE_CODES = new Set(['AI_RATE_LIMIT', 'AI_TIMEOUT', 'AI_UNAVAILABLE', 'LEAD_EXTRACTION_PERSISTENCE_FAILED']);
const failure = (code) => Object.assign(new Error('Lead extraction could not be completed safely.'), { code });

function createBossLeadProcessor({ store, ai, config, logger, triggerGate }) {
  const active = () => config.enabled && config.aiProvider === 'openai';
  const authorized = (job) => job.authenticated === true && job.message_type === 'text'
    && job.processing_flow === 'conversation' && config.bossSenders?.has(job.sender_phone) === true
    && (!config.allowedSenders.size || config.allowedSenders.has(job.sender_phone));
  function log(level, event, id, details = {}) {
    try { logger?.[level]?.({ event, message_id: id, ...details }); } catch { /* Logging does not control persistence. */ }
  }

  async function processIncomingWhatsAppMessage(job) {
    if (!active()) return;
    const id = job.message_id || job.whatsapp_message_id;
    if (triggerGate && !triggerGate.beginProcessing(id)) {
      log('info', 'ai_trigger_ignored', id, { reason: 'inactive_or_already_processed' });
      return;
    }
    const token = job.lease_token;
    let leaseLost = false;
    let renewal;
    let completionAttempted = false;
    async function assertLease() {
      if (!active() || leaseLost || (triggerGate && !triggerGate.allows(id))) throw failure('LEASE_LOST');
      if (!authorized(job)) throw failure('MESSAGE_NOT_AUTHORIZED');
      if (!(await store.heartbeatLeadExtraction(id, token, config.leaseMs))) throw failure('LEASE_LOST');
      if (triggerGate && !triggerGate.allows(id)) throw failure('LEASE_LOST');
    }
    try {
      if (!authorized(job)) throw failure('MESSAGE_NOT_AUTHORIZED');
      validateReplyInput(job.message_text);
      await assertLease();
      renewal = setInterval(() => {
        store.heartbeatLeadExtraction(id, token, config.leaseMs).then((owned) => { if (!owned) leaseLost = true; })
          .catch(() => { leaseLost = true; });
      }, Math.floor(config.leaseMs / 3));
      renewal.unref();
      log('info', 'boss_lead_extraction_started', id, { attempt: job.attempts });
      const extracted = await ai.extractLeadEnquiry(job.message_text);
      // Revalidate at the persistence boundary, including when the AI service
      // is substituted in tests. The original inbox text is never rewritten.
      const result = validateLeadExtraction(extracted, { originalText: job.message_text });
      await assertLease();
      completionAttempted = true;
      if (!(await store.finishLeadExtraction(id, token, {
        processing_status: result.is_lead ? 'SUCCESS' : 'IRRELEVANT', result,
        error_message: null, processed_at: new Date().toISOString(), next_attempt_at: null,
      }))) throw failure('LEASE_LOST');
      const populated = LEAD_FIELDS.filter((field) => result.lead[field] !== null).length;
      log('info', result.is_lead ? 'boss_lead_extracted' : 'boss_message_not_lead', id, {
        is_lead: result.is_lead, populated_fields: populated, missing_fields: LEAD_FIELDS.length - populated,
      });
    } catch (error) {
      if (error?.code === 'LEASE_LOST' || leaseLost || (triggerGate && !triggerGate.allows(id))) {
        log('warn', 'boss_lead_extraction_lease_lost', id);
        return;
      }
      const code = completionAttempted ? 'LEAD_EXTRACTION_PERSISTENCE_FAILED'
        : SAFE_CODES.has(error?.code) ? error.code : 'AI_REQUEST_FAILED';
      const retry = !triggerGate && RETRYABLE_CODES.has(code) && (completionAttempted || error?.retryable === true)
        && job.attempts < config.maxAttempts;
      const now = Date.now();
      try {
        const persisted = await store.finishLeadExtraction(id, token, {
          processing_status: 'FAILED', result: null, error_message: code,
          processed_at: retry ? null : new Date(now).toISOString(),
          next_attempt_at: retry ? new Date(now + Math.min(300000, 5000 * 2 ** (job.attempts - 1))).toISOString() : null,
        });
        log('error', persisted ? 'boss_lead_extraction_failed' : 'boss_lead_extraction_persistence_failed', id,
          { code, retry_scheduled: persisted && retry });
      } catch {
        // The independent job lease can recover after database availability returns.
        log('error', 'boss_lead_extraction_persistence_failed', id, { code });
      }
    } finally {
      clearInterval(renewal);
      triggerGate?.finish(id);
    }
  }

  return {
    processIncomingWhatsAppMessage,
    // This worker never sends or queues WhatsApp messages, even on failure.
    async processNextReply() { return false; },
  };
}

module.exports = { createBossLeadProcessor };
