'use strict';

const { createLeadService } = require('./leadService');
const { validateReplyOutput } = require('../ai/conversation');
const { createReplyDispatcher } = require('../whatsapp/replyDispatcher');
const {
  conversationIntent,
  buildZohoLeadUrl,
  formatBossFinalSuccessMessage,
  formatBossZohoFailureMessage,
} = require('./bossConversation');

const SAFE_CODES = new Set([
  'AI_INPUT_INVALID', 'AI_CONFIGURATION_ERROR', 'AI_AUTHENTICATION_ERROR', 'AI_RATE_LIMIT',
  'AI_TIMEOUT', 'AI_UNAVAILABLE', 'AI_MALFORMED_RESPONSE', 'AI_REQUEST_FAILED',
  'LEAD_VALIDATION_FAILED', 'LEAD_WORKFLOW_PERSISTENCE_FAILED', 'MESSAGE_NOT_AUTHORIZED',
]);
const RETRYABLE_CODES = new Set(['AI_RATE_LIMIT', 'AI_TIMEOUT', 'AI_UNAVAILABLE', 'LEAD_WORKFLOW_PERSISTENCE_FAILED']);
const FAILURE_REPLIES = Object.freeze({
  extraction: 'I could not extract the lead details. Please resend the available information.',
  schema: 'I could not validate the extracted lead details. Please resend the available information.',
  validation: 'I could not validate the lead details. Please resend the available information.',
  persistence: 'I could not complete saving this lead. Please try again later.',
});
const failure = code => Object.assign(new Error('Lead processing could not be completed safely.'), { code });

async function handleZohoSync({ leadId, store, zoho, config, logger, messageId, force = false, whatsapp = null }) {
  const lead = await store.getLead(leadId);
  if (!lead) return { success: false, error: 'Lead not found' };
  if (!lead.attachments?.length && typeof store.getLeadAttachments === 'function') {
    try { lead.attachments = await store.getLeadAttachments(leadId); }
    catch { return { success: false, error: 'Attachment metadata could not be loaded' }; }
  }
  if (!force && lead.zoho_status === 'saved' && lead.zoho_lead_id && !(lead.attachments || []).some(att =>
    (att.zohoUploadStatus || att.zoho_upload_status) !== 'uploaded' || !att.zohoAttachmentId || att.zohoAttachmentId === 'attached'
      || String(att.zohoLeadId) !== String(lead.zoho_lead_id))) {
    logger?.info?.({ event: 'zoho_already_saved', lead_id: leadId });
    const zohoUrl = lead.zoho_url || lead.zohoUrl || buildZohoLeadUrl(lead.zoho_lead_id);
    if (messageId) {
      const successReply = formatBossFinalSuccessMessage({
        contact: lead.contact_name || lead.contactName,
        company: lead.company_name || lead.companyName,
        phone: lead.phone,
        email: lead.email,
        zohoLeadId: lead.zoho_lead_id,
        zohoUrl,
        attachments: lead.attachments || [],
      });
      await store.updateReplyText(messageId, successReply);
    }
    return { success: true, zohoLeadId: lead.zoho_lead_id, zohoUrl };
  }
  if (!force && lead.zoho_status === 'creating') {
    logger?.info?.({ event: 'zoho_sync_in_progress', lead_id: leadId });
    return { success: false, error: 'Sync in progress' };
  }

  let zohoClient = zoho;
  if (!zohoClient && (process.env.ZOHO_CLIENT_ID || config?.zohoClientId)) {
    if (process.env.NODE_ENV !== 'test' || config?.enableZohoInTest || config?.zohoClientId) {
      try {
        const { createZohoLeadService } = require('../zoho/zohoLeadService');
        zohoClient = createZohoLeadService({ env: process.env, logger });
      } catch { zohoClient = null; }
    }
  }

  if (!zohoClient) {
    logger?.info?.({ event: 'zoho_sync_skipped_not_configured', lead_id: leadId });
    if (process.env.NODE_ENV !== 'test' && messageId) {
      const leadTitle = lead.contact_name || lead.contactName || lead.company_name || lead.companyName || 'Customer';
      const failureReply = formatBossZohoFailureMessage({
        leadName: leadTitle,
        leadId,
        status: 'Pending',
      });
      await store.updateReplyText(messageId, failureReply);
    }
    return { success: false, error: 'Zoho not configured' };
  }

  await store.updateLeadZohoStatus(leadId, { zohoStatus: 'creating' });

  try {
    if (typeof zohoClient.verifyAuthentication === 'function') {
      await zohoClient.verifyAuthentication();
    }

    const extraNotes = [
      lead.project_name ? `Project: ${lead.project_name}` : null,
      lead.quantity ? `Qty: ${lead.quantity}` : null,
      lead.deadline ? `Timeline: ${lead.deadline}` : null,
      lead.trn_no ? `TRN: ${lead.trn_no}` : null,
      lead.notes,
    ].filter(Boolean).join(' | ');

    const leadData = {
      name: lead.contact_name || lead.contactName || lead.company_name || lead.companyName || 'Customer',
      company: lead.company_name || lead.companyName || lead.contact_name || lead.contactName || 'Individual',
      phone: lead.phone,
      email: lead.email,
      location: lead.project_location || lead.projectLocation || lead.address,
      service: lead.product_or_service || lead.productOrService,
      requirement: lead.requirement,
      notes: extraNotes || lead.notes || undefined,
    };

    let writeResult;
    if (lead.zoho_lead_id) {
      writeResult = await zohoClient.updateLead(lead.zoho_lead_id, leadData, lead.original_message || lead.originalMessage);
    } else {
      let existing = null;
      if (lead.phone) {
        existing = await zohoClient.searchLeadByPhone(lead.phone);
      }
      if (!existing && lead.email) {
        existing = await zohoClient.searchLeadByEmail(lead.email);
      }

      if (existing?.id) {
        writeResult = await zohoClient.updateLead(existing.id, leadData, lead.original_message || lead.originalMessage);
      } else {
        writeResult = await zohoClient.createLead(leadData, lead.original_message || lead.originalMessage);
      }
    }

    const zohoLeadId = writeResult?.id || (writeResult && typeof writeResult === 'object' && writeResult.id) || lead.zoho_lead_id;
    if (!zohoLeadId) {
      throw new Error('Zoho API did not return a valid Lead ID');
    }

    const zohoUrl = buildZohoLeadUrl(zohoLeadId);
    const nowIso = new Date().toISOString();
    // Retain the exact returned ID even when an attachment or later step fails.
    await store.updateLeadZohoStatus(leadId, { zohoStatus: 'creating', zohoLeadId, zohoUrl });

    // Upload any original image/voice attachments to the created/updated Zoho lead
    let attachments = Array.isArray(lead.attachments) ? [...lead.attachments] : [];
    if (typeof store.getLeadAttachments === 'function' && attachments.length === 0) {
      try {
        attachments = await store.getLeadAttachments(leadId);
      } catch { /* best effort */ }
    }

    if (attachments.length > 0 && typeof zohoClient.uploadLeadAttachment === 'function') {
      for (const att of attachments) {
        // Idempotency: skip if already uploaded to Zoho
        if ((att.zohoUploadStatus === 'uploaded' || att.zoho_upload_status === 'uploaded') &&
            att.zohoAttachmentId && att.zohoAttachmentId !== 'attached' && String(att.zohoLeadId) === String(zohoLeadId)) {
          continue;
        }

        try {
          let buffer = null;
          let mimeType = att.mimeType || att.mime_type || 'application/octet-stream';
          let storageRef = att.storageReference || att.storage_reference;
          if (storageRef && typeof storageRef === 'object') {
            storageRef = storageRef.storageReference || storageRef.storage_reference || null;
          }

          if (storageRef && typeof store.getMediaFile === 'function') {
            const stored = await store.getMediaFile(storageRef);
            buffer = Buffer.isBuffer(stored) ? stored : (stored?.buffer || null);
            if (stored?.mimeType) mimeType = stored.mimeType;
          }

          const mediaId = att.mediaId || att.whatsapp_media_id || att.whatsappMediaId;
          if (!buffer && mediaId && typeof store.getMediaFileByMediaId === 'function') {
            const storedByMedia = await store.getMediaFileByMediaId(mediaId);
            buffer = Buffer.isBuffer(storedByMedia) ? storedByMedia : (storedByMedia?.buffer || null);
            if (storedByMedia?.mimeType) mimeType = storedByMedia.mimeType;
          }

          if (!buffer && mediaId && whatsapp?.downloadMedia) {
            const downloaded = await whatsapp.downloadMedia(mediaId).catch(() => null);
            buffer = downloaded?.buffer || null;
            if (downloaded?.mimeType) mimeType = downloaded.mimeType;
            if (buffer && typeof store.saveMediaFile === 'function') {
              const saved = await store.saveMediaFile({
                messageId: att.messageId || att.whatsappMessageId || att.message_id,
                mediaId,
                buffer,
                mimeType,
                filename: att.filename,
              });
              if (saved) {
                const cleanRef = typeof saved === 'object' && saved.storageReference ? saved.storageReference : String(saved);
                att.storageReference = cleanRef;
                att.storageUrl = `/api/media/${cleanRef}`;
                att.storage_reference = cleanRef;
                att.storage_url = `/api/media/${cleanRef}`;
              }
            }
          }

          if (buffer) {
            let filename = att.filename || att.mediaFilename || att.media_filename;
            if (!filename) {
              const ext = mimeType?.split('/')[1]?.replace(/^jpeg$/, 'jpg')?.replace(/^x-/, '') || 'bin';
              filename = `attachment_${mediaId || Date.now()}.${ext}`;
            }

            const uploadRes = await zohoClient.uploadLeadAttachment(zohoLeadId, {
              buffer,
              filename,
              mimeType,
            });

            if (!uploadRes?.id || uploadRes.id === 'attached') throw new Error('Attachment upload returned no attachment ID');
            att.zohoLeadId = zohoLeadId;
            att.zohoAttachmentId = uploadRes.id;
            att.zohoUploadStatus = 'uploaded';
            att.zoho_upload_status = 'uploaded';
            att.uploadedAt = new Date().toISOString();
            att.zohoError = null;
            att.zoho_error = null;
          } else {
            att.zohoUploadStatus = 'failed';
            att.zoho_upload_status = 'failed';
            att.zohoError = 'Media file buffer not found';
            att.zoho_error = 'Media file buffer not found';
          }
        } catch (uploadErr) {
          const providerCode = uploadErr?.providerCode || null;
          const httpStatus = uploadErr?.httpStatus || null;
          const safeErr = providerCode
            ? `Zoho rejected upload (${providerCode}${httpStatus ? ` - HTTP ${httpStatus}` : ''})`
            : (uploadErr?.message || 'Attachment upload failed');

          logger?.warn?.({
            event: 'zoho_attachment_upload_failed',
            lead_id: leadId,
            zoho_lead_id: zohoLeadId,
            local_media_id: att.mediaId || att.whatsapp_media_id,
            filename: att.filename,
            mime_type: att.mimeType,
            provider_code: providerCode,
            http_status: httpStatus,
            error: safeErr,
          });
          att.zohoUploadStatus = 'failed';
          att.zoho_upload_status = 'failed';
          att.zohoError = safeErr;
          att.zoho_error = safeErr;
        }
      }

      if (typeof store.updateLeadAttachments === 'function') {
        await store.updateLeadAttachments(leadId, attachments);
      }
    }

    if (attachments.some(att => (att.zohoUploadStatus || att.zoho_upload_status) !== 'uploaded'
        || !att.zohoAttachmentId || att.zohoAttachmentId === 'attached' || String(att.zohoLeadId) !== String(zohoLeadId))) {
      await store.updateLeadZohoStatus(leadId, { zohoStatus: 'failed', zohoLeadId, zohoUrl, errorCode: 'ATTACHMENT_UPLOAD_INCOMPLETE', errorStage: 'attachment' });
      if (messageId) await store.updateReplyText(messageId, `Lead saved in Zoho CRM (ID: ${zohoLeadId}), but one or more attachments failed to upload. The original files are retained for retry.\n${zohoUrl}`);
      return { success: false, zohoLeadId, zohoUrl, attachments, error: 'ATTACHMENT_UPLOAD_INCOMPLETE' };
    }
    await store.updateLeadZohoStatus(leadId, {
      zohoStatus: 'saved',
      zohoLeadId,
      zohoUrl,
      zohoSyncedAt: nowIso,
      errorCode: null,
      errorStage: null,
    });

    logger?.info?.({ event: 'zoho_sync_success', lead_id: leadId, zoho_lead_id: zohoLeadId, zoho_url: zohoUrl });

    if (messageId) {
      const successReply = formatBossFinalSuccessMessage({
        contact: lead.contact_name || lead.contactName,
        company: lead.company_name || lead.companyName,
        phone: lead.phone,
        email: lead.email,
        zohoLeadId,
        zohoUrl,
        attachments,
      });
      await store.updateReplyText(messageId, successReply);
    }
    return { success: true, zohoLeadId, zohoUrl, attachments };
  } catch (error) {
    const errorCode = error?.code || 'ZOHO_SYNC_FAILED';
    await store.updateLeadZohoStatus(leadId, {
      zohoStatus: 'failed',
      errorCode,
      errorStage: 'zoho',
    });
    logger?.error?.({ event: 'zoho_sync_failed', lead_id: leadId, error: error?.message, code: errorCode });
    if (messageId) {
      const leadTitle = lead.contact_name || lead.contactName || lead.company_name || lead.companyName || 'Customer';
      const failureReply = formatBossZohoFailureMessage({
        leadName: leadTitle,
        leadId,
        status: 'Failed/Pending',
      });
      await store.updateReplyText(messageId, failureReply);
    }
    return { success: false, error: error?.message || errorCode };
  }
}

function createBossLeadWorkflow({ store, ai, whatsapp, config, logger, triggerGate, zoho }) {
  const pendingZohoReplies = new Set();
  const service = createLeadService({ store, ai, config, resolveMessageContent: async (job, { assertLease }) => {
    if (job.batch_unreadable) throw new Error('Unreadable media batch.');
    const { resolveLeadMessageContent } = require('./leadMedia');
    return resolveLeadMessageContent({ message: job, whatsapp, ai, assertActive: assertLease, store, logger });
  } });
  const active = () => config.enabled && config.aiProvider === 'openai';
  const authorized = job => job.authenticated === true
    && job.processing_flow === 'boss_lead' && config.bossSenders?.has(job.sender_phone) === true
    && (!config.allowedSenders.size || config.allowedSenders.has(job.sender_phone));
  function log(level, event, id, details = {}) {
    try { logger?.[level]?.({ event, message_id: id, ...details }); } catch { /* Persistence remains authoritative. */ }
  }

  async function processIncomingWhatsAppMessage(job) {
    if (!active()) return;
    let batchItems = job.batch_items || [job];
    const anchorClaim = batchItems.at(-1);
    const id = anchorClaim.message_id || anchorClaim.whatsapp_message_id;
    const processingStartedAt = Date.now();
    const receivedTimes = batchItems.map(item => Date.parse(item.received_at || '')).filter(Number.isFinite);
    log('info', 'boss_batch_finalized', id, {
      batch_size: batchItems.length,
      ...(receivedTimes.length ? { duration_ms: Math.max(0, processingStartedAt - Math.min(...receivedTimes)) } : {}),
    });
    if (triggerGate && !batchItems.every(item => {
      const itemId = item.message_id || item.whatsapp_message_id;
      const started = triggerGate.beginProcessing(itemId);
      return started;
    })) {
      log('info', 'ai_trigger_ignored', id, { reason: 'inactive_or_already_processed' });
      return;
    }
    let token = anchorClaim.lease_token;
    let leaseLost = false;
    let renewal;
    async function renewLease() {
      try {
        const renewed = await Promise.all(batchItems.map(item =>
          store.heartbeatLeadExtraction(item.message_id || item.whatsapp_message_id, item.lease_token, config.leaseMs)));
        if (renewed.some(value => !value)) leaseLost = true;
      } catch { leaseLost = true; }
    }
    async function assertLease() {
      if (!active() || leaseLost || (triggerGate && batchItems.some(item => !triggerGate.allows(item.message_id || item.whatsapp_message_id)))) throw failure('LEASE_LOST');
      if (batchItems.some(item => !authorized(item))) throw failure('MESSAGE_NOT_AUTHORIZED');
      await renewLease();
      if (leaseLost || !active() || (triggerGate && batchItems.some(item => !triggerGate.allows(item.message_id || item.whatsapp_message_id)))) throw failure('LEASE_LOST');
      if (batchItems.some(item => !authorized(item))) throw failure('MESSAGE_NOT_AUTHORIZED');
    }
    try {
      if (batchItems.some(item => !authorized(item))) throw failure('MESSAGE_NOT_AUTHORIZED');
      let executionTokens;
      try {
        executionTokens = await Promise.all(batchItems.map(item => store.beginLeadExtractionProcessing(
          item.message_id || item.whatsapp_message_id, item.lease_token, config.leaseMs)));
      }
      catch { throw Object.assign(failure('LEAD_WORKFLOW_PERSISTENCE_FAILED'), { retryable: true }); }
      if (executionTokens.some(value => !value)) throw failure('LEASE_LOST');
      batchItems = batchItems.map((item, index) => ({ ...item, lease_token: executionTokens[index] }));
      const anchor = batchItems.at(-1);
      token = anchor.lease_token;
      // Keep the caller's claim unchanged so replaying that same object cannot
      // inherit this invocation's exclusive execution token.
      job = { ...anchor, lease_token: token };
      await assertLease();
      renewal = setInterval(() => { void renewLease(); }, Math.max(1, Math.floor(config.leaseMs / 3)));
      renewal.unref();
      log('info', 'boss_lead_processing_started', id, { attempt: job.attempts, batch_size: batchItems.length });

      let failedMessageIds = [];
      if (batchItems.length > 1) {
        const { resolveLeadMessageContent } = require('./leadMedia');
        const settled = await Promise.allSettled(batchItems.map(async item => {
          if (item.message_type === 'text') return { text: item.message_text || '' };
          const content = await resolveLeadMessageContent({ message: item, whatsapp, ai, assertActive: assertLease, store, logger });
          const media = {
            transcription: content.transcription ?? (item.message_type === 'audio' ? content.text : null),
            extractedText: content.extractedText ?? (item.message_type === 'audio' ? null : content.text),
            storageReference: content.storageReference ?? item.storage_reference ?? null,
            storageUrl: content.storageUrl ?? item.storage_url ?? null,
          };
          if (!(await store.checkpointLeadMedia(item.message_id || item.whatsapp_message_id, item.lease_token, media))) {
            throw failure('LEASE_LOST');
          }
          return { text: content.text };
        }));
        const chunks = [];
        for (let index = 0; index < settled.length; index += 1) {
          const outcome = settled[index];
          if (outcome.status === 'fulfilled' && outcome.value.text?.trim()) chunks.push(outcome.value.text.trim());
          else {
            const failedItem = batchItems[index];
            failedMessageIds.push(failedItem.message_id || failedItem.whatsapp_message_id);
            if (failedItem.message_text?.trim()) chunks.push(failedItem.message_text.trim());
          }
        }
        job = chunks.length
          ? { ...job, message_type: 'text', message_text: chunks.join('\n') }
          : { ...job, batch_unreadable: true };
      }

      const defersUntilZohoFinalization = job.message_type === 'text'
        && conversationIntent(job.message_text || '') === 'confirmation';
      if (defersUntilZohoFinalization) pendingZohoReplies.add(id);
      const { result, validation, state, kind, leadId } = await service.saveIncomingLead(job, { assertLease, maxAttempts: triggerGate ? 1 : config.maxAttempts });
      log('info', 'boss_reply_queued', id, {
        stage: state === 'awaiting_confirmation' ? 'confirmation' : 'processing',
        duration_ms: Math.max(0, Date.now() - processingStartedAt),
        batch_size: batchItems.length,
      });
      const siblingItems = batchItems.slice(0, -1).map(item => ({
        messageId: item.message_id || item.whatsapp_message_id,
        leaseToken: item.lease_token,
      }));
      if (siblingItems.length) {
        const session = await store.getActiveLeadSession(job.sender_phone);
        await store.completeLeadBatchMembers(siblingItems, {
          result, state, kind, sessionId: session?.id || null,
          failedMessageIds: failedMessageIds.filter(failedId => failedId !== id),
        });
        for (const sibling of siblingItems) triggerGate?.finish(sibling.messageId);
      }
      log('info', state === 'completed' ? 'boss_lead_saved' : 'boss_conversation_processed', id, {
        is_lead: result.is_lead, session_state: state, message_kind: kind,
        batch_size: batchItems.length,
        validation_status: result.is_lead ? validation.valid ? 'valid' : 'incomplete' : 'invalid',
      });
      if (state === 'completed' && kind === 'confirmation' && leadId) {
        await handleZohoSync({ leadId, store, zoho, config, logger, messageId: id, whatsapp });
      }
    } catch (error) {
      if (error?.code === 'LEASE_LOST' || leaseLost || !active() || (triggerGate && !triggerGate.allows(id))) {
        log('warn', 'boss_lead_workflow_lease_lost', id);
        return;
      }
      const code = !authorized(job) ? 'MESSAGE_NOT_AUTHORIZED'
        : SAFE_CODES.has(error?.code) ? error.code : 'AI_REQUEST_FAILED';
      const stage = code === 'MESSAGE_NOT_AUTHORIZED' ? 'validation'
        : code === 'AI_MALFORMED_RESPONSE' ? 'schema'
          : code === 'LEAD_WORKFLOW_PERSISTENCE_FAILED' ? 'persistence'
            : code === 'LEAD_VALIDATION_FAILED' ? 'validation' : 'extraction';
      const retry = !triggerGate && RETRYABLE_CODES.has(code) && error?.retryable === true && job.attempts < config.maxAttempts;
      const nextAttemptAt = retry
        ? new Date(Date.now() + Math.min(300000, 5000 * 2 ** (Math.max(1, job.attempts) - 1))).toISOString() : null;
      try {
        const persisted = await store.failLeadWorkflow(id, token, {
          code, stage, nextAttemptAt,
          replyText: !retry && authorized(job) && active() ? FAILURE_REPLIES[stage] : null,
        });
        log('error', persisted ? 'boss_lead_workflow_failed' : 'boss_lead_failure_persistence_failed', id,
          { code, stage, retry_scheduled: persisted && retry });
        const siblings = batchItems.slice(0, -1).map(item => ({
          messageId: item.message_id || item.whatsapp_message_id, leaseToken: item.lease_token,
        }));
        if (siblings.length) {
          await store.completeLeadBatchMembers(siblings, {
            state: 'collecting', kind: 'details', failedMessageIds: siblings.map(item => item.messageId),
          });
          for (const sibling of siblings) triggerGate?.finish(sibling.messageId);
        }
      } catch {
        // A live lease remains recoverable when the database returns. No
        // confirmation can be sent without an atomic durable outbox write.
        log('error', 'boss_lead_failure_persistence_failed', id, { code, stage });
      }
    } finally {
      clearInterval(renewal);
      pendingZohoReplies.delete(id);
    }
  }

  const dispatcher = createReplyDispatcher({
    store, whatsapp, config, logger, triggerGate, processingFlow: 'boss_lead',
    bossReplyQuietMs: config.bossReplyQuietMs ?? 0,
    shouldDeferReply: messageId => pendingZohoReplies.has(messageId),
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

module.exports = { createBossLeadWorkflow, handleZohoSync };
