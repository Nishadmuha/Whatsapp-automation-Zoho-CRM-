'use strict';
const { validateLead } = require('./leadValidator');
const { successReply, missingInformationReply, failureReply } = require('./replyFormatter');
const { maskPhone } = require('../../utils/logger');
const { createReplyDispatcher } = require('../whatsapp/replyDispatcher');

function safeFailure(code) {
  return Object.assign(new Error('Processing could not be completed safely.'), { code });
}
function contactKeys(lead) {
  return [lead.phone && 'phone:' + lead.phone, lead.email && 'email:' + lead.email.toLowerCase()].filter(Boolean).sort();
}
function createLeadProcessor({ store, ai, zoho, whatsapp, config, logger }) {
  async function processIncomingWhatsAppMessage(job) {
    const id = job.whatsapp_message_id;
    const token = job.lease_token;
    let leaseLost = false;
    let wrote = job.crm_write_started;
    let crmId = job.zoho_lead_id;
    let action = job.crm_action;
    let checkpointed = Boolean(job.zoho_lead_id);
    async function audit(event, details = {}) {
      try { await store.appendLog(id, event, details); } catch {
        logger.error({ event: 'audit_log_persistence_failed', message_id: id });
      }
    }
    const renewal = setInterval(() => {
      store.heartbeat(id, token, config.leaseMs).then((owned) => { if (!owned) leaseLost = true; })
        .catch(() => { leaseLost = true; });
    }, Math.floor(config.leaseMs / 3));
    renewal.unref();
    async function assertLease() {
      if (leaseLost || !(await store.heartbeat(id, token, config.leaseMs))) throw safeFailure('LEASE_LOST');
    }
    async function mark(patch) {
      if (!(await store.mark(id, token, patch))) throw safeFailure('LEASE_LOST');
    }
    async function lockAll(keys, fn, asserts = []) {
      if (!keys.length) return fn(async () => {
        await assertLease();
        for (const assertOwned of asserts) await assertOwned();
      });
      return store.withContactLock(keys[0], ({ assertOwned }) => lockAll(keys.slice(1), fn, [...asserts, assertOwned]));
    }
    try {
      logger.info({ event: 'processing_started', message_id: id, sender: maskPhone(job.sender_phone) });
      await audit('processing_started', { attempt: job.attempts });
      if (!job.authenticated || !config.allowedSenders.has(job.sender_phone)) {
        await mark({ processing_status: 'FAILED', error_message: 'Sender or webhook authentication is not authorized.', processed_at: new Date().toISOString(), next_attempt_at: null });
        return;
      }
      let raw = job.extracted_lead_data;
      if (!raw) {
        await audit('extraction_started');
        raw = await ai.extractLead(job.message_text);
        await mark({ extracted_lead_data: raw });
        await audit('extraction_succeeded');
      }
      const validation = validateLead(raw, { originalText: job.message_text });
      if (!validation.valid) {
        const done = await store.completeWithReply(id, token, {
          processing_status: 'NEEDS_INFORMATION', extracted_lead_data: validation.lead,
          error_message: 'Required customer information is missing or invalid.', processed_at: new Date().toISOString(),
        }, missingInformationReply(validation));
        if (!done) throw safeFailure('LEASE_LOST');
        logger.info({ event: 'processing_needs_information', message_id: id });
        await audit('needs_information');
        return;
      }
      const lead = validation.lead;
      await mark({ extracted_lead_data: lead });
      if (!crmId) {
        const keys = contactKeys(lead);
        await lockAll(keys, async (assertOwned) => {
          await assertOwned();
          const states = await Promise.all(keys.map((key) => store.getContactState(key)));
          // A crash/timeout cannot establish whether an external write committed.
          // Keep the contact blocked until an administrator reconciles it.
          if (wrote || states.some((state) => state?.uncertain)) throw safeFailure('CRM_RECONCILIATION_REQUIRED');
          const ids = new Set(states.map((state) => state?.zoho_lead_id).filter(Boolean));
          const matches = [];
          await audit('zoho_search');
          if (lead.phone) matches.push(await zoho.searchLeadByPhone(lead.phone));
          if (lead.email) matches.push(await zoho.searchLeadByEmail(lead.email));
          for (const match of matches) if (match?.id) ids.add(match.id);
          if (ids.size > 1) throw safeFailure('CRM_CONFLICT');
          const existingId = [...ids][0];
          await assertOwned();
          // Mark the shared contact first. A crash in this gap favors review over duplicate creation.
          for (const key of keys) await store.beginContactWrite(key);
          await mark({ crm_write_started: true });
          wrote = true;
          action = existingId ? 'updated' : 'created';
          await audit(action === 'created' ? 'zoho_create_started' : 'zoho_update_started');
          const result = existingId
            ? await zoho.updateLead(existingId, lead, job.message_text)
            : await zoho.createLead(lead, job.message_text);
          if (typeof result?.id !== 'string' || !/^\d{1,40}$/.test(result.id)) throw safeFailure('CRM_RECONCILIATION_REQUIRED');
          await assertOwned();
          crmId = result.id;
          if (!(await store.saveCrmResult(id, token, { zohoId: crmId, action, contactKeys: keys }))) throw safeFailure('LEASE_LOST');
          checkpointed = true;
          await audit('crm_result_saved', { action });
        });
      }
      const done = await store.completeWithReply(id, token, {
        processing_status: 'SUCCESS', error_message: null, processed_at: new Date().toISOString(),
      }, successReply(lead, action));
      if (!done) throw safeFailure('LEASE_LOST');
      logger.info({ event: 'processing_success', message_id: id, action });
      await audit('processing_success', { action });
    } catch (error) {
      const code = error?.code;
      if (code === 'LEASE_LOST' || leaseLost) {
        logger.warn({ event: 'processing_lease_lost', message_id: id });
        return;
      }
      if (checkpointed) {
        // Retry local finalization only: the CRM ID was committed before this failure.
        await store.mark(id, token, {
          processing_status: 'FAILED', error_message: 'CRM saved; awaiting local completion.',
          next_attempt_at: new Date(Date.now() + 5000).toISOString(), processed_at: null,
        }).catch(() => {});
        logger.error({ event: 'completion_retry_scheduled', message_id: id });
        await audit('completion_retry_scheduled');
        return;
      }
      const reconciliation = wrote || code === 'CRM_RECONCILIATION_REQUIRED' || code === 'CRM_CONFLICT' || error?.uncertain === true;
      const retryable = !reconciliation && (error?.retryable === true || code === 'AI_EXTRACTION_FAILED');
      const retry = retryable && job.attempts < config.maxAttempts;
      const patch = {
        processing_status: 'FAILED',
        error_message: reconciliation ? 'CRM reconciliation required; automatic writes paused for this contact.' : 'Lead processing failed. Check provider configuration and structured logs.',
        processed_at: retry ? null : new Date().toISOString(),
        next_attempt_at: retry ? new Date(Date.now() + Math.min(300000, 5000 * 2 ** (job.attempts - 1))).toISOString() : null,
      };
      try {
        if (retry) await store.mark(id, token, patch);
        else await store.completeWithReply(id, token, patch, failureReply(reconciliation));
      } catch {
        // The expired PROCESSING lease is recoverable after database availability returns.
        logger.error({ event: 'processing_result_persistence_failed', message_id: id });
      }
      const safeCode = new Set(['AI_EXTRACTION_FAILED', 'AI_CONFIGURATION_ERROR', 'CRM_RECONCILIATION_REQUIRED', 'CRM_CONFLICT', 'CONTACT_LOCK_TIMEOUT', 'CONTACT_LOCK_LOST', 'ZOHO_AMBIGUOUS_MATCH', 'ZOHO_AUTH', 'ZOHO_RATE_LIMIT', 'ZOHO_INPUT', 'ZOHO_CONFIG']).has(code) ? code : 'PROCESSING_FAILED';
      logger.error({ event: 'processing_failed', message_id: id, code: safeCode, retry_scheduled: retry, reconciliation });
      await audit('processing_failed', { code: safeCode, retry_scheduled: retry, reconciliation });
    } finally {
      clearInterval(renewal);
    }
  }

  const { processNextReply } = createReplyDispatcher({ store, whatsapp, config, logger });
  return { processIncomingWhatsAppMessage, processNextReply };
}
module.exports = { createLeadProcessor, contactKeys };
