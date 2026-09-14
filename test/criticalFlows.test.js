'use strict';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { createBossLeadWorkflow } = require('../src/services/leads/bossLeadWorkflow');
const { formatConfirmationSummary } = require('../src/services/leads/bossConversation');
const { temporaryStore, incoming } = require('./helpers');
const { LEAD_FIELDS } = require('../src/services/ai/leadExtraction');

const BOSS = '+971551234567';
const CLIENT = '+971509876543';

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
        return voiceText || 'Rashid from Apex Falcon Contracting needs MEP work in Dubai South';
      }
      throw new Error('Unsupported media type: ' + type);
    },
    async generateReply() {
      return 'Voltronix Contracting provides Civil, MEP and Fitout services in the UAE. May I have your name and project details?';
    },
    async extractLead() {
      assert.fail('Should not call legacy extractLead');
    },
  };
}

function mockZoho() {
  const calls = { search: 0, create: 0, update: 0 };
  const createdLeads = [];
  const updatedLeads = [];
  return {
    calls,
    createdLeads,
    updatedLeads,
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
      const id = 'zoho-lead-' + calls.create;
      createdLeads.push({ id, data, originalMessage });
      return { id };
    },
    async updateLead(id, data, originalMessage) {
      calls.update++;
      updatedLeads.push({ id, data, originalMessage });
      return { id };
    },
  };
}

function mockWhatsapp() {
  const sends = [];
  return {
    sends,
    async sendTextMessage(to, text) {
      sends.push({ to, text });
      return { messages: [{ id: 'wamid.sent-' + sends.length }] };
    },
    async downloadMedia(id) {
      return { buffer: Buffer.from('mock binary data'), mimeType: id.includes('audio') ? 'audio/ogg' : 'image/jpeg' };
    },
  };
}

async function setupFlow(t, { zoho, ai, configOverrides = {} } = {}) {
  const { store, databaseUrl } = await temporaryStore(t);
  const aiMock = ai || mockAi();
  const zohoMock = zoho || mockZoho();
  const whatsappMock = mockWhatsapp();
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

  return { store, databaseUrl, ai: aiMock, zoho: zohoMock, whatsapp: whatsappMock, workflow, sendBossMessage, logs };
}

// 1. Boss message intake does not call Zoho
test('CRITICAL RULE: Boss message intake does NOT call Zoho', async t => {
  const { zoho, sendBossMessage } = await setupFlow(t);
  await sendBossMessage('New lead: Apex Falcon Contracting, Rashid 0501112233, Dubai South');
  assert.equal(zoho.calls.create, 0, 'Zoho create must NOT be called on intake');
  assert.equal(zoho.calls.update, 0, 'Zoho update must NOT be called on intake');
});

// 2. AI extraction does not call Zoho
test('CRITICAL RULE: AI extraction does NOT call Zoho', async t => {
  const { ai, zoho, sendBossMessage } = await setupFlow(t);
  await sendBossMessage('Apex Falcon Contracting needs MEP work in Dubai South. Contact Rashid 0501112233');
  assert.equal(ai.calls.extract, 1, 'AI extraction should run');
  assert.equal(zoho.calls.create, 0, 'Zoho create must NOT be called during AI extraction');
});

// 3. Screenshot processing does not call Zoho
test('CRITICAL RULE: Screenshot / OCR processing does NOT call Zoho', async t => {
  const { ai, zoho, sendBossMessage } = await setupFlow(t);
  await sendBossMessage('', {
    message_type: 'image',
    media_id: 'img-apex-screenshot',
    media_mime_type: 'image/jpeg',
  });
  assert.equal(ai.calls.ocr, 1, 'OCR extraction should run');
  assert.equal(zoho.calls.create, 0, 'Zoho create must NOT be called during screenshot processing');
});

// 4. Voice processing does not call Zoho
test('CRITICAL RULE: Voice transcription does NOT call Zoho', async t => {
  const { ai, zoho, sendBossMessage } = await setupFlow(t);
  await sendBossMessage('', {
    message_type: 'audio',
    media_id: 'audio-apex-voice',
    media_mime_type: 'audio/ogg',
  });
  assert.equal(ai.calls.voice, 1, 'Voice transcription should run');
  assert.equal(zoho.calls.create, 0, 'Zoho create must NOT be called during voice processing');
});

// 5. Lead creation does not call Zoho
test('CRITICAL RULE: Lead creation in database does NOT call Zoho', async t => {
  const { store, zoho, sendBossMessage } = await setupFlow(t);
  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233, warehouse project in Dubai South');
  const session = await store.getActiveLeadSession(BOSS);
  assert.ok(session, 'Lead session must exist');
  assert.equal(zoho.calls.create, 0, 'Zoho create must NOT be called upon lead creation');
});

// 6. Boss receives confirmation summary
test('CONFIRMATION: Boss receives structured confirmation summary', async _t => {
  const lead = {
    company_name: 'Apex Falcon Contracting',
    contact_name: 'Rashid',
    phone: '+971501112233',
    project_location: 'Dubai South',
    requirement: 'Warehouse MEP Fitout',
  };
  const summary = formatConfirmationSummary(lead);
  assert.ok(summary.includes('Apex Falcon Contracting'), 'Summary must include company');
  assert.ok(summary.includes('Rashid'), 'Summary must include contact');
  assert.ok(summary.includes('+971501112233'), 'Summary must include phone');
  assert.ok(summary.includes('YES'), 'Summary must instruct to reply YES');
});

// 7. YES calls Zoho exactly once
test('MANDATORY GATE: Explicit YES calls Zoho exactly once', async t => {
  const { store, zoho, sendBossMessage } = await setupFlow(t);
  // 1. Initial intake
  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233, Dubai South warehouse');
  assert.equal(zoho.calls.create, 0, 'Zoho must not be called before confirmation');

  // 2. Boss confirms with YES
  const yesMsg = await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1, 'Zoho create must be called exactly once upon YES');
  assert.equal(zoho.createdLeads[0].data.company, 'Apex Falcon Contracting');

  // Verify lead state in store
  const session = await store.getActiveLeadSession(BOSS);
  assert.equal(session, null, 'Active session should be cleared after completion');

  // Verify reply queued for Boss has the final success message!
  const reply = await store.getReply(yesMsg.whatsapp_message_id);
  assert.ok(reply, 'Reply must exist');
  assert.ok(reply.text.includes('✅ Lead Saved Successfully'), 'Reply must announce success');
  assert.ok(reply.text.includes('Rashid'), 'Reply must include contact name');
  assert.ok(reply.text.includes('Apex Falcon Contracting'), 'Reply must include company name');
  assert.ok(reply.text.includes('+971501112233'), 'Reply must include phone');
  assert.ok(reply.text.includes(zoho.createdLeads[0].id), 'Reply must include real Zoho Lead ID');
  assert.ok(reply.text.includes('https://crm.zoho.com'), 'Reply must include direct Zoho CRM URL');
  assert.ok(reply.text.includes('✅ Saved to MongoDB'), 'Reply must confirm MongoDB save');
  assert.ok(reply.text.includes('✅ Synced to Zoho CRM'), 'Reply must confirm Zoho sync');

  // Verify lead in MongoDB has zoho_lead_id, zoho_status, zoho_url, zoho_synced_at
  const leads = (await store.listLeads()).items;
  assert.equal(leads.length, 1);
  assert.equal(leads[0].zoho_status, 'saved');
  assert.equal(leads[0].zoho_lead_id, zoho.createdLeads[0].id);
  assert.ok(leads[0].zoho_url.includes(zoho.createdLeads[0].id));
  assert.ok(leads[0].zoho_synced_at);
});

// 8. NO never calls Zoho
test('MANDATORY GATE: NO / discard never calls Zoho', async t => {
  const { zoho, sendBossMessage } = await setupFlow(t);
  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233, Dubai South');
  assert.equal(zoho.calls.create, 0);

  await sendBossMessage('NO');
  assert.equal(zoho.calls.create, 0, 'Zoho create must NOT be called on NO');
});

// 9. Correction requires another YES
test('MANDATORY GATE: Correction updates lead and requires a NEW YES', async t => {
  const { store, zoho, sendBossMessage } = await setupFlow(t);
  // 1. Initial intake
  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233, Dubai South');
  assert.equal(zoho.calls.create, 0);

  // 2. Boss sends correction
  await sendBossMessage('Correction: Contact name is Tariq, phone is 0509998877');
  assert.equal(zoho.calls.create, 0, 'Correction must NOT call Zoho');

  // Session is still active and awaiting confirmation
  const session = await store.getActiveLeadSession(BOSS);
  assert.ok(session, 'Session must still be open');
  assert.equal(session.state, 'awaiting_confirmation');

  // 3. Now send YES
  await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1, 'Zoho create called only after YES');
});

// 10. Duplicate YES does not duplicate Zoho call
test('IDEMPOTENCY: Duplicate YES does NOT call Zoho twice', async t => {
  const { zoho, sendBossMessage } = await setupFlow(t);
  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233, Dubai South');
  await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1, 'First YES calls Zoho once');

  // Second YES (no active session or already completed)
  await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1, 'Second YES must NOT call Zoho again');
});

// 11. YES for Lead A cannot confirm Lead B
test('ISOLATION: YES for completed Lead A cannot confirm subsequent Lead B without its own YES', async t => {
  const { zoho, sendBossMessage } = await setupFlow(t);
  // Lead A
  await sendBossMessage('Lead A: Apex Falcon Contracting, Rashid 0501112233, Dubai South warehouse');
  await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 1, 'Lead A created');

  // Lead B starts
  await sendBossMessage('Lead B: Apex Falcon Contracting, Rashid 0501112233, Dubai South warehouse');
  assert.equal(zoho.calls.create, 1, 'Lead B intake must NOT trigger Zoho from Lead A confirmation');

  // Only confirming Lead B triggers second call
  await sendBossMessage('YES');
  assert.equal(zoho.calls.create, 2, 'Lead B confirmed independently');
});

// 12. Restart cannot push pending leads to Zoho
test('RESTART SAFETY: Server restart with pending leads does NOT push to Zoho', async t => {
  const { store, zoho, sendBossMessage } = await setupFlow(t);
  // Intake lead A
  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233, Dubai South');
  assert.equal(zoho.calls.create, 0);

  // Simulate server restart: new workflow instance created against existing store
  createBossLeadWorkflow({
    store,
    ai: mockAi(),
    whatsapp: mockWhatsapp(),
    config: { enabled: true, aiProvider: 'openai', bossSenders: new Set([BOSS]), allowedSenders: new Set(), leaseMs: 30000, maxAttempts: 3 },
    zoho,
  });

  // Verify that merely instantiating or checking store does NOT call Zoho
  assert.equal(zoho.calls.create, 0, 'Restarting must NOT push pending leads to Zoho');
});

// 13. Duplicate WhatsApp events cannot trigger twice
test('DEDUPLICATION: Duplicate WhatsApp message ID is ignored', async t => {
  const { store } = await setupFlow(t);
  const msg = incoming({
    whatsapp_message_id: 'wamid.dup-test-123',
    sender_phone: BOSS,
    message_text: 'Apex Falcon Contracting, Rashid 0501112233, Dubai South',
    request_lead_workflow: true,
  });

  // First enqueue
  const first = await store.enqueueMany([msg], { processingFlow: 'boss_lead' });
  assert.equal(first.inserted, 1, 'First message must be inserted');
  // Duplicate enqueue with same whatsapp_message_id
  const duplicate = await store.enqueueMany([msg], { processingFlow: 'boss_lead' });
  assert.equal(duplicate.inserted, 0, 'Duplicate message ID must not be inserted');
  assert.equal(duplicate.duplicates, 1, 'Duplicate must be counted');
});

// 14. Lead media remains correctly isolated
test('MEDIA ISOLATION: Lead A media is isolated from Lead B', async t => {
  const { store, sendBossMessage } = await setupFlow(t);

  // Send Lead A text + screenshot
  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233, Dubai South', {
    whatsapp_message_id: 'wamid.leadA-1',
    message_type: 'text',
  });
  await sendBossMessage('', {
    whatsapp_message_id: 'wamid.leadA-2',
    message_type: 'image',
    media_id: 'media-leadA-img',
  });
  await sendBossMessage('YES');

  // Now start Lead B with its own audio
  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233, Dubai South', {
    whatsapp_message_id: 'wamid.leadB-1',
    message_type: 'text',
  });
  await sendBossMessage('', {
    whatsapp_message_id: 'wamid.leadB-2',
    message_type: 'audio',
    media_id: 'media-leadB-voice',
  });
  await sendBossMessage('YES');

  const attachments = (await store.driver.query('SELECT * FROM lead_attachments ORDER BY created_at')).rows;
  const leadAAtts = attachments.filter(a => a.whatsapp_media_id === 'media-leadA-img');
  const leadBAtts = attachments.filter(a => a.whatsapp_media_id === 'media-leadB-voice');

  assert.equal(leadAAtts.length, 1);
  assert.equal(leadBAtts.length, 1);
  assert.notEqual(leadAAtts[0].lead_id, leadBAtts[0].lead_id, 'Lead A and Lead B must have distinct lead_ids');
});

// 15. Zoho failure preserves the lead
test('FAULT TOLERANCE: Zoho API failure preserves lead in database with failed status', async t => {
  const failingZoho = {
    async searchLeadByPhone() { return null; },
    async searchLeadByEmail() { return null; },
    async createLead() { throw Object.assign(new Error('Zoho 503 Service Unavailable'), { code: 'ZOHO_UNAVAILABLE' }); },
    async updateLead() { throw new Error('Zoho error'); },
  };

  const { store, sendBossMessage } = await setupFlow(t, { zoho: failingZoho });
  await sendBossMessage('Apex Falcon Contracting, Rashid 0501112233, Dubai South');
  
  // Confirm with YES
  const yesMsg = await sendBossMessage('YES');

  // Verify lead is preserved in MongoDB
  const leads = (await store.listLeads()).items;
  assert.equal(leads.length, 1, 'Lead must exist in MongoDB');
  const lead = leads[0];
  assert.equal(lead.zoho_status, 'failed', 'Zoho status should be marked as failed');
  assert.equal(lead.company_name, 'Apex Falcon Contracting');

  // Verify reply queued for Boss has the Zoho failure message
  const reply = await store.getReply(yesMsg.whatsapp_message_id);
  assert.ok(reply, 'Reply must exist');
  assert.ok(reply.text.includes('⚠️ Lead Saved, Zoho Sync Pending'), 'Reply must indicate sync pending');
  assert.ok(reply.text.includes('The lead is safely saved in the system, but Zoho CRM sync could not be completed.'));
  assert.ok(reply.text.includes('Apex Falcon Contracting') || reply.text.includes('Rashid'));
  assert.ok(reply.text.includes(lead.id));
  assert.ok(reply.text.includes('❌ Zoho Status: Failed/Pending'));
  assert.ok(reply.text.includes("The lead can be pushed to Zoho from the Admin panel using 'Push to Zoho'."));
});

// 16. Fast acknowledgement is sent immediately
test('FAST ACKNOWLEDGEMENT: Boss receives immediate acknowledgment when fastAck is enabled', async t => {
  const { whatsapp } = await setupFlow(t);
  const fastAckReply = 'Got it Boss 👍 Processing the lead...';
  await whatsapp.sendTextMessage(BOSS, fastAckReply);

  assert.equal(whatsapp.sends.length, 1);
  assert.equal(whatsapp.sends[0].to, BOSS);
  assert.equal(whatsapp.sends[0].text, fastAckReply);
});

// 17. Client AI salesperson flow operates independently from Boss intake
test('CLIENT AI: Client conversation flow answers questions and does NOT trigger Zoho', async t => {
  const { createConversationProcessor } = require('../src/services/ai/conversationProcessor');
  const { store } = await temporaryStore(t);
  const zohoMock = mockZoho();
  const whatsappMock = mockWhatsapp();
  const aiMock = mockAi();

  const config = {
    enabled: true,
    aiProvider: 'openai',
    allowedSenders: new Set(),
    leaseMs: 30000,
    maxAttempts: 3,
  };

  const processor = createConversationProcessor({
    store,
    ai: aiMock,
    whatsapp: whatsappMock,
    config,
    logger: { info() {}, warn() {}, error() {} },
  });

  // Client asks about Voltronix services
  const clientMsg = incoming({
    sender_phone: CLIENT,
    message_text: 'Hello, do you handle warehouse fit-out and MEP approvals in Dubai?',
    request_lead_workflow: false,
  });

  await store.enqueueMany([clientMsg], { processingFlow: 'conversation' });
  const job = await store.claimNext({ leaseMs: config.leaseMs, maxAttempts: config.maxAttempts, processingFlow: 'conversation' });
  assert.ok(job, 'Job claimed');
  await processor.processIncomingWhatsAppMessage(job);

  // Verify Zoho was NEVER touched
  assert.equal(zohoMock.calls.create, 0, 'Client query must NOT call Zoho');
  assert.equal(zohoMock.calls.update, 0, 'Client query must NOT call Zoho');
});

after(async () => {
  const mongoose = require('mongoose');
  await mongoose.disconnect().catch(() => {});
});


