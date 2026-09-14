'use strict';

const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_DOCUMENT_BYTES = 32768;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AUDIO_EXTENSIONS = Object.freeze({
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/flac': 'flac',
});
const DOCUMENT_EXTENSIONS = Object.freeze({
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/rtf': 'rtf', 'text/rtf': 'rtf',
  'text/plain': 'txt',
});

function normalizeMediaMimeType(value) {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}

function mediaKind(mimeType) {
  const normalized = normalizeMediaMimeType(mimeType);
  if (IMAGE_MIME_TYPES.has(normalized)) return 'image';
  if (Object.hasOwn(AUDIO_EXTENSIONS, normalized)) return 'audio';
  if (Object.hasOwn(DOCUMENT_EXTENSIONS, normalized)) return 'document';
  return null;
}

function mediaSizeLimit(mimeType) {
  const normalized = normalizeMediaMimeType(mimeType);
  if (normalized === 'text/plain') return MAX_TEXT_DOCUMENT_BYTES;
  const kind = mediaKind(normalized);
  return kind === 'image' ? MAX_IMAGE_BYTES : kind ? MAX_MEDIA_BYTES : 0;
}

function isUnreadableMediaText(value) {
  if (typeof value !== 'string' || !value.trim()) return true;
  const uncertain = /^(?:unreadable|illegible|unclear|inaudible|uncertain|not (?:readable|legible|audible)|low confidence|unknown|n\/?a|not (?:provided|known|available|specified))$/iu;
  const refusal = /^(?:no readable (?:text|details)(?:\b.*)?|(?:i (?:can(?:not|'t)|am unable to)|unable to) (?:read|transcribe|extract)\b.*)$/iu;
  const label = /^(?:company(?: name)?|contact(?: name)?|customer(?: name)?|address|phone|telephone|mobile|email(?: id)?|trn(?:\s*(?:no\.?|number))?|tax registration(?: number)?|project(?: name| location)?|product(?: or service)?|requirement|quantity|deadline|notes)\s*[:=]\s*/iu;
  // Providers sometimes emit labelled placeholders instead of the requested
  // empty result. Such output must trigger clarification, not become lead data.
  return value.split(/\r?\n/u).filter(line => line.trim()).every(line => {
    const text = line.trim().replace(/^[-*•]\s*/u, '').replace(label, '').trim().replace(/[.!\s]+$/gu, '')
      .replace(/^[[(]\s*|\s*[\])]$/gu, '').replace(/[.!\s]+$/gu, '').trim();
    return uncertain.test(text) || refusal.test(text);
  });
}

module.exports = {
  MAX_MEDIA_BYTES, MAX_IMAGE_BYTES, MAX_TEXT_DOCUMENT_BYTES, AUDIO_EXTENSIONS, DOCUMENT_EXTENSIONS,
  normalizeMediaMimeType, mediaKind, mediaSizeLimit, isUnreadableMediaText,
};
