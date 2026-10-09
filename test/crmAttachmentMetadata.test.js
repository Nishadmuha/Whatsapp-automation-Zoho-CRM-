'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { temporaryStore } = require('./helpers');
const { handleZohoSync } = require('../src/services/leads/bossLeadWorkflow');

test('attachment checkpoints preserve snake-case IDs and originals through backing-record fallback', async t => {
  const { store } = await temporaryStore(t);
  const leadId = randomUUID();
  const zohoLeadId = '5653678000000000001';
  const attachment = { message_id: 'metadata-recovery', lead_id: leadId,
    zoho_upload_status: 'uploaded', zoho_attachment_id: '5653678000000000002', zoho_lead_id: zohoLeadId,
    storage_reference: 'original-file', storage_url: '/api/media/original-file' };
  await store.col('leads').insertOne({ id: leadId, zoho_status: 'saved', zoho_lead_id: zohoLeadId });
  await store.col('lead_attachments').insertOne(attachment);
  await store.updateLeadAttachments(leadId, [attachment]);
  assert.equal((await store.getLead(leadId)).attachmentStatus, 'uploaded');
  // Exercise the recovery source after the embedded cache is unavailable.
  await store.col('leads').updateOne({ id: leadId }, { $unset: { attachments: '' } });
  const recovered = (await store.getLead(leadId)).attachments[0];
  assert.equal(recovered.zoho_attachment_id, attachment.zoho_attachment_id);
  assert.equal(recovered.zoho_lead_id, zohoLeadId);
  assert.equal(recovered.zoho_upload_status, 'uploaded');
  assert.equal(recovered.storage_reference, 'original-file');
  assert.equal(recovered.storage_url, '/api/media/original-file');
  const result = await handleZohoSync({ leadId, store, config: {}, zoho: {
    async updateLead() { assert.fail('confirmed lead must not be updated'); },
    async uploadLeadAttachment() { assert.fail('confirmed attachment must not be uploaded twice'); },
  } });
  assert.equal(result.success, true);
});

test('attachment metadata updates stay on their lead and preserve mixed-schema status and cleared errors', async t => {
  const { store } = await temporaryStore(t);
  const leadId = randomUUID(), unrelatedLeadId = randomUUID();
  const common = { id: 'metadata-shared-id', message_id: 'metadata-shared-message', zoho_error: 'old failure' };
  await store.col('leads').insertOne({ id: leadId });
  await store.col('lead_attachments').insertMany([
    { ...common, lead_id: unrelatedLeadId, zoho_attachment_id: 'unrelated-id' },
    { ...common, lead_id: leadId },
  ]);
  await store.updateLeadAttachments(leadId, [{ ...common, zohoAttachmentId: '900', zohoLeadId: '123',
    zohoUploadStatus: 'uploaded', zohoError: null, storageReference: 'original', storageUrl: '/api/media/original' },
  { id: 'missing-file', zoho_upload_status: 'failed', zoho_error: 'Media file buffer not found' }]);
  const updated = await store.col('lead_attachments').findOne({ lead_id: leadId });
  assert.equal(updated.zoho_attachment_id, '900');
  assert.equal(updated.zoho_lead_id, '123');
  assert.equal(updated.zoho_error, null);
  assert.equal((await store.getLead(leadId)).attachmentStatus, 'failed');
  assert.equal((await store.col('lead_attachments').findOne({ lead_id: unrelatedLeadId })).zoho_attachment_id, 'unrelated-id');
});

test('stored original default filenames use normalized MIME extensions', async t => {
  const { store } = await temporaryStore(t);
  for (const [mimeType, extension] of [['audio/ogg; codecs=opus', 'ogg'], ['image/vnd.dwg', 'dwg'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx']]) {
    const saved = await store.saveMediaFile({ mediaId: '123', buffer: Buffer.from('original file'), mimeType });
    assert.equal(saved.filename, `123.${extension}`);
    assert.deepEqual((await store.getMediaFile(saved.storageReference)).buffer, Buffer.from('original file'));
  }
});
