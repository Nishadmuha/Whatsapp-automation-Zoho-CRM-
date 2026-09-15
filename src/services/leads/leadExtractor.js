'use strict';

const { validateLeadInput, validateLeadExtraction } = require('../ai/leadExtraction');

const AI_CODES = new Set([
  'AI_INPUT_INVALID', 'AI_CONFIGURATION_ERROR', 'AI_AUTHENTICATION_ERROR', 'AI_RATE_LIMIT',
  'AI_TIMEOUT', 'AI_UNAVAILABLE', 'AI_MALFORMED_RESPONSE', 'AI_REQUEST_FAILED',
]);
const TRANSIENT_CODES = new Set(['AI_RATE_LIMIT', 'AI_TIMEOUT', 'AI_UNAVAILABLE']);

function extractionFailure(error, stage) {
  const code = AI_CODES.has(error?.code) ? error.code : 'AI_REQUEST_FAILED';
  return Object.assign(new Error('The lead details could not be extracted safely.'), {
    code, stage: stage || (code === 'AI_MALFORMED_RESPONSE' ? 'schema' : 'extraction'),
    retryable: TRANSIENT_CODES.has(code) && error?.retryable === true,
  });
}

function createLeadExtractor({ ai }) {
  return {
    async extract(text, options = {}) {
      validateLeadInput(text);
      const tiers = ['low', 'medium', 'high'];
      let lastError;
      for (let attempt = 0; attempt < tiers.length; attempt++) {
        const tier = options.requestedTier || tiers[attempt];
        let extracted;
        try {
          extracted = await ai.extractLeadEnquiry(text, {
            ...options,
            requestedTier: tier,
            isRetry: attempt > 0,
            previousAttempts: attempt,
          });
        } catch (error) {
          throw extractionFailure(error);
        }
        try {
          // Recheck mocked or substituted providers at the service boundary. No
          // sender identity is used to fill missing customer facts.
          return validateLeadExtraction(extracted, { originalText: text });
        } catch (error) {
          lastError = error;
          // Stop escalating if caller pinned requestedTier or reached the highest tier
          if (options.requestedTier || attempt === tiers.length - 1) {
            throw extractionFailure(lastError, 'schema');
          }
        }
      }
      throw extractionFailure(lastError, 'schema');
    },
  };
}

module.exports = { createLeadExtractor };
