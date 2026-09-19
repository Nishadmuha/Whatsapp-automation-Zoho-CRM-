'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { handleZohoSync } = require('../src/services/leads/bossLeadWorkflow');
function setup() {
  const lead = { id: 'local-lead', contact_name: 'Sam', phone: '+971501234567', attachments: [{ storageReference: 'media1', filename: 'card.jpg', mimeType: 'image/jpeg' }, { storageReference: 'media2', filename: 'voice.ogg', mimeType: 'audio/ogg' }] };
  const replies = [], uploads = []; let creates = 0;
  const store = {
    async getLead() { return structuredClone(lead); },
    async updateLeadZohoStatus(_id, data) { for (const [key, value] of Object.entries(data)) { const mapped = ({ zohoStatus: 'zoho_status', zohoLeadId: 'zoho_lead_id', zohoUrl: 'zoho_url' })[key] || key; lead[mapped] = value; } },
    async getMediaFile(ref) { return { buffer: Buffer.from(ref), mimeType: ref === 'media1' ? 'image/jpeg' : 'audio/ogg' }; },
    async updateLeadAttachments(_id, attachments) { lead.attachments = structuredClone(attachments); },
    async updateReplyText(_id, text) { replies.push(text); },
  };
  const zoho = {
    async searchLeadByPhone() { return null; },
    async createLead() { creates++; return { id: 'EXACT-ZOHO-ID' }; },
    async updateLead(id) { return { id }; },
    async uploadLeadAttachment(id, file) { assert.equal(lead.zoho_lead_id, id, 'ID persisted before upload'); uploads.push({ id, file }); return { id: 'att-' + uploads.length }; },
  };
  const sync = () => handleZohoSync({ leadId: lead.id, store, zoho, config: {}, messageId: 'incoming' });
  return { lead, store, zoho, sync, uploads, replies, creates: () => creates };
}
test('image and voice attachments link to exact returned CRM ID before success', async () => {
  const f = setup(); assert.equal((await f.sync()).success, true);
  assert.deepEqual(f.uploads.map(u => u.id), ['EXACT-ZOHO-ID', 'EXACT-ZOHO-ID']); assert.equal(f.lead.zoho_status, 'saved');
  assert.ok(f.lead.attachments.every(a => a.zohoAttachmentId && a.zohoLeadId === 'EXACT-ZOHO-ID'));
});
test('partial attachment failure preserves lead ID and retries without recreating', async () => {
  const f = setup(); const original = f.zoho.uploadLeadAttachment;
  f.zoho.uploadLeadAttachment = async (id, file) => { if (file.filename === 'voice.ogg') throw Error('upload failed'); return original(id, file); };
  assert.equal((await f.sync()).success, false); assert.equal(f.lead.zoho_status, 'failed'); assert.equal(f.lead.zoho_lead_id, 'EXACT-ZOHO-ID'); assert.match(f.replies.at(-1), /attachments failed/);
  f.zoho.uploadLeadAttachment = original; assert.equal((await f.sync()).success, true); assert.equal(f.creates(), 1); assert.equal(f.uploads.length, 2);
});
test('missing attachment bytes or missing provider attachment ID cannot claim success', async () => {
  for (const mode of ['bytes', 'id']) {
    const f = setup(); if (mode === 'bytes') f.store.getMediaFile = async () => null; else f.zoho.uploadLeadAttachment = async () => ({});
    assert.equal((await f.sync()).success, false); assert.equal(f.lead.zoho_status, 'failed'); assert.equal(f.creates(), 1);
  }
});
test('CRM duplicate lookup failure fails closed instead of creating another lead', async () => {
  const f = setup(); f.zoho.searchLeadByPhone = async () => { throw Error('unavailable'); };
  assert.equal((await f.sync()).success, false); assert.equal(f.creates(), 0);
});
