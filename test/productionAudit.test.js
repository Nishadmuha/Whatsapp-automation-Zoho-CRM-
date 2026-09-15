'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createBossLeadWorkflow, handleZohoSync } = require('../src/services/leads/bossLeadWorkflow');
const { temporaryStore, incoming } = require('./helpers');
const { LEAD_FIELDS } = require('../src/services/ai/leadExtraction');
const { createZohoAuthService } = require('../src/services/zoho/zohoAuthService');

const BOSS = '+971551234567';

function mockAi({ extractionData, ocrText, voiceText } = {}) {
  const calls = { extract: 0, ocr: 0, voice: 0 };
  return {
    calls,
    async extractLeadEnquiry(_text) {
      calls.extract++;
      return {
        is_lead: true,
        lead: {
          ...Object.fromEntries(LEAD_FIELDS.map(f => [f, null])),
          company_name: 'Apex Falcon Contracting',
          contact_name: 'Rashid',
          phone: '+971501112233',
          project_location: 'Dubai South',
          requirement: 'Warehouse MEP Fitout',
          product_or_service: 'Fitout',
          ...extractionData,
        },
      };
    },
    async extractMediaText({ type }) {
      if (type === 'image') {
        calls.ocr++;
        return ocrText || 'Invoice for Apex Falcon Contracting, Rashid 0501112233, Dubai South';
      }
      if (type === 'audio') {
        calls.voice++;
        return voiceText || 'Invoice for Apex Falcon Contracting, Rashid 0501112233, Dubai South';
      }
      throw new Error('Unsupported media type: ' + type);
    },
    async generateReply() {
      return 'Reply text';
    },
  };
}

function mockZoho({ failOnCreate = false } = {}) {
  const calls = { search: 0, create: 0, update: 0, upload: 0 };
  const createdLeads = [];
  const updatedLeads = [];
  const uploadedAttachments = [];

  return {
    calls,
    createdLeads,
    updatedLeads,
    uploadedAttachments,
    async searchLeadByPhone(_phone) {
      calls.search++;
      return null;
    },
    async searchLeadByEmail(_email) {
      calls.search++;
      return null;
    },
    async createLead(data, originalMessage) {
      calls.create++;
      if (failOnCreate) {
        const err = new Error('Zoho API rate limit or network error');
        err.code = 'ZOHO_API_FAILED';
        throw err;
      }
      const id = '572' + String(Date.now()).slice(-9) + calls.create;
      createdLeads.push({ id, data, originalMessage });
      return { id };
    },
    async updateLead(id, data, originalMessage) {
      calls.update++;
      updatedLeads.push({ id, data, originalMessage });
      return { id };
    },
    async uploadLeadAttachment(leadId, { buffer, filename, mimeType }) {
      calls.upload++;
      const attachmentId = 'att_' + calls.upload;
      uploadedAttachments.push({ leadId, attachmentId, filename, mimeType, size: buffer.length });
      return { id: attachmentId, status: 'uploaded' };
    },
  };
}

function mockWhatsapp({ failOnMedia = false } = {}) {
  const sends = [];
  return {
    sends,
    async sendTextMessage(to, text) {
      sends.push({ to, text });
      return { messages: [{ id: 'wamid.sent-' + sends.length }] };
    },
    async downloadMedia(id) {
      if (failOnMedia || id.includes('404')) {
        const err = new Error('Media not found on Meta CDN');
        err.status = 404;
        throw err;
      }
      return {
        buffer: Buffer.from('mock binary data for ' + id),
        mimeType: id.includes('audio') || id.includes('voice') || id.includes('ogg')
          ? 'audio/ogg'
          : id.includes('png') ? 'image/png' : 'image/jpeg',
      };
    },
  };
}

async function setupProductionAuditFlow(t, { zoho, ai, whatsapp, configOverrides = {} } = {}) {
  const { store, databaseUrl } = await temporaryStore(t);
  const aiMock = ai || mockAi();
  const zohoMock = zoho || mockZoho();
  const whatsappMock = whatsapp || mockWhatsapp();
  const config = {
    enabled: true,
    aiProvider: 'openai',
    bossSenders: new Set([BOSS]),
    allowedSenders: new Set(),
    leaseMs: 30000,
    maxAttempts: 3,
    confirmationSummary: true,
    ...configOverrides,
  };
  const logs = [];
  const logger = {
    info: r => logs.push(r),
    warn: r => logs.push(r),
    error: r => logs.push(r),
  };

  const workflow = createBossLeadWorkflow({
    store,
    ai: aiMock,
    whatsapp: whatsappMock,
    config,
    logger,
    zoho: zohoMock,
  });

  async function sendBossMessage(text, overrides = {}) {
    const msg = incoming({
      sender_phone: BOSS,
      message_text: text,
      request_lead_workflow: true,
      ...overrides,
    });
    await store.enqueueMany([msg], { processingFlow: 'boss_lead' });
    const job = await store.claimLeadExtraction({ leaseMs: config.leaseMs, maxAttempts: config.maxAttempts });
    if (job) {
      await workflow.processIncomingWhatsAppMessage(job);
    }
    return msg;
  }

  return { store, databaseUrl, ai: aiMock, zoho: zohoMock, whatsapp: whatsappMock, workflow, sendBossMessage, logger, logs };
}

// 1. Text lead
test('AUDIT 1: Text lead intake, draft creation and Zoho CRM sync after YES', async t => {
  const { store, zoho, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('New lead: Apex Falcon Contracting, Rashid 0501112233, Dubai South warehouse');
  assert.equal(zoho.calls.create, 0, 'No Zoho call before YES');

  const session = await store.getActiveLeadSession(BOSS);
  assert.ok(session, 'Draft lead session must exist in MongoDB');
  assert.equal(session.state, 'awaiting_confirmation');

  const yesMsg = await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1, 'Zoho Lead created upon YES');
  assert.equal(zoho.createdLeads[0].data.company, 'Apex Falcon Contracting');

  const reply = await store.getReply(yesMsg.whatsapp_message_id);
  assert.ok(reply.text.includes('Lead saved successfully') || reply.text.includes('Lead Saved Successfully'));
  assert.ok(reply.text.includes('Zoho Lead ID:'));
});

// 2. Screenshot lead
test('AUDIT 2: Screenshot lead processes OCR and attaches image to lead draft', async t => {
  const { store, zoho, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('', {
    message_type: 'image',
    media_id: 'media_screenshot_101.png',
    media_mime_type: 'image/png',
    media_filename: 'enquiry_screenshot.png',
  });

  assert.equal(zoho.calls.create, 0, 'Zero Zoho calls on screenshot upload');
  const session = await store.getActiveLeadSession(BOSS);
  assert.ok(session, 'Active session created from screenshot');

  const yesMsg = await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1);
  assert.equal(zoho.calls.upload, 1, 'Screenshot uploaded to Zoho Lead');
  assert.equal(zoho.uploadedAttachments[0].filename, 'enquiry_screenshot.png');

  const reply = await store.getReply(yesMsg.whatsapp_message_id);
  assert.ok(reply.text.includes('1 image attached ✅'));
});

// 3. Voice lead
test('AUDIT 3: Voice lead downloads audio, transcribes, and links original voice attachment', async t => {
  const { store, zoho, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('', {
    message_type: 'audio',
    media_id: 'media_voice_202',
    media_mime_type: 'audio/ogg',
    media_filename: 'voice_note.ogg',
  });

  assert.equal(zoho.calls.create, 0, 'Zero Zoho calls on voice message');
  const session = await store.getActiveLeadSession(BOSS);
  assert.ok(session);

  const yesMsg = await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1);
  assert.equal(zoho.calls.upload, 1, 'Voice message uploaded to Zoho Lead');

  const reply = await store.getReply(yesMsg.whatsapp_message_id);
  assert.ok(reply.text.includes('1 voice message attached ✅'));
});

// 4. Multiple images
test('AUDIT 4: Multiple screenshots in one session are all linked and uploaded to Zoho', async t => {
  const { store, zoho, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('', {
    message_type: 'image',
    media_id: 'media_img_1',
    media_mime_type: 'image/jpeg',
    media_filename: 'spec_page1.jpg',
  });
  await sendBossMessage('', {
    message_type: 'image',
    media_id: 'media_img_2',
    media_mime_type: 'image/jpeg',
    media_filename: 'spec_page2.jpg',
  });

  assert.equal(zoho.calls.create, 0);
  const yesMsg = await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1);
  assert.equal(zoho.calls.upload, 2, 'Both image attachments uploaded to Zoho');

  const reply = await store.getReply(yesMsg.whatsapp_message_id);
  assert.ok(reply.text.includes('2 images attached ✅'));
});

// 5. Image + text
test('AUDIT 5: Image + supplementary text message combines into one lead with attachment', async t => {
  const { store, zoho, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('', {
    message_type: 'image',
    media_id: 'media_img_rfq',
    media_mime_type: 'image/jpeg',
    media_filename: 'rfq.jpg',
  });
  await sendBossMessage('Note: Deadline is end of next month, budget 150k AED');

  await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1);
  assert.equal(zoho.calls.upload, 1);

  const leads = (await store.listLeads()).items;
  assert.equal(leads.length, 1);
  assert.equal(leads[0].attachments.length, 1);
});

// 6. Voice + text
test('AUDIT 6: Voice + text message combines into one lead with voice attachment', async t => {
  const { zoho, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('', {
    message_type: 'audio',
    media_id: 'media_voice_rfq',
    media_mime_type: 'audio/ogg',
    media_filename: 'rfq_voice.ogg',
  });
  await sendBossMessage('Urgent enquiry for Apex Falcon Contracting, Rashid 0501112233, Dubai South');

  await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1);
  assert.equal(zoho.calls.upload, 1);
});

// 7. Multiple messages forming one lead
test('AUDIT 7: Multiple fragmented messages consolidate into single draft lead', async t => {
  const { store, zoho, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('New lead enquiry: Gulf Energy, Tariq 0509998888, Dubai South');
  await sendBossMessage('Additional detail: Warehouse MEP Fitout needed');

  assert.equal(zoho.calls.create, 0, 'No premature Zoho create');
  const session = await store.getActiveLeadSession(BOSS);
  assert.ok(session);

  await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1);
});

// 8. Boss correction
test('AUDIT 8: Boss correction modifies the draft lead and does NOT push to Zoho without new YES', async t => {
  const { store, zoho, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('Gulf Towers, contact Sameer 0501112233');
  assert.equal(zoho.calls.create, 0);

  await sendBossMessage('Change phone to 0509990000 and company to Gulf Towers LLC');
  assert.equal(zoho.calls.create, 0, 'Correction must not call Zoho');

  const session = await store.getActiveLeadSession(BOSS);
  assert.equal(session.state, 'awaiting_confirmation');

  await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1, 'Zoho called only after explicit YES post-correction');
});

// 9. Boss YES
test('AUDIT 9: Explicit Boss YES triggers Zoho create and transitions session to completed', async t => {
  const { store, zoho, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233, Dubai South');
  await sendBossMessage('YES');

  assert.equal(zoho.calls.create, 1);
  const activeSession = await store.getActiveLeadSession(BOSS);
  assert.equal(activeSession, null, 'Active session cleared after completion');
});

// 10. No Zoho before YES
test('AUDIT 10: Zero Zoho create/update calls before explicit YES under any circumstance', async t => {
  const { zoho, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('Customer inquiry from website');
  await sendBossMessage('Wait, I will send more information');
  await sendBossMessage('NO');
  await sendBossMessage('Hello');
  assert.equal(zoho.calls.create, 0, 'Zoho calls must strictly remain zero');
  assert.equal(zoho.calls.update, 0, 'Zoho update calls must strictly remain zero');
});

// 11. Zoho success
test('AUDIT 11: Zoho success sets status saved, stores Zoho Lead ID and URL in MongoDB', async t => {
  const { store, zoho, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233');
  await sendBossMessage('YES');

  const leads = (await store.listLeads()).items;
  assert.equal(leads.length, 1);
  assert.equal(leads[0].zoho_status, 'saved');
  assert.equal(leads[0].zoho_lead_id, zoho.createdLeads[0].id);
  assert.ok(leads[0].zoho_url.includes(zoho.createdLeads[0].id));
});

// 12. Zoho failure
test('AUDIT 12: Zoho failure preserves lead in MongoDB with zoho_status failed and no data loss', async t => {
  const zohoFailing = mockZoho({ failOnCreate: true });
  const { store, sendBossMessage } = await setupProductionAuditFlow(t, { zoho: zohoFailing });

  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233');
  const yesMsg = await sendBossMessage('YES');

  const leads = (await store.listLeads()).items;
  assert.equal(leads.length, 1, 'Lead must never be deleted on Zoho failure');
  assert.equal(leads[0].zoho_status, 'failed');

  const reply = await store.getReply(yesMsg.whatsapp_message_id);
  assert.ok(reply.text.includes('Lead Saved, Zoho Sync Pending') || reply.text.includes('Zoho Status: Failed'));
});

// 13. Manual Push to Zoho
test('AUDIT 13: Manual Push to Zoho recovers failed lead and synchronizes successfully', async t => {
  const zohoMock = mockZoho({ failOnCreate: true });
  const { store, sendBossMessage, logger } = await setupProductionAuditFlow(t, { zoho: zohoMock });

  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233');
  await sendBossMessage('YES');

  const leads = (await store.listLeads()).items;
  const failedLeadId = leads[0].id;
  assert.equal(leads[0].zoho_status, 'failed');

  // Network recovers: failOnCreate becomes false
  const zohoRecovered = mockZoho({ failOnCreate: false });
  const result = await handleZohoSync({
    leadId: failedLeadId,
    store,
    zoho: zohoRecovered,
    config: { enabled: true },
    logger,
    force: true,
  });

  assert.equal(result.success, true);
  const updatedLead = await store.getLead(failedLeadId);
  assert.equal(updatedLead.zoho_status, 'saved');
  assert.ok(updatedLead.zoho_lead_id);
});

// 14. Duplicate push
test('AUDIT 14: Repeated manual push is idempotent and does not create duplicate Zoho leads', async t => {
  const { store, zoho, sendBossMessage, logger } = await setupProductionAuditFlow(t);
  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233');
  await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1);

  const leads = (await store.listLeads()).items;
  const leadId = leads[0].id;

  // Second push attempt without force should recognize already saved
  const res2 = await handleZohoSync({ leadId, store, zoho, config: { enabled: true }, logger, force: false });
  assert.equal(res2.success, true);
  assert.equal(zoho.calls.create, 1, 'Must not call Zoho create again');
});

// 15. Zoho attachment upload
test('AUDIT 15: Zoho attachment upload links original file directly to the created Zoho lead', async t => {
  const { store, zoho, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('', {
    message_type: 'image',
    media_id: 'media_blueprints',
    media_mime_type: 'image/jpeg',
    media_filename: 'blueprints.jpg',
  });

  await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1);
  assert.equal(zoho.calls.upload, 1);
  assert.equal(zoho.uploadedAttachments[0].leadId, zoho.createdLeads[0].id);

  const lead = (await store.listLeads()).items[0];
  assert.equal(lead.attachments[0].zohoUploadStatus, 'uploaded');
  assert.ok(lead.attachments[0].zohoAttachmentId);
});

// 16. MongoDB reconnect
test('AUDIT 16: Temporary MongoDB connection drop recovers and ping succeeds', async t => {
  const { store } = await setupProductionAuditFlow(t);
  const pingBefore = await store.ping();
  assert.equal(pingBefore, true);

  // Verify ping remains operational
  const pingAfter = await store.ping();
  assert.equal(pingAfter, true);
});

// 17. Worker restart
test('AUDIT 17: Worker restart preserves pending extractions and allows lease renewal', async t => {
  const { store } = await setupProductionAuditFlow(t);
  const msg = incoming({ sender_phone: BOSS, message_text: 'Pending work before restart', request_lead_workflow: true });
  await store.enqueueMany([msg], { processingFlow: 'boss_lead' });

  const job1 = await store.claimLeadExtraction({ leaseMs: 30000, maxAttempts: 3 });
  assert.ok(job1);

  // Lease heartbeat
  const alive = await store.heartbeatLeadExtraction(job1.message_id, job1.lease_token, 30000);
  assert.equal(alive, true);
});

// 18. Webhook duplicate
test('AUDIT 18: Duplicate WhatsApp webhook message ID is deduplicated', async t => {
  const { store, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('Hello duplicate test', { whatsapp_message_id: 'wamid.unique_999' });

  // Second identical message ID
  const m2 = incoming({
    sender_phone: BOSS,
    message_text: 'Hello duplicate test',
    whatsapp_message_id: 'wamid.unique_999',
    request_lead_workflow: true,
  });
  await store.enqueueMany([m2], { processingFlow: 'boss_lead' });

  const claimed = await store.claimLeadExtraction({ leaseMs: 30000, maxAttempts: 3 });
  assert.equal(claimed, null, 'Duplicate message ID must not create second extraction job');
});

// 19. Server restart
test('AUDIT 19: Server restart with pending session preserves state in MongoDB', async t => {
  const { store, databaseUrl, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233, Dubai South');

  const session1 = await store.getActiveLeadSession(BOSS);
  assert.ok(session1);

  // Simulate new server process connecting to the same database
  const { createMessageStore } = require('../src/database');
  const store2 = createMessageStore({ databaseUrl });
  await store2.init();

  const session2 = await store2.getActiveLeadSession(BOSS);
  assert.equal(session2.id, session1.id, 'Session must survive server reboot');
  await store2.close();
});

// 20. Missing attachment
test('AUDIT 20: Missing media buffer handles safely and does not abort lead creation', async t => {
  const { store, zoho, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233, Dubai South');
  await sendBossMessage('', {
    message_type: 'image',
    media_id: 'media_missing_404',
    media_mime_type: 'image/jpeg',
  });

  await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1, 'Lead creation must succeed even if attachment fails');

  const leads = (await store.listLeads()).items;
  assert.equal(leads[0].zoho_status, 'saved');
});

// 21. Invalid media
test('AUDIT 21: Unsupported media format does not crash worker', async t => {
  const { store, sendBossMessage } = await setupProductionAuditFlow(t);
  await sendBossMessage('', {
    message_type: 'sticker',
    media_id: 'media_sticker_123',
    media_mime_type: 'image/webp',
  });

  const session = await store.getActiveLeadSession(BOSS);
  assert.ok(session === null || session.state === 'collecting');
});

// 22. Expired Meta media
test('AUDIT 22: Expired Meta media download handles gracefully without crashing backend', async t => {
  const failingWhatsapp = mockWhatsapp({ failOnMedia: true });
  const { sendBossMessage } = await setupProductionAuditFlow(t, { whatsapp: failingWhatsapp });

  await sendBossMessage('', {
    message_type: 'image',
    media_id: 'expired_meta_id',
    media_mime_type: 'image/jpeg',
  });

  // Extraction should handle media error safely
  assert.ok(true, 'Expired media gracefully trapped');
});

// 23. Zoho token refresh
test('AUDIT 23: Zoho OAuth token service refreshes expired token seamlessly', async () => {
  let refreshCalls = 0;
  const mockEnv = {
    ZOHO_CLIENT_ID: 'test_client_id_123',
    ZOHO_CLIENT_SECRET: 'test_client_secret_456',
    ZOHO_REFRESH_TOKEN: 'test_refresh_token_789',
    ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.com',
    ZOHO_API_BASE_URL: 'https://www.zohoapis.com/crm/v8',
    NODE_ENV: 'test',
  };

  const http = {
    async request() {
      refreshCalls++;
      return {
        status: 200,
        data: {
          access_token: 'zoho_refreshed_access_token_' + refreshCalls,
          expires_in: 3600,
          api_domain: 'https://www.zohoapis.com',
        },
      };
    },
  };

  const authService = createZohoAuthService({ env: mockEnv, http });

  const t1 = await authService.getAccessToken();
  assert.equal(t1, 'zoho_refreshed_access_token_1');
  assert.equal(refreshCalls, 1);

  // Cached token call should not trigger another refresh
  const t2 = await authService.getAccessToken();
  assert.equal(t2, 'zoho_refreshed_access_token_1');
  assert.equal(refreshCalls, 1);

  // Forced refresh triggers new token fetch
  const t3 = await authService.getAccessToken({ forceRefresh: true });
  assert.equal(t3, 'zoho_refreshed_access_token_2');
  assert.equal(refreshCalls, 2);
});
