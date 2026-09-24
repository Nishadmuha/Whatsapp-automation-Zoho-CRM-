'use strict';

const { conversationIntent } = require('../../utils/conversationIntent');

const BOSS_BOUNDARIES = new Set(['greeting', 'new_lead', 'discard', 'continue', 'confirmation', 'defer']);
const BOOKS_COMMAND = /^(?:1|2|3|save|edit|delete)$/i;
const BOOKS_GREETING = /^(?:hi|hello|hey|salaam|start|\?)[.!?]*$/i;

function isBossBatchBoundary(message = {}) {
  if ((message.message_type || message.messageType) !== 'text') return false;
  return BOSS_BOUNDARIES.has(conversationIntent(message.message_text ?? message.text ?? ''));
}

function isBooksBatchBoundary(message = {}) {
  if (message.interactive_id || message.interactiveId) return true;
  if ((message.message_type || message.messageType || 'text') !== 'text') return false;
  const text = String(message.message_text ?? message.text ?? '').trim();
  return BOOKS_COMMAND.test(text) || BOOKS_GREETING.test(text);
}

function createAcknowledgementBatcher({ quietMs, now = Date.now } = {}) {
  const windowMs = Number.isInteger(quietMs) && quietMs > 0 ? quietMs : 5000;
  const groups = new Map();
  return {
    groupFor(message, { boundary = false } = {}) {
      const sender = message.senderPhone || message.sender_phone;
      const messageId = message.messageId || message.message_id || message.whatsapp_message_id;
      const current = now();
      const previous = groups.get(sender);
      const startsNew = !previous || current - previous.lastSeenAt >= windowMs || previous.boundary || boundary;
      const group = startsNew ? { key: messageId, lastSeenAt: current, boundary } : { ...previous, lastSeenAt: current };
      groups.set(sender, group);
      return group.key;
    },
    clear() { groups.clear(); },
  };
}

module.exports = { createAcknowledgementBatcher, isBossBatchBoundary, isBooksBatchBoundary };
