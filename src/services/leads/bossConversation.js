'use strict';

const { conversationIntent } = require('../../utils/conversationIntent');
const { mediaKind, isAttachmentOnlyMimeType } = require('../../utils/media');

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

function getAttachmentUploadStatus(attachment, zohoLeadId) {
  const status = attachment.zohoUploadStatus || attachment.zoho_upload_status || 'pending';
  const attachmentId = attachment.zohoAttachmentId || attachment.zoho_attachment_id;
  const attachedLeadId = attachment.zohoLeadId || attachment.zoho_lead_id;
  if (status === 'uploaded' && attachmentId && attachmentId !== 'attached'
      && String(attachedLeadId) === String(zohoLeadId)) return 'uploaded';
  return status === 'failed' ? 'failed' : 'pending';
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

  const files = Array.isArray(attachments) ? attachments : [];
  const allUploaded = files.every(a => getAttachmentUploadStatus(a, zohoLeadId) === 'uploaded');
  let fileListStart = 0;
  const fileLines = [];
  if (files.length > 0) {
    const groups = { image: [], 'voice message': [], document: [] };
    for (const att of files) {
      const mimeType = att.mimeType || att.mime_type || '';
      const kind = isAttachmentOnlyMimeType(mimeType) ? 'document' : mediaKind(mimeType) || att.type;
      const type = kind === 'image' ? 'image' : kind === 'audio' ? 'voice message' : 'document';
      groups[type].push(att);
    }

    const attachmentLines = [];
    for (const [type, group] of Object.entries(groups)) {
      if (!group.length) continue;
      const complete = group.every(a => getAttachmentUploadStatus(a, zohoLeadId) === 'uploaded');
      attachmentLines.push(`${group.length} ${type}${group.length > 1 ? 's' : ''} ${complete ? 'attached ✅' : 'received'}`);
    }

    lines.push('', `Attachments (${files.length}):`);
    if (attachmentLines.length > 0) {
      lines.push(...attachmentLines);
    }
    const fileText = (value, limit) => {
      const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
      return text.length > limit ? `${Array.from(text).slice(0, limit - 1).join('')}…` : text;
    };
    fileListStart = lines.length;
    for (const att of files) {
      const name = fileText(att.filename || att.mediaFilename || att.media_filename || att.mediaId || att.media_id || 'file', 180);
      const status = getAttachmentUploadStatus(att, zohoLeadId);
      const statusIcon = status === 'uploaded' ? '\u2705' : status === 'failed' ? '\u274c' : '\u23f3';
      const statusText = status === 'uploaded' ? 'uploaded to Zoho'
        : status === 'failed' ? `upload failed: ${fileText(att.zohoError || att.zoho_error || 'unknown error', 160)}`
        : 'pending upload';
      fileLines.push(`  ${statusIcon} ${name} \u2014 ${statusText}`);
    }
    lines.push(...fileLines);
    if (allUploaded) {
      lines.push('', '\ud83d\uddbc\ufe0f All attachments uploaded to Zoho \u2705');
    } else {
      const uploaded = files.filter(a => getAttachmentUploadStatus(a, zohoLeadId) === 'uploaded').length;
      lines.push('', `⚠️ ${uploaded} of ${files.length} attachments uploaded to Zoho.`,
        'Use "Push to Zoho" in the admin panel to retry the remaining files.');
    }
  }

  lines.push('', 'Zoho Sync:', 'Saved successfully ✅');
  lines.push('✅ Saved to MongoDB');
  lines.push(allUploaded ? '✅ Synced to Zoho CRM' : '✅ Lead details synced to Zoho CRM');
  if (!allUploaded) lines.push('⚠️ Attachment sync incomplete');
  if (lines.join('\n').length > 4096 && fileLines.length) {
    // Keep the receipt and overall upload result deliverable for large batches.
    // Surface failures first when the full list cannot fit in one WhatsApp text.
    lines.splice(fileListStart, fileLines.length);
    const available = 4096 - lines.join('\n').length - 100;
    const ordered = allUploaded ? fileLines : [
      ...fileLines.filter((_, i) => getAttachmentUploadStatus(files[i], zohoLeadId) !== 'uploaded'),
      ...fileLines.filter((_, i) => getAttachmentUploadStatus(files[i], zohoLeadId) === 'uploaded'),
    ];
    const visible = [];
    let used = 0;
    for (const line of ordered) {
      if (used + line.length + 1 > available) break;
      visible.push(line);
      used += line.length + 1;
    }
    lines.splice(fileListStart, 0, ...visible,
      `… ${fileLines.length - visible.length} more files; see the complete list in the admin panel.`);
  }
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

function formatBossZohoInputMessage({ leadName, leadId }) {
  return [
    '⚠️ Zoho CRM needs one more contact detail',
    `📋 Lead: ${leadName || 'Customer'}`,
    `🆔 Internal Lead ID: ${leadId}`,
    'Please send a valid customer phone number or email address.',
    'The lead remains saved locally. After sending the contact detail, reply YES to sync it to Zoho CRM.',
  ].join('\n');
}

module.exports = {
  conversationIntent,
  formatConfirmationSummary,
  buildZohoLeadUrl,
  getAttachmentUploadStatus,
  formatBossFinalSuccessMessage,
  formatBossZohoFailureMessage,
  formatBossZohoInputMessage,
  GREETING_REPLY,
  CONFIRMATION_REPLY,
  SAVED_REPLY,
  CONTINUE_REPLY,
  GUIDANCE_REPLY,
};
