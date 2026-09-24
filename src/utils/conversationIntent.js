'use strict';

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

module.exports = { conversationIntent };
