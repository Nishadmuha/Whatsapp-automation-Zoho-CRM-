'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { handleZohoSync } = require('../src/services/leads/bossLeadWorkflow');
const { formatBossFinalSuccessMessage } = require('../src/services/leads/bossConversation');
function setup() {
  const lead = { id: 'local-lead', contact_name: 'Sam', company_name: 'Example LLC', phone: '+971501234567', email: 'sam@example.com', attachments: [{ storageReference: 'media1', filename: 'card.jpg', mimeType: 'image/jpeg' }, { storageReference: 'media2', filename: 'voice.ogg', mimeType: 'audio/ogg' }] };
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
    async searchLeadByEmail() { return null; },
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
  const reply = f.replies.at(-1);
  assert.match(reply, /^✅ Lead Saved Successfully/);
  assert.match(reply, /👤 Contact: Sam\n🏢 Company: Example LLC\n📞 Phone: \+971501234567\n📧 Email: sam@example.com/);
  assert.match(reply, /Attachments \(2\):\n1 image attached ✅\n1 voice message attached ✅/);
  assert.match(reply, /✅ card.jpg — uploaded to Zoho/);
  assert.match(reply, /✅ voice.ogg — uploaded to Zoho/);
  assert.match(reply, /🖼️ All attachments uploaded to Zoho ✅/);
  assert.match(reply, /Zoho Sync:\nSaved successfully ✅\n✅ Saved to MongoDB\n✅ Synced to Zoho CRM$/);
});
test('partial attachment failure preserves lead ID and retries without recreating', async () => {
  const f = setup(); const original = f.zoho.uploadLeadAttachment;
  f.zoho.uploadLeadAttachment = async (id, file) => { if (file.filename === 'voice.ogg') throw Error('upload failed'); return original(id, file); };
  assert.equal((await f.sync()).success, false); assert.equal(f.lead.zoho_status, 'failed'); assert.equal(f.lead.zoho_lead_id, 'EXACT-ZOHO-ID');
  const reply = f.replies.at(-1);
  assert.match(reply, /Lead ID: EXACT-ZOHO-ID/);
  assert.match(reply, /https:\/\/crm.zoho.com\/crm\/tab\/Leads\/EXACT-ZOHO-ID/);
  assert.match(reply, /👤 Contact: Sam/);
  assert.match(reply, /Attachments \(2\):\n1 image attached ✅\n1 voice message received/);
  assert.match(reply, /✅ card.jpg — uploaded to Zoho/);
  assert.match(reply, /❌ voice.ogg — upload failed: upload failed/);
  assert.match(reply, /1 of 2 attachments uploaded to Zoho/);
  assert.match(reply, /Attachment sync incomplete/);
  assert.doesNotMatch(reply, /All attachments uploaded|1 voice message attached ✅/);
  f.zoho.uploadLeadAttachment = original; assert.equal((await f.sync()).success, true); assert.equal(f.creates(), 1); assert.equal(f.uploads.length, 2);
  assert.match(f.replies.at(-1), /All attachments uploaded to Zoho/);
});
test('missing attachment bytes or missing provider attachment ID cannot claim success', async () => {
  for (const mode of ['bytes', 'id']) {
    const f = setup(); if (mode === 'bytes') f.store.getMediaFile = async () => null; else f.zoho.uploadLeadAttachment = async () => ({});
    assert.equal((await f.sync()).success, false); assert.equal(f.lead.zoho_status, 'failed'); assert.equal(f.creates(), 1);
    assert.match(f.replies.at(-1), /Attachments \(2\):/);
    assert.match(f.replies.at(-1), /0 of 2 attachments uploaded to Zoho/);
    assert.doesNotMatch(f.replies.at(-1), /All attachments uploaded|original files are retained/);
  }
});

test('pending attachment uploader retains detailed reply without claiming upload success', async () => {
  const f = setup(); delete f.zoho.uploadLeadAttachment;
  assert.equal((await f.sync()).success, false);
  assert.match(f.replies.at(-1), /⏳ card.jpg — pending upload/);
  assert.match(f.replies.at(-1), /⏳ voice.ogg — pending upload/);
  assert.doesNotMatch(f.replies.at(-1), /All attachments uploaded|attached ✅/);
});

test('five image success uses requested confirmation format on save and repeated sync', async () => {
  const f = setup();
  f.lead.attachments = Array.from({ length: 5 }, (_, i) => ({ storageReference: 'media1', filename: `photo${i + 1}.jpg`, mimeType: 'image/jpeg' }));
  assert.equal((await f.sync()).success, true);
  const expected = [
    '✅ Lead Saved Successfully', '', 'Zoho CRM:', 'Lead ID: EXACT-ZOHO-ID', '🆔 Zoho Lead ID: EXACT-ZOHO-ID', '',
    'Open Lead:', 'https://crm.zoho.com/crm/tab/Leads/EXACT-ZOHO-ID', '🔗 Zoho Lead: https://crm.zoho.com/crm/tab/Leads/EXACT-ZOHO-ID',
    '👤 Contact: Sam', '🏢 Company: Example LLC', '📞 Phone: +971501234567', '📧 Email: sam@example.com', '',
    'Attachments (5):', '5 images attached ✅', ...f.lead.attachments.map(a => `  ✅ ${a.filename} — uploaded to Zoho`), '',
    '🖼️ All attachments uploaded to Zoho ✅', '', 'Zoho Sync:', 'Saved successfully ✅', '✅ Saved to MongoDB', '✅ Synced to Zoho CRM',
  ].join('\n');
  assert.equal(f.replies.at(-1), expected);
  assert.equal((await f.sync()).success, true);
  assert.equal(f.replies.at(-1), expected);
  assert.equal(f.uploads.length, 5);
});

test('DWG attachment is listed as a document even when its MIME starts with image', async () => {
  const f = setup();
  f.lead.attachments = [{ storageReference: 'media1', filename: 'drawing.dwg', type: 'document', mimeType: 'image/vnd.dwg' }];
  f.store.getMediaFile = async () => ({ buffer: Buffer.from('drawing'), mimeType: 'image/vnd.dwg' });
  assert.equal((await f.sync()).success, true);
  assert.match(f.replies.at(-1), /1 document attached ✅/);
  assert.doesNotMatch(f.replies.at(-1), /1 image attached/);
});

test('large attachment receipts fit WhatsApp while retaining failures and the final sync status', () => {
  const attachments = Array.from({ length: 100 }, (_, i) => ({ filename: `drawing-${i}.jpg`, type: 'image',
    zohoUploadStatus: 'uploaded', zohoAttachmentId: String(i + 1), zohoLeadId: '123' }));
  attachments[99] = { filename: 'last-drawing.dwg', type: 'document', zohoUploadStatus: 'failed', zohoError: 'Media file buffer not found' };
  const reply = formatBossFinalSuccessMessage({ contact: 'Sam', zohoLeadId: '123',
    zohoUrl: 'https://crm.zoho.com/crm/tab/Leads/123', attachments });
  assert.ok(reply.length <= 4096);
  assert.match(reply, /Attachments \(100\):/);
  assert.match(reply, /❌ last-drawing.dwg — upload failed/);
  assert.match(reply, /more files; see the complete list in the admin panel/);
  assert.match(reply, /99 of 100 attachments uploaded/);
  assert.match(reply, /Attachment sync incomplete$/);
});
test('CRM duplicate lookup failure fails closed instead of creating another lead', async () => {
  const f = setup(); f.zoho.searchLeadByPhone = async () => { throw Error('unavailable'); };
  assert.equal((await f.sync()).success, false); assert.equal(f.creates(), 0);
});
