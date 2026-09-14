'use strict';

const mongoose = require('mongoose');

const LeadMessageSchema = new mongoose.Schema({
  messageId: { type: String, required: true },
  whatsappMessageId: { type: String },
  senderPhone: { type: String, required: true },
  senderName: { type: String },
  direction: { type: String, enum: ['incoming', 'outgoing'], default: 'incoming' },
  senderType: { type: String, enum: ['boss', 'customer', 'bot'], default: 'customer' },
  text: { type: String },
  messageType: { type: String, default: 'text' },
  mediaId: { type: String },
  mediaMimeType: { type: String },
  mediaFilename: { type: String },
  transcription: { type: String },
  extractedText: { type: String },
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const LeadAttachmentSchema = new mongoose.Schema({
  id: { type: String },
  messageId: { type: String },
  whatsappMediaId: { type: String },
  type: { type: String }, // 'image', 'audio', 'document'
  mimeType: { type: String },
  filename: { type: String },
  storagePath: { type: String },
  transcription: { type: String },
  extractedText: { type: String },
  sizeBytes: { type: Number },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const LeadSchema = new mongoose.Schema({
  leadId: { type: String, required: true, unique: true, index: true },
  source: { type: String, enum: ['boss', 'client'], required: true, index: true },
  senderPhone: { type: String, required: true, index: true },
  senderName: { type: String },
  companyName: { type: String, default: null },
  contactName: { type: String, default: null },
  phone: { type: String, default: null },
  email: { type: String, default: null },
  projectLocation: { type: String, default: null },
  projectName: { type: String, default: null },
  productOrService: { type: String, default: null },
  requirement: { type: String, default: null },
  quantity: { type: String, default: null },
  deadline: { type: String, default: null },
  notes: { type: String, default: null },
  address: { type: String, default: null },
  trnNo: { type: String, default: null },
  originalMessage: { type: String, default: '' },
  extractedData: { type: mongoose.Schema.Types.Mixed, default: {} },
  validationStatus: {
    type: String,
    enum: ['pending', 'valid', 'incomplete', 'invalid'],
    default: 'pending',
  },
  confirmationStatus: {
    type: String,
    enum: ['collecting', 'awaiting_confirmation', 'confirmed', 'rejected', 'discarded', 'not_applicable'],
    default: 'collecting',
  },
  zohoStatus: {
    type: String,
    enum: ['not_started', 'pending', 'creating', 'updating', 'saved', 'failed'],
    default: 'not_started',
  },
  zohoLeadId: { type: String, default: null },
  zohoError: { type: String, default: null },
  messages: [LeadMessageSchema],
  attachments: [LeadAttachmentSchema],
}, {
  timestamps: true,
  collection: 'leads',
});

function getLeadModel() {
  return mongoose.models.Lead || mongoose.model('Lead', LeadSchema);
}

module.exports = { getLeadModel, LeadSchema };
