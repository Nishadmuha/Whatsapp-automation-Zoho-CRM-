'use strict';

const { createLeadExtractor } = require('./leadExtractor');
const { validateLeadBusiness } = require('./leadValidator');
const { UNSUPPORTED_MEDIA_REPLY } = require('./leadMedia');
const { emptyResult, mergeLeadResults } = require('./leadMerge');
const { conversationIntent, GREETING_REPLY, CONFIRMATION_REPLY, SAVED_REPLY, CONTINUE_REPLY, GUIDANCE_REPLY, formatConfirmationSummary } = require('./bossConversation');


const CHOOSE_NEXT_REPLY = 'The current lead is still open and has not been saved. Reply “discard current lead” to close it without saving and start another, or “continue” to keep it.';
const NEW_LEAD_REPLY = 'Ready for a new lead, Boss. Please send the customer details.';

function serviceFailure(code, stage, retryable = false) {
  return Object.assign(new Error('The lead workflow could not be completed safely.'), { code, stage, retryable });
}

function sourceContext(combined) {
  // Every original message and media transcript remains in the inbox. This
  // bounded session source summary supplements the complete inbox history.
  let context = combined.slice(-64000);
  if (/^[\uDC00-\uDFFF]/.test(context)) context = context.slice(1);
  return context;
}

function createLeadService({ store, ai, config, resolveMessageContent, resolveMessageText }) {
  const extractor = createLeadExtractor({ ai });
  return {
    async saveIncomingLead(job, { assertLease, maxAttempts = 3 }) {
      const messageId = job.message_id || job.whatsapp_message_id;
      let session;
      try { session = await store.getActiveLeadSession(job.sender_phone); }
      catch { throw serviceFailure('LEAD_WORKFLOW_PERSISTENCE_FAILED', 'persistence', true); }
      const baseResult = session?.result || emptyResult();
      // Persisted drafts may still carry validation from an older minimum-field
      // policy. Re-evaluate retained facts under the current optional-field rule.
      const baseValidation = validateLeadBusiness(baseResult);
      let media = {};
      async function commit(turn) {
        if (session && ['collecting', 'awaiting_confirmation', 'completed'].includes(turn.state)) {
          turn = { validation: baseValidation, ...turn };
        }
        if (turn.state === 'completed' && !turn.leadId) {
          turn.leadId = session?.lead_id || require('node:crypto').randomUUID();
        }
        await assertLease();
        let persisted;
        try {
          persisted = await store.completeLeadSessionTurn(messageId, job.lease_token, {
            sessionId: session?.id || null, ...media, ...turn,
          });
        } catch { throw serviceFailure('LEAD_WORKFLOW_PERSISTENCE_FAILED', 'persistence', true); }
        if (!persisted) throw serviceFailure('LEASE_LOST', 'persistence');
        const activeLeadId = turn.leadId || session?.lead_id || null;

        return { result: turn.result || baseResult, validation: turn.validation || baseValidation,
          state: turn.state || session?.state || null, kind: turn.kind, leadId: activeLeadId };
      }

      let text = job.message_text;
      await assertLease();
      if (job.message_type !== 'text') {
        let content;
        try {
          content = resolveMessageContent ? await resolveMessageContent(job, { assertLease }) : { text: await resolveMessageText(job) };
          text = content.text;
          if (typeof text !== 'string' || !text.trim()) throw new Error('Unreadable media.');
          media = { transcription: content.transcription ?? (job.message_type === 'audio' ? text : null),
            extractedText: content.extractedText ?? (job.message_type === 'audio' ? null : text),
            storageReference: content.storageReference ?? job.storage_reference ?? null,
            storageUrl: content.storageUrl ?? job.storage_url ?? null };
        } catch (error) {
          return commit({ kind: 'media_error', state: session ? 'collecting' : null,
            replyText: error?.code === 'LEAD_MEDIA_UNSUPPORTED' ? UNSUPPORTED_MEDIA_REPLY
              : 'I could not read that attachment clearly. Please resend a readable image, document or voice message, or send the details as text.' });
        }
        await assertLease();
        let checkpointed;
        try { checkpointed = await store.checkpointLeadMedia(messageId, job.lease_token, media); }
        catch { throw serviceFailure('LEAD_WORKFLOW_PERSISTENCE_FAILED', 'persistence', true); }
        if (!checkpointed) throw serviceFailure('LEASE_LOST', 'persistence');
      }
      const kind = conversationIntent(text);
      if (kind === 'greeting') return commit({ kind, replyText: GREETING_REPLY });
      if (['new_lead', 'discard', 'continue', 'confirmation'].includes(kind) && job.message_type !== 'text') {
        return commit({ kind: 'conversation', replyText: kind === 'confirmation'
          ? 'Please confirm by sending “save it” as a text message if the lead is complete.'
          : 'Please send lead-management instructions as a text message so I can confirm which lead you mean.' });
      }
      if (kind === 'new_lead') {
        if (session) return commit({ kind, pendingAction: 'new_lead', replyText: CHOOSE_NEXT_REPLY });
        return commit({ kind, state: 'collecting', originalMessage: '', pendingAction: null, replyText: NEW_LEAD_REPLY });
      }
      if (kind === 'discard') {
        if (!session) return commit({ kind: 'conversation', replyText: GUIDANCE_REPLY });
        if (session.pending_action !== 'new_lead') return commit({ kind: 'new_lead', pendingAction: 'new_lead', replyText: CHOOSE_NEXT_REPLY });
        return commit({ kind, state: 'discarded', pendingAction: null, startNewSession: true,
          replyText: 'The previous draft is closed without saving and retained in chat history. Please send the next customer details.' });
      }
      function confirmationReply(lead) {
        if (process.env.BOSS_CONFIRMATION_SUMMARY === 'true' || config?.confirmationSummary) {
          return formatConfirmationSummary(lead);
        }
        return CONFIRMATION_REPLY;
      }

      if (kind === 'continue') return commit({ kind: 'conversation', pendingAction: null,
        state: session && baseValidation.valid ? 'awaiting_confirmation' : null,
        replyText: baseValidation.valid ? confirmationReply(baseResult.lead) : GUIDANCE_REPLY });
      if (kind === 'confirmation') {
        // After asking to switch customers, bare "Yes" is ambiguous. Only a
        // specific save request can confirm the existing lead in this branch.
        if (session?.pending_action === 'new_lead' && !/\bsave\b/i.test(text)) return commit({ kind: 'conversation', replyText: CHOOSE_NEXT_REPLY });
        if (session && baseValidation.valid) {
          const leadId = session.lead_id || require('node:crypto').randomUUID();
          return commit({ kind, state: 'completed', pendingAction: null, leadId, replyText: SAVED_REPLY });
        }
        // Confirmation needs a factual draft, but never a particular field.
        return commit({ kind: 'conversation', replyText: GUIDANCE_REPLY });
      }
      if (kind === 'defer') return commit({ kind, state: session ? 'collecting' : null, pendingAction: null, replyText: CONTINUE_REPLY });
      if (kind === 'conversation') return commit({ kind,
        state: session && !session.pending_action && baseValidation.valid ? 'awaiting_confirmation' : null,
        replyText: session?.pending_action === 'new_lead' ? CHOOSE_NEXT_REPLY
          : baseValidation.valid ? confirmationReply(baseResult.lead) : GUIDANCE_REPLY });
      if (session?.pending_action === 'new_lead') return commit({ kind: 'conversation', replyText: CHOOSE_NEXT_REPLY });

      const combined = session?.original_message ? session.original_message + '\n' + text : text;
      const originalMessage = sourceContext(combined);
      let extracted;
      await assertLease();
      // Extract this message's facts once, then merge into the stored draft.
      // Re-extracting the entire history can select an older customer and omit
      // the latest facts, especially in drafts retained across older versions.
      try { extracted = await extractor.extract(text); } catch (error) {
        if (error.retryable && job.attempts < maxAttempts) throw error;
        return commit({ kind: 'details', state: 'collecting', result: baseResult, validation: baseValidation,
          originalMessage, errorCode: error.code, errorStage: error.stage,
          replyText: error.stage === 'schema'
            ? 'I could not validate the extracted details. Your draft is retained. Please clarify the latest information.'
            : 'I could not extract the details right now. Your draft is retained. Please send the remaining details or try again shortly.' });
      }
      const result = mergeLeadResults(baseResult, extracted, { currentText: text });
      const validation = validateLeadBusiness(result);
      if (validation.errors.some(code => code !== 'NOT_A_LEAD')) throw serviceFailure('LEAD_VALIDATION_FAILED', 'validation');
      if (!session && !validation.valid) {
        return commit({ kind, result, validation, replyText: GUIDANCE_REPLY });
      }
      return commit({ kind, state: validation.valid ? 'awaiting_confirmation' : 'collecting', result, validation, originalMessage,
        replyText: validation.valid ? confirmationReply(result.lead) : GUIDANCE_REPLY });
    },
  };
}

module.exports = { createLeadService, VALID_LEAD_REPLY: SAVED_REPLY, IRRELEVANT_LEAD_REPLY: GUIDANCE_REPLY, CHOOSE_NEXT_REPLY };
