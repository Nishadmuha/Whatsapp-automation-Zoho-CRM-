'use strict';
const { normalizeSenderPhone } = require('../../utils/phone');

const knownTypes = new Set(['text', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'interactive', 'button', 'reaction', 'order', 'system', 'unsupported']);
const mediaTypes = new Set(['image', 'audio', 'video', 'document', 'sticker']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function whatsappId(value) {
  return normalizeSenderPhone(value)?.slice(1) || '';
}

function optionalId(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value) ? value : '';
}

function contactNames(contacts) {
  const names = new Map();
  if (!Array.isArray(contacts)) return names;
  for (const contact of contacts) {
    if (!isRecord(contact)) continue;
    const id = whatsappId(contact.wa_id);
    const name = isRecord(contact.profile) ? contact.profile.name : undefined;
    if (!id || typeof name !== 'string' || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) continue;
    if (!names.has(id)) names.set(id, name.trim());
  }
  return names;
}

function safeMetadata(value, limit) {
  return typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';
}

function nonTextBody(message, messageType) {
  const content = isRecord(message[messageType]) ? message[messageType] : {};
  if (mediaTypes.has(messageType)) return content.caption;
  if (messageType === 'button') return content.text;
  if (messageType === 'interactive') return content.button_reply?.title || content.list_reply?.title;
  if (messageType === 'reaction') return content.emoji;
  if (messageType === 'location') return [content.name, content.address, content.latitude, content.longitude]
    .filter((value) => typeof value === 'string' || typeof value === 'number').join(' ');
  if (messageType === 'system') return content.body;
  return '';
}

function interactiveReplyId(message) {
  if (!isRecord(message?.interactive)) return '';
  const reply = message.interactive.list_reply || message.interactive.button_reply;
  return isRecord(reply) ? optionalId(reply.id) : '';
}

// Store valid message envelopes, including media that has no automatic reply.
// Delivery notifications remain separate from incoming chat messages.
function parseWhatsAppWebhook(payload, { phoneNumberId = '', allowedSenders = new Set(), now = Date.now(), onUnsupported, onIgnored } = {}) {
  const parsed = [];
  if (!isRecord(payload) || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return parsed;
  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change)) continue;
      if (['smb_message_echoes', 'message_echoes'].includes(change.field)) {
        onIgnored?.({ reason: 'outgoing', count: 1 });
        continue;
      }
      if (change.field !== 'messages') continue;
      const value = change.value;
      if (!isRecord(value)) continue;
      if (value.messaging_product && value.messaging_product !== 'whatsapp') continue;
      const destination = isRecord(value.metadata) ? optionalId(value.metadata.phone_number_id) : '';
      if (phoneNumberId && destination !== phoneNumberId) continue;
      if (Array.isArray(value.statuses) && value.statuses.length) onIgnored?.({ reason: 'status', count: value.statuses.length });
      if (!Array.isArray(value.messages)) continue;
      const ownWhatsappId = whatsappId(value.metadata?.display_phone_number);
      const names = contactNames(value.contacts);
      for (const message of value.messages) {
        if (!isRecord(message)) continue;
        if (message.from_me === true || message.fromMe === true || message.is_echo === true || message.direction === 'outgoing') {
          onIgnored?.({ reason: 'outgoing', count: 1 });
          continue;
        }
        if (typeof message.type !== 'string' || !message.type) continue;
        const messageType = knownTypes.has(message.type) ? message.type : 'unknown';
        if (typeof message.id !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(message.id)) continue;
        const senderWhatsappId = whatsappId(message.from);
        if (!senderWhatsappId) continue;
        if (ownWhatsappId && senderWhatsappId === ownWhatsappId) {
          onIgnored?.({ reason: 'outgoing', count: 1 });
          continue;
        }
        const senderPhone = `+${senderWhatsappId}`;
        if (allowedSenders.size && !allowedSenders.has(senderPhone)) continue;
        let text = messageType === 'text' ? (isRecord(message.text) ? message.text.body : undefined) : nonTextBody(message, messageType);
        if (messageType === 'text') {
          if (typeof text !== 'string' || !text.trim() || Array.from(text).length > 4096 || text.includes('\0')) continue;
        } else if (typeof text !== 'string' || Array.from(text).length > 4096 || text.includes('\0')) text = '';
        if (typeof message.timestamp !== 'string' || !/^\d{1,11}$/.test(message.timestamp)) continue;
        const time = Number(message.timestamp) * 1000;
        if (time <= 0 || time > now + 300000) continue;
        const attachment = mediaTypes.has(messageType) && isRecord(message[messageType]) ? message[messageType] : null;
        if (!['text', 'image', 'audio'].includes(messageType) && typeof onUnsupported === 'function') onUnsupported({ messageType });
        const selectionId = messageType === 'interactive' ? interactiveReplyId(message) : '';
        parsed.push({
          messageId: message.id, senderWhatsappId, senderPhone,
          senderName: names.get(senderWhatsappId) || '', timestamp: message.timestamp,
          messageType, text, phoneNumberId: destination, wabaId: optionalId(entry.id),
          ...(selectionId ? { interactiveId: selectionId } : {}),
          ...(attachment ? {
            mediaId: typeof attachment.id === 'string' && /^\d{1,128}$/.test(attachment.id) ? attachment.id : '',
            mediaMimeType: safeMetadata(attachment.mime_type, 200),
            mediaFilename: safeMetadata(attachment.filename, 255),
          } : {}),
        });
      }
    }
  }
  return parsed;
}

// Keep the established persistence/worker contract separate from the public parser.
function parseIncomingMessages(payload, options) {
  return parseWhatsAppWebhook(payload, options).map((message) => ({
    whatsapp_message_id: message.messageId, sender_phone: message.senderPhone,
    message_text: message.text, message_type: message.messageType,
    received_at: new Date(Number(message.timestamp) * 1000).toISOString(),
  }));
}

module.exports = { parseWhatsAppWebhook, parseIncomingMessages };
