'use strict';

const { conversationIntent } = require('../../utils/conversationIntent');

function formatConfirmationSummary(lead) {
  const company = lead?.company_name || lead?.company || '...';
  const contact = lead?.contact_name || lead?.contact || lead?.name || '...';
  const phone = lead?.phone || '...';
  const requirement = lead?.requirement || lead?.product_or_service || lead?.product || '...';
  const location = lead?.project_location || lead?.location || lead?.address || '...';

  return [
    'Lead details:',
    `Company: ${company}`,
    `Contact: ${contact}`,
    `Phone: ${phone}`,
    `Requirement: ${requirement}`,
    `Location: ${location}`,
    '',
    'Reply YES to send this lead to Zoho or send corrections.',
  ].join('\n');
}

const GREETING_REPLY = "Hi Boss 👋 I'm ready. Please send the customer/lead details. You can send text, screenshots, voice messages, or multiple messages.";
const CONFIRMATION_REPLY = 'I have the available information for this lead. Is everything complete and ready to save?';
const SAVED_REPLY = 'Lead saved successfully ✅';
const CONTINUE_REPLY = "Send any additional details when you're ready.";
const GUIDANCE_REPLY = 'Please send the customer/lead details when you are ready.';

function buildZohoLeadUrl(zohoLeadId, env = process.env) {
  if (!zohoLeadId) return null;
  if (env.ZOHO_LEAD_URL_TEMPLATE) {
    return env.ZOHO_LEAD_URL_TEMPLATE.replace('{id}', zohoLeadId);
  }
  let domain = 'crm.zoho.com';
  if (env.ZOHO_CRM_DOMAIN) {
    domain = env.ZOHO_CRM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  } else if (env.ZOHO_API_BASE_URL) {
    try {
      const u = new URL(env.ZOHO_API_BASE_URL);
      const match = u.hostname.match(/zohoapis\.(com|eu|in|com\.au|com\.cn|ca|jp)/);
      if (match) {
        domain = `crm.zoho.${match[1]}`;
      }
    } catch (_err) {
      // fallback to default domain
    }
  }
  const orgId = env.ZOHO_ORG_ID;
  if (orgId && String(orgId).trim()) {
    const cleanOrg = String(orgId).trim().replace(/^org/i, '');
    return `https://${domain}/crm/org${cleanOrg}/tab/Leads/${zohoLeadId}`;
  }
  return `https://${domain}/crm/tab/Leads/${zohoLeadId}`;
}

function formatBossFinalSuccessMessage({ contact, company, phone, email, zohoLeadId, zohoUrl, attachments = [] }) {
  const contactVal = (contact || '').trim() || (company || '').trim() || 'Customer';
  const companyVal = (company || '').trim() || (contact || '').trim() || 'Individual';
  const phoneVal = (phone || '').trim() || 'N/A';
  const emailVal = (email || '').trim() || 'N/A';

  const lines = [
    '✅ Lead Saved Successfully',
    '',
    'Zoho CRM:',
    `Lead ID: ${zohoLeadId}`,
    `🆔 Zoho Lead ID: ${zohoLeadId}`,
    '',
    'Open Lead:',
    `${zohoUrl}`,
    `🔗 Zoho Lead: ${zohoUrl}`,
  ];

  if (contactVal !== 'Customer' || companyVal !== 'Individual') {
    lines.push(`👤 Contact: ${contactVal}`, `🏢 Company: ${companyVal}`);
  }
  if (phoneVal !== 'N/A') lines.push(`📞 Phone: ${phoneVal}`);
  if (emailVal !== 'N/A') lines.push(`📧 Email: ${emailVal}`);

  if (Array.isArray(attachments) && attachments.length > 0) {
    const images = attachments.filter(a => a.type === 'image' || a.mime_type?.startsWith('image/') || a.mimeType?.startsWith('image/')).length;
    const voice = attachments.filter(a => a.type === 'audio' || a.mime_type?.startsWith('audio/') || a.mimeType?.startsWith('audio/')).length;
    const docs = attachments.filter(a => !['image', 'audio'].includes(a.type) && !a.mime_type?.startsWith('image/') && !a.mime_type?.startsWith('audio/') && !a.mimeType?.startsWith('image/') && !a.mimeType?.startsWith('audio/')).length;

    const attachmentLines = [];
    if (images > 0) attachmentLines.push(`${images} image${images > 1 ? 's' : ''} attached ✅`);
    if (voice > 0) attachmentLines.push(`${voice} voice message${voice > 1 ? 's' : ''} attached ✅`);
    if (docs > 0) attachmentLines.push(`${docs} document${docs > 1 ? 's' : ''} attached ✅`);

    lines.push('', `Attachments (${attachments.length}):`);
    if (attachmentLines.length > 0) {
      lines.push(...attachmentLines);
    }
    for (const att of attachments) {
      const name = att.filename || att.mediaId || att.media_id || 'file';
      const status = att.zohoUploadStatus || att.zoho_upload_status || 'pending';
      const statusIcon = status === 'uploaded' ? '\u2705' : status === 'failed' ? '\u274c' : '\u23f3';
      const statusText = status === 'uploaded' ? 'uploaded to Zoho'
        : status === 'failed' ? `upload failed: ${att.zohoError || att.zoho_error || 'unknown error'}`
        : 'pending upload';
      lines.push(`  ${statusIcon} ${name} \u2014 ${statusText}`);
    }
    const allUploaded = attachments.every(a => (a.zohoUploadStatus || a.zoho_upload_status) === 'uploaded');
    const anyFailed = attachments.some(a => (a.zohoUploadStatus || a.zoho_upload_status) === 'failed');
    if (anyFailed) {
      lines.push('', '\u26a0\ufe0f Some attachments could not be uploaded. Use "Push to Zoho" in the admin panel to retry.');
    } else if (allUploaded) {
      lines.push('', '\ud83d\uddbc\ufe0f All attachments uploaded to Zoho \u2705');
    }
  }

  lines.push('', 'Zoho Sync:', 'Saved successfully ✅');
  lines.push('✅ Saved to MongoDB');
  lines.push('✅ Synced to Zoho CRM');
  return lines.join('\n');
}

function formatBossZohoFailureMessage({ leadName, leadId, status = 'Failed/Pending' }) {
  return [
    '⚠️ Lead Saved, Zoho Sync Pending',
    'The lead is safely saved in the system, but Zoho CRM sync could not be completed.',
    `📋 Lead: ${leadName || 'Customer'}`,
    `🆔 Internal Lead ID: ${leadId}`,
    `❌ Zoho Status: ${status}`,
    "The lead can be pushed to Zoho from the Admin panel using 'Push to Zoho'."
  ].join('\n');
}

module.exports = {
  conversationIntent,
  formatConfirmationSummary,
  buildZohoLeadUrl,
  formatBossFinalSuccessMessage,
  formatBossZohoFailureMessage,
  GREETING_REPLY,
  CONFIRMATION_REPLY,
  SAVED_REPLY,
  CONTINUE_REPLY,
  GUIDANCE_REPLY,
};
