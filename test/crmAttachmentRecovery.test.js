'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { handleZohoSync } = require('../src/services/leads/bossLeadWorkflow');

function setup(attachments = [{ media_id: '456', storageReference: 'stale-file', mimeType: 'image/jpeg' }]) {
  const lead = { id: 'local-lead', contact_name: 'Sam', phone: '+971501234567', attachments };
  const uploads = [], checkpoints = [];
  const store = {
    async getLead() { return structuredClone(lead); },
    async updateLeadZohoStatus(_id, data) {
      for (const [key, value] of Object.entries(data)) {
        const mapped = ({ zohoStatus: 'zoho_status', zohoLeadId: 'zoho_lead_id', zohoUrl: 'zoho_url' })[key] || key;
        lead[mapped] = value;
      }
    },
    async getMediaFile() { return null; },
    async getMediaFileByMediaId() { return null; },
    async updateLeadAttachments(_id, files) {
      lead.attachments = structuredClone(files);
      checkpoints.push(structuredClone(files));
    },
  };
  const zoho = {
    async searchLeadByPhone() { return null; },
    async createLead() { return { id: '123' }; },
    async updateLead(id) { return { id }; },
    async uploadLeadAttachment(id, file) {
      uploads.push({ id, ...file });
      return { id: String(1000 + uploads.length) };
    },
  };
  const whatsapp = { async downloadMedia() { return { buffer: Buffer.from('original image'), mimeType: 'image/jpeg' }; } };
  const sync = () => handleZohoSync({ leadId: lead.id, store, zoho, whatsapp, config: {} });
  return { lead, store, zoho, whatsapp, sync, uploads, checkpoints };
}

test('CRM attachment storage-reference failure falls back to the media ID alias', async () => {
  const f = setup();
  f.store.getMediaFile = async () => { throw Error('storage reference unavailable'); };
  f.store.getMediaFileByMediaId = async id => {
    assert.equal(id, '456');
    return { buffer: Buffer.from('durable image'), mimeType: 'image/jpeg' };
  };
  f.whatsapp.downloadMedia = async () => { assert.fail('durable media should be reused'); };
  assert.equal((await f.sync()).success, true);
  assert.equal(f.uploads[0].buffer.toString(), 'durable image');
  assert.equal(f.lead.attachments[0].filename, 'attachment_456.jpg');
});

test('CRM attachment recovers from WhatsApp when both storage lookups throw', async () => {
  const f = setup();
  f.store.getMediaFile = f.store.getMediaFileByMediaId = async () => { throw Error('storage unavailable'); };
  let downloads = 0;
  f.whatsapp.downloadMedia = async id => {
    assert.equal(id, '456');
    downloads++;
    return { buffer: Buffer.from('recovered original'), mimeType: 'image/jpeg' };
  };
  f.store.saveMediaFile = async file => {
    assert.equal(file.mediaId, '456');
    return { storageReference: 'recovered-file', filename: '456.jpg' };
  };
  assert.equal((await f.sync()).success, true);
  assert.equal(downloads, 1);
  assert.equal(f.uploads[0].buffer.toString(), 'recovered original');
  assert.equal(f.lead.attachments[0].storageReference, 'recovered-file');
  assert.equal(f.lead.attachments[0].filename, '456.jpg');
});

test('CRM attachment uploads recovered bytes even if persisting the recovery copy fails', async () => {
  const f = setup();
  f.store.saveMediaFile = async () => { throw Error('storage unavailable'); };
  assert.equal((await f.sync()).success, true);
  assert.equal(f.uploads[0].buffer.toString(), 'original image');
  assert.equal(f.lead.attachments[0].zohoUploadStatus, 'uploaded');
});

test('empty stored attachment bytes trigger recovery rather than an empty Zoho upload', async () => {
  const f = setup();
  f.store.getMediaFile = async () => ({ buffer: Buffer.alloc(0) });
  f.store.getMediaFileByMediaId = async () => Buffer.alloc(0);
  assert.equal((await f.sync()).success, true);
  assert.equal(f.uploads[0].buffer.toString(), 'original image');
});

test('each uploaded attachment is checkpointed before the next provider upload begins', async () => {
  const f = setup([
    { mediaId: '456', filename: 'first.jpg', mimeType: 'image/jpeg' },
    { mediaId: '789', filename: 'second.jpg', mimeType: 'image/jpeg' },
  ]);
  const upload = f.zoho.uploadLeadAttachment;
  f.zoho.uploadLeadAttachment = async (id, file) => {
    if (file.filename === 'second.jpg') {
      assert.equal(f.checkpoints.length, 1);
      assert.equal(f.checkpoints[0][0].zohoAttachmentId, '1001');
      assert.equal(f.checkpoints[0][0].zohoUploadStatus, 'uploaded');
      throw Error('second upload failed');
    }
    return upload(id, file);
  };
  assert.equal((await f.sync()).success, false);
  assert.equal(f.checkpoints.length, 2);
  assert.equal(f.checkpoints[1][1].zohoUploadStatus, 'failed');
  f.zoho.uploadLeadAttachment = upload;
  assert.equal((await f.sync()).success, true);
  assert.deepEqual(f.uploads.map(file => file.filename), ['first.jpg', 'second.jpg']);
});

test('CRM attachment retry reuses confirmed snake-case provider IDs', async () => {
  const f = setup([
    { filename: 'existing.jpg', zoho_upload_status: 'uploaded', zoho_attachment_id: '1000', zoho_lead_id: '123' },
    { mediaId: '789', filename: 'new.jpg', mimeType: 'image/jpeg' },
  ]);
  f.lead.zoho_lead_id = '123';
  assert.equal((await f.sync()).success, true);
  assert.deepEqual(f.uploads.map(file => file.filename), ['new.jpg']);
});
