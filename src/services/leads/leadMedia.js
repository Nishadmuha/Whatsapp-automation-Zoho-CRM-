'use strict';

const { mediaKind, normalizeMediaMimeType, isUnreadableMediaText } = require('../../utils/media');
const { validateLeadInput } = require('../ai/leadExtraction');

const MEDIA_RESEND_REPLY = "I couldn't read that attachment. Please resend it or send the details as text.";
const UNSUPPORTED_MEDIA_REPLY = 'Please send the lead details as text, a screenshot, a voice message, or a PDF/Word document. For a video, please send a screenshot of the details.';

function mediaError(code) {
  return Object.assign(new Error(code === 'LEAD_MEDIA_UNSUPPORTED' ? UNSUPPORTED_MEDIA_REPLY : MEDIA_RESEND_REPLY), { code });
}

async function resolveLeadMessageContent({ message, whatsapp, ai, assertActive, store, logger = null }) {
  if (message.message_type === 'text') return { text: message.message_text, transcription: null, extractedText: null };
  if (!['image', 'audio', 'document'].includes(message.message_type)) throw mediaError('LEAD_MEDIA_UNSUPPORTED');
  const declaredMimeType = normalizeMediaMimeType(message.media_mime_type);
  if (message.message_type === 'document' && declaredMimeType && !['image', 'document'].includes(mediaKind(declaredMimeType))) {
    throw mediaError('LEAD_MEDIA_UNSUPPORTED');
  }
  try {
    const mediaStartedAt = Date.now();
    // Reuse the durable checkpoint on extraction retries. A caption alone is
    // never treated as already-processed OCR/transcription.
    let extracted = message.message_type === 'audio' ? message.transcription : message.extracted_text;
    let storageReference = message.storage_reference;
    let storageUrl = message.storage_url;
    if (extracted === undefined || extracted === null) {
      if (!message.media_id) throw new Error();
      await assertActive?.();
      const attachment = await whatsapp.downloadMedia(message.media_id);
      const mimeType = normalizeMediaMimeType(attachment.mimeType);
      const kind = mediaKind(mimeType);
      const matchesType = kind === message.message_type || (message.message_type === 'document' && kind === 'image');
      if (!matchesType || (declaredMimeType && declaredMimeType !== mimeType)) throw new Error();

      await assertActive?.();
      const savePromise = store && typeof store.saveMediaFile === 'function' && attachment.buffer
        ? Promise.resolve().then(() => store.saveMediaFile({
          messageId: message.whatsapp_message_id || message.message_id,
          mediaId: message.media_id,
          buffer: attachment.buffer,
          mimeType,
          filename: message.media_filename,
        })).catch(() => null)
        : Promise.resolve(null);
      // Media persistence and provider extraction use the same downloaded bytes
      // but do not depend on each other. Await both so persistence remains
      // durable while their latency overlaps.
      const [saved, extractedText] = await Promise.all([
        savePromise,
        ai.extractMediaText({ ...attachment, mimeType, type: message.message_type }),
      ]);
      if (saved) {
        storageReference = saved.storageReference;
        storageUrl = saved.storageUrl;
      }
      extracted = extractedText;
      try {
        logger?.info?.({
          event: 'lead_media_ready',
          message_id: message.whatsapp_message_id || message.message_id,
          message_type: message.message_type,
          duration_ms: Math.max(0, Date.now() - mediaStartedAt),
        });
      } catch { /* Timing logs never affect processing. */ }
    }
    validateLeadInput(extracted);
    if (isUnreadableMediaText(extracted)) throw new Error();
    const text = [message.message_text?.trim(), extracted.trim()].filter(Boolean).join('\n');
    validateLeadInput(text);
    const result = {
      text,
      transcription: message.message_type === 'audio' ? extracted.trim() : null,
      extractedText: message.message_type === 'audio' ? null : extracted.trim(),
    };
    if (storageReference !== undefined) result.storageReference = storageReference;
    if (storageUrl !== undefined) result.storageUrl = storageUrl;
    return result;
  } catch (error) {
    if (error?.code === 'LEASE_LOST') throw error;
    throw mediaError('LEAD_MEDIA_UNAVAILABLE');
  }
}

async function resolveLeadMessageText(options) {
  return (await resolveLeadMessageContent(options)).text;
}

module.exports = { resolveLeadMessageContent, resolveLeadMessageText, MEDIA_RESEND_REPLY, UNSUPPORTED_MEDIA_REPLY };
