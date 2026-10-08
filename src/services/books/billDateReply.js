'use strict';

const { normalizeDate } = require('./billValidator');

// A date-only reply is meaningful only when the workflow is waiting for the
// missing bill date. Explicit date labels may also identify a correction.
// Never consume mixed instructions, a due date, or an ambiguous numeric date.
function parseBillDateReply(input, { allowBare = false } = {}) {
  if (typeof input !== 'string') return null;
  const source = input.trim();
  if (!source || /[\r\n]/.test(source)) return null;
  const labelled = source.match(/^(?:(?:bill|invoice)\s+)?date(?:\s*[:=-]\s*|\s+(?:is\s+)?)(.+)$/i);
  if (!labelled && !allowBare) return null;
  const candidate = labelled ? labelled[1].trim() : source;
  const normalized = normalizeDate(candidate, 'bill_date');
  return normalized.issue ? null : normalized.date;
}

module.exports = { parseBillDateReply };
