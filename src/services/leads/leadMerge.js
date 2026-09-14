'use strict';

const { LEAD_FIELDS, FIELD_LIMITS, validateLeadExtraction } = require('../ai/leadExtraction');

const emptyResult = () => ({ is_lead: false, lead: Object.fromEntries(LEAD_FIELDS.map(field => [field, null])) });

function factPattern(fact) {
  const escaped = fact.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
}

function containsFact(value, fact) {
  return factPattern(fact).test(value);
}

function isReplacement(field, update, currentText) {
  if (!currentText || !['requirement', 'product_or_service'].includes(field)) return false;
  const labels = field === 'requirement' ? '(?:requirement|request|order)' : '(?:product|service|item|order)';
  // Correction words must describe this field in the same clause. A contact
  // update elsewhere in the message must not erase an earlier requirement.
  return currentText.split(/[\n;.!?]+/).some(clause => {
    if (!containsFact(clause, update) || /\b(?:also|additional(?:ly)?|plus|as well as)\b/i.test(clause)) return false;
    return /^\s*(?:correction\s*[:,]|actually\b|make that\b)/i.test(clause)
      || new RegExp(`\\b(?:replace|change|update|correct)\\s+(?:the\\s+)?${labels}\\b`, 'i').test(clause)
      || new RegExp(`\\b${labels}\\s+(?:should be|is now|must be)\\b`, 'i').test(clause)
      || /\binstead(?:\s+of\b|\s*$)/i.test(clause);
  });
}

function currentAddition(field, known, update, currentText) {
  if (currentText === undefined || !containsFact(update, known)) return null;
  const addition = update.replace(factPattern(known), '').replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '');
  if (!addition) return null;
  const candidate = emptyResult();
  candidate.is_lead = true;
  candidate.lead[field] = addition;
  return validateLeadExtraction(candidate, { originalText: currentText }).lead[field];
}

function mergeNote(previous, next, limit) {
  if (!previous || containsFact(next, previous)) return next;
  if (containsFact(previous, next)) return previous;
  // Raw source text remains on the individual messages even when the concise
  // notes field cannot hold another excerpt. Never split a fact to make it fit.
  const combined = previous + '\n' + next;
  return combined.length <= limit ? combined : previous;
}

function mergeLeadResults(previous, incoming, { currentText } = {}) {
  // Defend against stale or substituted extraction results: a historical value
  // cannot replace a known fact unless the latest message supports the change.
  const current = currentText === undefined ? incoming : validateLeadExtraction(incoming, { originalText: currentText });
  const lead = Object.fromEntries(LEAD_FIELDS.map(field => {
    const known = previous?.lead?.[field] || null;
    const update = incoming?.is_lead ? incoming.lead[field] : null;
    if (!update) return [field, known];
    const additive = field === 'notes' || (!isReplacement(field, update, currentText) && ['requirement', 'product_or_service'].includes(field));
    if (known && !current?.lead?.[field]) {
      // A provider may return the complete accumulated requirement or notes.
      // Retain that addition only if the known portion is still present and
      // its remaining fact is independently supported by this latest message.
      const addition = additive && currentAddition(field, known, update, currentText);
      return [field, addition ? mergeNote(known, addition, FIELD_LIMITS[field]) : known];
    }
    return [field, additive ? mergeNote(known, update, FIELD_LIMITS[field]) : update];
  }));
  return { is_lead: Object.values(lead).some(Boolean), lead };
}

module.exports = { emptyResult, mergeLeadResults };
