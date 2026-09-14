'use strict';

const { createReplyDispatcher } = require('./replyDispatcher');

const AUTO_REPLY_TEXT = 'Thanks for contacting Voltronix Contracting LLC. How can we help you?';

function createAutoReplyProcessor({ store, whatsapp, config, logger, triggerGate }) {
  const dispatcher = createReplyDispatcher({
    store, whatsapp, config, logger, triggerGate, replyText: AUTO_REPLY_TEXT,
    canSendReply: (reply) => reply.authenticated === true && reply.message_type === 'text'
      && reply.text === AUTO_REPLY_TEXT
      && (!config.allowedSenders.size || config.allowedSenders.has(reply.sender_phone)),
  });
  return {
    async processNextReply() {
      if (!config.enabled) return false;
      return dispatcher.processNextReply();
    },
  };
}

module.exports = { AUTO_REPLY_TEXT, createAutoReplyProcessor };
