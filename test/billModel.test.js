'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  BILL_STATUSES,
  ZOHO_STATUSES,
  SESSION_STATES,
  ACTIVE_SESSION_STATES,
  EXTRACTION_STATUSES,
  getBillModel,
  getBillSessionModel,
  getBillExtractionModel,
} = require('../src/models/billModel');

test('billModel: constants and enum definitions are valid', () => {
  assert.ok(Array.isArray(BILL_STATUSES));
  assert.ok(BILL_STATUSES.includes('DRAFT'));
  assert.ok(BILL_STATUSES.includes('COMPLETED'));
  assert.ok(BILL_STATUSES.includes('CANCELLED'));
  assert.ok(BILL_STATUSES.includes('FAILED'));

  assert.ok(Array.isArray(ZOHO_STATUSES));
  assert.ok(ZOHO_STATUSES.includes('NOT_SYNCED'));
  assert.ok(ZOHO_STATUSES.includes('SYNCED'));
  assert.ok(ZOHO_STATUSES.includes('FAILED'));

  assert.ok(Array.isArray(SESSION_STATES));
  assert.ok(SESSION_STATES.includes('EXTRACTING'));
  assert.ok(SESSION_STATES.includes('AWAITING_ADDITIONAL_INFO'));
  assert.ok(SESSION_STATES.includes('WAITING_FOR_ADDITIONAL_INFO'));
  assert.ok(SESSION_STATES.includes('AWAITING_EDIT'));
  assert.ok(SESSION_STATES.includes('WAITING_FOR_EDIT_INSTRUCTION'));
  assert.ok(SESSION_STATES.includes('AWAITING_FINAL_CONFIRMATION'));
  assert.ok(SESSION_STATES.includes('CREATING_IN_ZOHO'));
  assert.ok(SESSION_STATES.includes('COMPLETED'));
  assert.ok(SESSION_STATES.includes('CANCELLED'));
  assert.ok(SESSION_STATES.includes('FAILED'));

  assert.ok(Array.isArray(ACTIVE_SESSION_STATES));
  assert.strictEqual(ACTIVE_SESSION_STATES.includes('COMPLETED'), false);
  assert.strictEqual(ACTIVE_SESSION_STATES.includes('CANCELLED'), false);
  assert.strictEqual(ACTIVE_SESSION_STATES.includes('FAILED'), false);

  assert.ok(Array.isArray(EXTRACTION_STATUSES));
  assert.ok(EXTRACTION_STATUSES.includes('PENDING'));
  assert.ok(EXTRACTION_STATUSES.includes('PROCESSING'));
  assert.ok(EXTRACTION_STATUSES.includes('COMPLETED'));
  assert.ok(EXTRACTION_STATUSES.includes('FAILED'));
});

test('billModel: Bill model schema defines all required bill fields', () => {
  const Bill = getBillModel();
  const paths = Bill.schema.paths;

  // Identity
  assert.ok(paths.bill_id, 'bill_id path must exist');
  assert.ok(paths.session_id, 'session_id path must exist');
  assert.ok(paths.source_message_id, 'source_message_id path must exist');
  assert.ok(paths.worker_phone, 'worker_phone path must exist');

  // Status
  assert.ok(paths.status, 'status path must exist');
  assert.ok(paths.zoho_status, 'zoho_status path must exist');

  // Vendor
  assert.ok(paths.vendor_name, 'vendor_name path must exist');
  assert.ok(paths.vendor_phone, 'vendor_phone path must exist');
  assert.ok(paths.vendor_email, 'vendor_email path must exist');
  assert.ok(paths.vendor_trn, 'vendor_trn path must exist');
  assert.ok(paths.zoho_vendor_id, 'zoho_vendor_id path must exist');

  // Bill Information
  assert.ok(paths.bill_number, 'bill_number path must exist');
  assert.ok(paths.bill_date, 'bill_date path must exist');
  assert.ok(paths.due_date, 'due_date path must exist');
  assert.ok(paths.currency, 'currency path must exist');

  // Amounts
  assert.ok(paths.subtotal, 'subtotal path must exist');
  assert.ok(paths.tax_amount, 'tax_amount path must exist');
  assert.ok(paths.discount_amount, 'discount_amount path must exist');
  assert.ok(paths.total_amount, 'total_amount path must exist');

  // Line items
  assert.ok(paths.line_items, 'line_items path must exist');

  // Additional info
  assert.ok(paths.notes, 'notes path must exist');
  assert.ok(paths.additional_information, 'additional_information path must exist');

  // Attachments
  assert.ok(paths.attachments, 'attachments path must exist');

  // Zoho
  assert.ok(paths.zoho_bill_id, 'zoho_bill_id path must exist');
  assert.ok(paths.zoho_bill_url, 'zoho_bill_url path must exist');
  assert.ok(paths.zoho_error, 'zoho_error path must exist');

  // Audit
  assert.ok(paths.edit_history, 'edit_history path must exist');
});

test('billModel: BillSession schema defines all required session fields', () => {
  const BillSession = getBillSessionModel();
  const paths = BillSession.schema.paths;

  assert.ok(paths.session_id, 'session_id path must exist');
  assert.ok(paths.worker_phone, 'worker_phone path must exist');
  assert.ok(paths.bill_id, 'bill_id path must exist');
  assert.ok(paths.state, 'state path must exist');
  assert.ok(paths.last_message_id, 'last_message_id path must exist');
  assert.ok(paths.expires_at, 'expires_at path must exist');
  assert.ok(paths.bill_data, 'bill_data path must exist');
  assert.ok(paths.attachments, 'attachments path must exist');
});

test('billModel: BillExtraction schema defines all required extraction job fields', () => {
  const BillExtraction = getBillExtractionModel();
  const paths = BillExtraction.schema.paths;

  assert.ok(paths.job_id, 'job_id path must exist');
  assert.ok(paths.message_id, 'message_id path must exist');
  assert.ok(paths.worker_phone, 'worker_phone path must exist');
  assert.ok(paths.status, 'status path must exist');
  assert.ok(paths.attempts, 'attempts path must exist');
  assert.ok(paths.max_attempts, 'max_attempts path must exist');
  assert.ok(paths.lease_token, 'lease_token path must exist');
  assert.ok(paths.lease_until, 'lease_until path must exist');
  assert.ok(paths.last_error, 'last_error path must exist');
});
