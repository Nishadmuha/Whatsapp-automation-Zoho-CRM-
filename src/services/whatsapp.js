'use strict';
const { createWhatsAppService } = require('./whatsapp/whatsappService');
// Preserve the original public import path and function name.
async function sendWhatsAppTextMessage(to, message) {
  return createWhatsAppService().sendTextMessage(to, message);
}
async function sendTemplateMessage(to, templateName, languageCode) {
  return createWhatsAppService().sendTemplateMessage(to, templateName, languageCode);
}
module.exports = { sendWhatsAppTextMessage, sendTextMessage: sendWhatsAppTextMessage, sendTemplateMessage, createWhatsAppService };
