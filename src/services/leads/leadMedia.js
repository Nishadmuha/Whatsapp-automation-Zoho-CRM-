'use strict';

const { mediaKind, normalizeMediaMimeType, isUnreadableMediaText } = require('../../utils/media');
const { validateLeadInput } = require('../ai/leadExtraction');

const MEDIA_RESEND_REPLY = "I couldn't read that attachment. Please resend it or send the details as text.";
const UNSUPPORTED_MEDIA_REPLY = 'Please send the lead details as text, a screenshot, a voice message, or a PDF/Word document. For a video, please send a screenshot of the details.';

function mediaError(code) {
  return Object.assign(new Error(code === 'LEAD_MEDIA_UNSUPPORTED' ? UNSUPPORTED_MEDIA_REPLY : MEDIA_RESEND_REPLY), { code });
}

async function resolveLeadMessageContent({ message, whatsapp, ai, assertActive }) {
  if (message.message_type === 'text') return { text: message.message_text, transcription: null, extractedText: null };
  if (!['image', 'audio', 'document'].includes(message.message_type)) throw mediaError('LEAD_MEDIA_UNSUPPORTED');
  const declaredMimeType = normalizeMediaMimeType(message.media_mime_type);
  if (message.message_type === 'document' && declaredMimeType && !['image', 'document'].includes(mediaKind(declaredMimeType))) {
    throw mediaError('LEAD_MEDIA_UNSUPPORTED');
  }
  try {
    // Reuse the durable checkpoint on extraction retries. A caption alone is
    // never treated as already-processed OCR/transcription.
    let extracted = message.message_type === 'audio' ? message.transcription : message.extracted_text;
    if (extracted === undefined || extracted === null) {
      if (!message.media_id) throw new Error();
      await assertActive?.();
      const attachment = await whatsapp.downloadMedia(message.media_id);
      const mimeType = normalizeMediaMimeType(attachment.mimeType);
      const kind = mediaKind(mimeType);
      const matchesType = kind === message.message_type || (message.message_type === 'document' && kind === 'image');
      if (!matchesType || (declaredMimeType && declaredMimeType !== mimeType)) throw new Error();
      await assertActive?.();
      extracted = await ai.extractMediaText({ ...attachment, mimeType, type: message.message_type });
    }
    validateLeadInput(extracted);
    if (isUnreadableMediaText(extracted)) throw new Error();
    const text = [message.message_text?.trim(), extracted.trim()].filter(Boolean).join('\n');
    validateLeadInput(text);
    return {
      text,
      transcription: message.message_type === 'audio' ? extracted.trim() : null,
      extractedText: message.message_type === 'audio' ? null : extracted.trim(),
    };
  } catch (error) {
    if (error?.code === 'LEASE_LOST') throw error;
    throw mediaError('LEAD_MEDIA_UNAVAILABLE');
  }
}

async function resolveLeadMessageText(options) {
  return (await resolveLeadMessageContent(options)).text;
}

module.exports = { resolveLeadMessageContent, resolveLeadMessageText, MEDIA_RESEND_REPLY, UNSUPPORTED_MEDIA_REPLY };
