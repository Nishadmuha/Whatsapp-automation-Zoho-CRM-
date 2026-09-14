'use strict';

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

function conversationIntent(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
  // Whole-message matching prevents "Yes, add 2 MDB" from saving a draft.
  if (/^(?:hi|hello|hey|good morning|good afternoon|good evening)(?: boss| there)?(?: thank you| thanks)?$/.test(text)) return 'greeting';
  if (/^(?:new lead|new customer|next customer|next lead|start another lead|start a new lead)$/.test(text)) return 'new_lead';
  if (/^(?:discard|discard it|discard current lead|discard the current lead|close current lead|close the current lead|close without saving)$/.test(text)) return 'discard';
  if (/^(?:continue|keep it|keep this lead|keep current lead|keep the current lead|cancel new lead)$/.test(text)) return 'continue';
  if (/^(?:yes|yes please|yes save|yes save it|yes please save|yes please save it|save|save it|save the lead|complete|completed|confirmed|confirm|okay save|ok save|okay save it|ok save it|looks good|proceed|proceed with saving)$/.test(text)) return 'confirmation';
  if (/^(?:no|no need|no thanks|no thank you|not yet|wait|wait please|please wait|one moment|just a moment|need to add more|more details|i (?:ll|will) send more(?: details)?|cancel|do not send|don t send)$/.test(text)) return 'defer';
  if (/^(?:thanks|thank you|thank you boss|okay|ok|sure|alright|got it|understood|you re welcome)$/.test(text)) return 'conversation';
  return 'details';
}

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

function formatBossFinalSuccessMessage({ contact, company, phone, email, zohoLeadId, zohoUrl }) {
  const contactVal = (contact || '').trim() || (company || '').trim() || 'Customer';
  const companyVal = (company || '').trim() || (contact || '').trim() || 'Individual';
  const phoneVal = (phone || '').trim() || 'N/A';
  const emailVal = (email || '').trim() || 'N/A';

  const lines = [
    '✅ Lead Saved Successfully',
    `👤 Contact: ${contactVal}`,
    `🏢 Company: ${companyVal}`,
    `📞 Phone: ${phoneVal}`,
    `📧 Email: ${emailVal}`,
    `🆔 Zoho Lead ID: ${zohoLeadId}`,
    `🔗 Zoho Lead: ${zohoUrl}`,
    '✅ Saved to MongoDB',
    '✅ Synced to Zoho CRM'
  ];
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
