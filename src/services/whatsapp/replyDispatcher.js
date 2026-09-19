'use strict';

// Shared outbox delivery keeps the same failure and reconciliation guarantees
// for the fixed reply flow and the preserved lead-processing code.
function createReplyDispatcher({ store, whatsapp, config, logger, replyText = null, processingFlow = null, triggerGate,
  bossReplyQuietMs = 0,
  canSendReply = (reply) => config.allowedSenders.has(reply.sender_phone) }) {
  async function processNextReply() {
    const reply = await store.claimReply({ leaseMs: config.leaseMs,
      ...(bossReplyQuietMs ? { bossReplyQuietMs } : {}),
      ...(triggerGate ? { messageIds: triggerGate.messageIds() } : {}),
      ...(replyText === null ? {} : { replyText }), ...(processingFlow === null ? {} : { processingFlow }) });
    if (!reply) return false;
    try {
      const log = (level, event, details = {}) => {
        // A logging failure must never change an external delivery outcome.
        try { logger[level]({ event, message_id: reply.message_id, reply_id: reply.id, ...details }); } catch { /* Keep the outbox authoritative. */ }
      };
      async function recordFailure(deliveryState) {
        const status = deliveryState === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED';
        let persisted = false;
        try {
          persisted = await store.finishReply(reply.id, reply.lease_token, { status, error_message: deliveryState });
        } catch { /* An expired/unavailable completion cannot authorize another send. */ }
        log('error', persisted ? 'whatsapp_reply_failed' : 'reply_result_persistence_failed', {
          delivery_state: deliveryState, status, persisted,
        });
        if (persisted) {
          await store.appendLog(reply.message_id, 'whatsapp_reply_failed', { status, stage: deliveryState }).catch(() => {});
        }
      }
      if ((triggerGate && !triggerGate.allows(reply.message_id)) || !canSendReply(reply)) {
        log('info', 'whatsapp_reply_ignored', { reason: 'inactive_or_not_authorized' });
        await recordFailure('NOT_ATTEMPTED');
        return true;
      }
      let providerMessageId;
      try {
        const result = await whatsapp.sendTextMessage(reply.sender_phone, reply.text);
        providerMessageId = result.messages[0].id;
      } catch (error) {
        const deliveryState = ['NOT_ATTEMPTED', 'ATTEMPTED_FAILED', 'UNKNOWN'].includes(error?.deliveryState)
          ? error.deliveryState : error?.uncertain === false ? 'ATTEMPTED_FAILED' : 'UNKNOWN';
        await recordFailure(deliveryState);
        return true;
      }
      let persisted = false;
      try {
        persisted = await store.finishReply(reply.id, reply.lease_token, { status: 'SENT', provider_message_id: providerMessageId });
      } catch { /* Preserve the accepted provider ID separately; never repeat the send. */ }
      if (!persisted) {
        let recovered = null;
        try { recovered = await store.recordReplyReconciliation(reply.id, reply.lease_token, providerMessageId); } catch { /* Report evidence below if storage is still unavailable. */ }
        persisted = recovered === 'SENT';
        if (!persisted) {
          log('error', 'whatsapp_reply_reconciliation_required', {
            delivery_state: 'SENT', provider_message_id: providerMessageId,
            completion_persisted: false, reconciliation_persisted: recovered === 'UNKNOWN', reconciliation: true,
          });
          return true;
        }
      }
      log('info', 'whatsapp_reply_sent', { delivery_state: 'SENT', persisted: true });
      await store.appendLog(reply.message_id, 'whatsapp_reply_sent', { status: 'SENT' }).catch(() => {});
      return true;
    } finally {
      triggerGate?.finish(reply.message_id);
    }
  }
  return { processNextReply };
}

module.exports = { createReplyDispatcher };
