'use strict';

const mongoose = require('mongoose');

const BILL_STATUSES = Object.freeze([
  'DRAFT',
  'PENDING_REVIEW',
  'READY_FOR_CONFIRMATION',
  'CREATING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
]);

const ZOHO_STATUSES = Object.freeze([
  'NOT_SYNCED',
  'SYNCING',
  'SYNCED',
  'FAILED',
]);

const SESSION_STATES = Object.freeze([
  'EXTRACTING',
  'AWAITING_ADDITIONAL_INFO',
  'WAITING_FOR_ADDITIONAL_INFO',
  'WAITING_FOR_CURRENCY',
  'WAITING_FOR_ORGANIZATION',
  'WAITING_FOR_CUSTOMER_SELECTION',
  'AWAITING_EDIT',
  'WAITING_FOR_EDIT_INSTRUCTION',
  'AWAITING_FINAL_CONFIRMATION',
  'CREATING_IN_ZOHO',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
]);

const ACTIVE_SESSION_STATES = Object.freeze([
  'EXTRACTING',
  'AWAITING_ADDITIONAL_INFO',
  'WAITING_FOR_ADDITIONAL_INFO',
  'WAITING_FOR_CURRENCY',
  'WAITING_FOR_ORGANIZATION',
  'WAITING_FOR_CUSTOMER_SELECTION',
  'AWAITING_EDIT',
  'WAITING_FOR_EDIT_INSTRUCTION',
  'AWAITING_FINAL_CONFIRMATION',
  'CREATING_IN_ZOHO',
]);

const EXTRACTION_STATUSES = Object.freeze([
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
]);

const BillLineItemSchema = new mongoose.Schema({
  name: { type: String, default: null },
  description: { type: String, default: null },
  quantity: { type: Number, default: 1 },
  rate: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  amount: { type: Number, default: 0 },
  account_id: { type: String, default: null },
}, { _id: false });

const BillAttachmentSchema = new mongoose.Schema({
  storage_reference: { type: String, default: null },
  original_filename: { type: String, default: null },
  mime_type: { type: String, default: null },
  media_id: { type: String, default: null },
  storage_url: { type: String, default: null },
}, { _id: false });

const BillEditHistorySchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  editor: { type: String, default: 'worker' },
  field: { type: String, required: true },
  previous_value: { type: mongoose.Schema.Types.Mixed, default: null },
  new_value: { type: mongoose.Schema.Types.Mixed, default: null },
  reason: { type: String, default: null },
}, { _id: false });

const BillSchema = new mongoose.Schema({
  bill_id: { type: String, required: true, unique: true, index: true },
  session_id: { type: String, default: null, index: true },
  source_message_id: { type: String, default: null, index: true },
  worker_phone: { type: String, required: true, index: true },

  status: {
    type: String,
    enum: BILL_STATUSES,
    default: 'DRAFT',
    index: true,
  },
  zoho_status: {
    type: String,
    enum: ZOHO_STATUSES,
    default: 'NOT_SYNCED',
    index: true,
  },

  vendor_name: { type: String, default: null, index: true },
  vendor_phone: { type: String, default: null },
  vendor_email: { type: String, default: null },
  vendor_trn: { type: String, default: null },
  zoho_vendor_id: { type: String, default: null },

  payment_type: { type: String, default: null },
  customer_details: { type: mongoose.Schema.Types.Mixed, default: null },

  bill_number: { type: String, default: null, index: true },
  bill_date: { type: String, default: null },
  due_date: { type: String, default: null },
  currency: { type: String, default: 'AED' },
  organization: { type: mongoose.Schema.Types.Mixed, default: null },

  subtotal: { type: Number, default: null },
  tax_amount: { type: Number, default: null },
  discount_amount: { type: Number, default: 0 },
  total_amount: { type: Number, default: null },

  line_items: [BillLineItemSchema],

  notes: { type: String, default: null },
  additional_information: { type: String, default: null },

  attachments: [BillAttachmentSchema],

  zoho_bill_id: { type: String, default: null, index: true },
  zoho_bill_url: { type: String, default: null },
  zoho_error: { type: String, default: null },

  edit_history: [BillEditHistorySchema],
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'bills',
});

const BillSessionSchema = new mongoose.Schema({
  session_id: { type: String, required: true, unique: true, index: true },
  worker_phone: { type: String, required: true, index: true },
  bill_id: { type: String, default: null, index: true },
  state: {
    type: String,
    enum: SESSION_STATES,
    default: 'EXTRACTING',
    index: true,
  },
  last_message_id: { type: String, default: null },
  expires_at: { type: Date, default: null, index: true },
  bill_data: { type: mongoose.Schema.Types.Mixed, default: {} },
  customer_options: { type: [mongoose.Schema.Types.Mixed], default: [] },
  attachments: [BillAttachmentSchema],
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'bill_sessions',
});

const BillExtractionSchema = new mongoose.Schema({
  job_id: { type: String, required: true, unique: true, index: true },
  message_id: { type: String, required: true, unique: true, index: true },
  worker_phone: { type: String, required: true, index: true },
  status: {
    type: String,
    enum: EXTRACTION_STATUSES,
    default: 'PENDING',
    index: true,
  },
  attempts: { type: Number, default: 0 },
  max_attempts: { type: Number, default: 3 },
  lease_token: { type: String, default: null },
  lease_until: { type: Date, default: null, index: true },
  last_error: { type: String, default: null },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  reply_status: { type: String, default: null },
  reply_provider_message_id: { type: String, default: null },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'bill_extractions',
});

function getBillModel() {
  return mongoose.models.Bill || mongoose.model('Bill', BillSchema);
}

function getBillSessionModel() {
  return mongoose.models.BillSession || mongoose.model('BillSession', BillSessionSchema);
}

function getBillExtractionModel() {
  return mongoose.models.BillExtraction || mongoose.model('BillExtraction', BillExtractionSchema);
}

module.exports = {
  BILL_STATUSES,
  ZOHO_STATUSES,
  SESSION_STATES,
  ACTIVE_SESSION_STATES,
  EXTRACTION_STATUSES,
  BillSchema,
  BillSessionSchema,
  BillExtractionSchema,
  BillLineItemSchema,
  BillAttachmentSchema,
  BillEditHistorySchema,
  getBillModel,
  getBillSessionModel,
  getBillExtractionModel,
};
