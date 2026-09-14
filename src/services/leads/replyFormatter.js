'use strict';
function display(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f-\u009f*_~`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}
function successReply(lead, action = 'created') {
  const fields = [['Name', lead.name], ['Phone', lead.phone], ['Email', lead.email], ['Company', lead.company], ['Service', lead.service], ['Location', lead.location]];
  return [
    action === 'updated' ? '✅ Lead updated successfully.' : '✅ Lead saved successfully.', '',
    ...fields.filter(([, value]) => value).map(([label, value]) => label + ': ' + display(value)),
  ].join('\n');
}
function missingInformationReply(result) {
  const details = result.missing.length
    ? 'Please provide the ' + result.missing.join(' and ') + '.'
    : result.errors[0] || 'Please check the customer details.';
  return '⚠️ I couldn’t validate this lead. ' + details +
    '\n\nPlease resend the complete lead with the customer’s name and phone number (or email).';
}
function failureReply(reconciliation = false) {
  return reconciliation
    ? '⚠️ I couldn’t confirm the CRM result. This lead has been saved for administrator review. Please avoid resending it until the result is checked.'
    : '⚠️ I couldn’t save this lead to CRM. Your message has been retained for administrator review.';
}
module.exports = { successReply, missingInformationReply, failureReply };
