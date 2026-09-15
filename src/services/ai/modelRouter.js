'use strict';

/**
 * Voltronix AI Model Router
 *
 * Deterministic complexity-scoring and model-routing architecture.
 * Safely maps incoming tasks to low, medium, or high model tiers
 * using environment-configurable model IDs.
 */

const MEP_TERMS = [
  'switchgear',
  'transformer',
  'capacitor bank',
  'substation',
  'chiller',
  'hvac',
  'fire alarm',
  'single line diagram',
  'sld',
  'mdb',
  'smdb',
  'mcc',
  'lv panel',
  'electrical load',
  'dewa',
  'dcd',
  'municipality',
  'trakhees',
  'infrastructure',
  'warehouse',
  'mep',
  'fit-out',
];

// Regex matching construction/MEP terms on word boundaries
const MEP_REGEX = new RegExp(
  '\\b(' + MEP_TERMS.map((t) => t.replace(/-/g, '[-\\s]?')).join('|') + ')\\b',
  'i'
);

const VALID_MODEL_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;

const KNOWN_REASONING_MODELS = new Set([
  'gpt-6-astra',
  'o1',
  'o1-mini',
  'o1-preview',
  'o1-2024-12-17',
  'o3',
  'o3-mini',
]);

/**
 * Score complexity of a message deterministically:
 * +1: Text > 300 characters
 * +2: Text > 1200 characters
 * +1: One media attachment
 * +2: More than one media attachment
 * +2: Complex MEP/construction terminology
 * +2: Extraction validation retry
 * +2: Conflicting contact information
 */
function scoreMessageComplexity(input = {}) {
  const options = typeof input === 'string' ? { text: input } : (input || {});
  const text = typeof options.text === 'string' ? options.text : '';
  const mediaCount = Number.isInteger(options.mediaCount)
    ? options.mediaCount
    : (options.mediaCount ? 1 : (options.messageType && options.messageType !== 'text' ? 1 : 0));
  const isRetry = Boolean(options.isRetry)
    || (Number.isInteger(options.previousAttempts) && options.previousAttempts > 0);
  const hasConflictingInfo = Boolean(options.hasConflictingInfo);

  let score = 0;

  // Text length checks
  if (text.length > 300) score += 1;
  if (text.length > 1200) score += 2;

  // Media attachment count
  if (mediaCount === 1) {
    score += 1;
  } else if (mediaCount > 1) {
    score += 2;
  }

  // Complex construction/MEP terminology
  if (text && MEP_REGEX.test(text)) {
    score += 2;
  }

  // Extraction validation retry
  if (isRetry) {
    score += 2;
  }

  // Conflicting contact information
  if (hasConflictingInfo) {
    score += 2;
  }

  return score;
}

/**
 * Maps deterministic score to routing tier:
 * 0–2 → low
 * 3–5 → medium
 * 6+  → high
 */
function scoreToTier(score) {
  if (score <= 2) return 'low';
  if (score <= 5) return 'medium';
  return 'high';
}

/**
 * Validates model name against safe naming convention.
 */
function isValidModelName(model) {
  return typeof model === 'string' && VALID_MODEL_NAME_REGEX.test(model);
}

/**
 * Resolves the configured model name for the given tier from environment variables.
 * Fallback order:
 * low:    OPENAI_MODEL_DEFAULT -> OPENAI_MODEL
 * medium: OPENAI_MODEL_MEDIUM  -> OPENAI_MODEL_DEFAULT -> OPENAI_MODEL
 * high:   OPENAI_MODEL_HIGH    -> OPENAI_MODEL_MEDIUM  -> OPENAI_MODEL_DEFAULT -> OPENAI_MODEL
 */
function resolveTierModel(tier, env = process.env) {
  let model;
  if (tier === 'low') {
    model = env.OPENAI_MODEL_DEFAULT || env.OPENAI_MODEL;
  } else if (tier === 'medium') {
    model = env.OPENAI_MODEL_MEDIUM || env.OPENAI_MODEL_DEFAULT || env.OPENAI_MODEL;
  } else if (tier === 'high') {
    model = env.OPENAI_MODEL_HIGH || env.OPENAI_MODEL_MEDIUM || env.OPENAI_MODEL_DEFAULT || env.OPENAI_MODEL;
  } else {
    model = env.OPENAI_MODEL_DEFAULT || env.OPENAI_MODEL;
  }

  if (!isValidModelName(model)) {
    const error = new Error('Configure the AI provider API key and model.');
    error.code = 'AI_CONFIGURATION_ERROR';
    throw error;
  }
  return model;
}

/**
 * Resolves the model, tier, and score for a given task and context.
 */
function resolveModel({
  task = 'general',
  text,
  messageType,
  mediaCount,
  previousAttempts,
  hasConflictingInfo,
  isRetry,
  requestedTier,
} = {}, env = process.env) {
  const score = scoreMessageComplexity({
    text,
    messageType,
    mediaCount,
    previousAttempts,
    hasConflictingInfo,
    isRetry,
  });

  const validTiers = new Set(['low', 'medium', 'high']);
  const tier = (requestedTier && validTiers.has(requestedTier))
    ? requestedTier
    : scoreToTier(score);

  const model = resolveTierModel(tier, env);

  return { tier, model, score, task };
}

/**
 * Checks if a model supports reasoning parameters.
 */
function isReasoningModel(model, env = process.env) {
  if (typeof model !== 'string' || !model.trim()) return false;
  const configured = (env?.OPENAI_REASONING_MODELS || '')
    .split(',')
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);
  if (configured.length > 0) {
    return configured.includes(model.toLowerCase().trim());
  }
  const lower = model.toLowerCase().trim();
  if (KNOWN_REASONING_MODELS.has(lower)) return true;
  if (/^(o1|o3)(-[a-z0-9]+)*$/.test(lower) || lower.includes('reasoning')) return true;
  return false;
}

/**
 * Returns safe reasoning configuration if model supports reasoning, otherwise empty object.
 */
function openAiReasoning(model, env = process.env) {
  return isReasoningModel(model, env) ? { reasoning: { effort: 'low' } } : {};
}

/**
 * Generates safe observability log string with zero private customer/credential data.
 */
function formatRouterLog({ task = 'general', tier = 'low', score = 0, model = 'unknown' }) {
  return `AI_ROUTER task=${task} tier=${tier} score=${score} model=${model}`;
}

module.exports = {
  scoreMessageComplexity,
  scoreToTier,
  isValidModelName,
  resolveTierModel,
  resolveModel,
  isReasoningModel,
  openAiReasoning,
  formatRouterLog,
  MEP_TERMS,
};
