'use strict';

const { conversationIntent } = require('../../utils/conversationIntent');

const BOSS_BOUNDARIES = new Set(['greeting', 'new_lead', 'discard', 'continue', 'confirmation', 'defer']);
const BOOKS_COMMAND = /^(?:[1-9]\d?|(?:1\s+)?save|(?:2\s+)?edit|(?:3\s+)?delete|next|more|prev|previous|back|all|paid|unpaid|not\s+paid)$/i;
const BOOKS_PAYMENT_METHOD = /^(?:(?:payment\s*(?:type|method)?|paid\s*by)\s*[:=-]\s*|paid\s+(?:by|in)\s+)?(?:cash|bank\s+remittance|bank\s+transfer|credit\s+card|cheque)[.!?]*$/i;
const BOOKS_GREETING = /^(?:hi|hello|hey|salaam|start|\?)[.!?]*$/i;
const BOOKS_PROMPT_REPLY_STATES = Object.freeze([
  'WAITING_FOR_PROJECT_DETAILS', 'WAITING_FOR_ORGANIZATION', 'WAITING_FOR_CURRENCY', 'WAITING_FOR_CUSTOMER_SELECTION',
  'WAITING_FOR_ADDITIONAL_INFO',
]);

function isBossBatchBoundary(message = {}) {
  if ((message.message_type || message.messageType) !== 'text') return false;
  return BOSS_BOUNDARIES.has(conversationIntent(message.message_text ?? message.text ?? ''));
}

function isStandaloneCustomerName(text) {
  return text.length <= 160 && /\p{L}/u.test(text) && !/[\r\n;:=]/.test(text)
    && !/\b(?:invoice|bill|subtotal|total|vat|quantity|qty|rate)\b/i.test(text)
    && !/^(?:manual|customer|client|vendor|supplier|project|site|location|currency|payment|tax|change|update|edit|delete|save)\b/i.test(text);
}

function isCompleteCustomerReply(text) {
  const parts = text.split(/[;\r\n]+/).map(part => part.trim()).filter(Boolean);
  if (parts.length !== 4 || !isStandaloneCustomerName(parts[0])) return false;
  const fields = new Set();
  for (const part of parts.slice(1)) {
    const match = part.match(/^(project|site|location|payment method|payment type|paid by|payment status)\s*[:=-]\s*(.+)$/i);
    if (!match || /[:=]/.test(match[2])) return false;
    const label = match[1].toLowerCase();
    const field = /^(?:project|site|location)$/.test(label) ? 'project' : label === 'payment status' ? 'status' : 'method';
    if (fields.has(field)) return false;
    if (field === 'status' && !/^(?:paid|unpaid)$/i.test(match[2])) return false;
    if (field === 'method') {
      const { normalizePaymentMethod } = require('../books/paymentMethods');
      if (!normalizePaymentMethod(match[2])) return false;
    }
    fields.add(field);
  }
  return fields.size === 3;
}

function isBooksBatchBoundary(message = {}, session = null) {
  if (message.interactive_id || message.interactiveId) return true;
  if ((message.message_type || message.messageType || 'text') !== 'text') return false;
  const text = String(message.message_text ?? message.text ?? '').trim();
  if (BOOKS_COMMAND.test(text) || BOOKS_GREETING.test(text) || BOOKS_PAYMENT_METHOD.test(text)) return true;
  if (!text || message.media_id || message.mediaId || message.media_buffer || message.mediaBuffer) return false;
  // Only a reply to the currently awaited field may bypass the invoice/page
  // quiet window. This changes scheduling, never workflow validation or SAVE.
  if (session?.state === 'WAITING_FOR_ADDITIONAL_INFO') {
    const { parseBillDateReply } = require('../books/billDateReply');
    return Boolean(parseBillDateReply(text, { allowBare: !session.bill_data?.bill_date }));
  }
  if (session?.state === 'WAITING_FOR_CUSTOMER_SELECTION') {
    // The current customer prompt already parses a standalone name directly.
    // Keep invoice fragments, labelled edits and multi-message details batched.
    return isStandaloneCustomerName(text) || isCompleteCustomerReply(text);
  }
  if (session?.state === 'WAITING_FOR_CURRENCY') {
    const { normalizeCurrency } = require('../books/billValidator');
    const match = text.replace(/[.!?,;:]+$/, '').match(/^(?:currency(?:\s+code)?\s*[:=-]?\s*)?([^\s,;]+)$/i);
    return Boolean(match && /^[A-Z]{3}$/.test(normalizeCurrency(match[1]) || ''));
  }
  if (session?.state === 'WAITING_FOR_ORGANIZATION') {
    // The server imports its queue before loading .env. Resolve organization
    // configuration only when processing an actual reply after startup.
    const { resolveOrganization } = require('../books/organizations');
    const name = text.replace(/[.!?]+$/, '').replace(/^(?:organization|company)(?:\s+name)?(?:\s+is)?\s*[:=-]?\s*/i, '');
    return Boolean(resolveOrganization(name, { selected: true }));
  }
  if (session?.state === 'WAITING_FOR_PROJECT_DETAILS') {
    // The bill parser handles a labelled project and payment fields supplied
    // together as one answer, including its supported multiline form.
    if (/^(?:project|site|location)\s*[:=-]\s*[^\s;,\n][^;,\n]*/i.test(text)
        && /[;,\n][ \t]*(?:payment(?:[ \t]+(?:type|method|status))?|bill[ \t]+status|paid[ \t]+by)[ \t]*[:=-]/i.test(text)) return true;
    if (/^(?:manual|customer|client|payment|vendor|supplier|currency|bill|invoice|total|subtotal|tax|vat|quantity|rate|change|update|edit)\b/i.test(text)) return false;
    const project = text.replace(/^(?:project(?:\s*(?:details|name|\/\s*site))?|site)\s*[:=-]\s*/i, '').trim();
    return Boolean(project && !/[\r\n;]/.test(project) && !/^(?:yes|no)$/i.test(project));
  }
  return false;
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

module.exports = { createAcknowledgementBatcher, isBossBatchBoundary, isBooksBatchBoundary, BOOKS_PROMPT_REPLY_STATES };
