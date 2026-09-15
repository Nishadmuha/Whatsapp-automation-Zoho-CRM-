'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  scoreMessageComplexity,
  scoreToTier,
  resolveTierModel,
  resolveModel,
  isReasoningModel,
  openAiReasoning,
  formatRouterLog,
} = require('../src/services/ai/modelRouter');
const { createAiService } = require('../src/services/ai/aiService');

// --- 1. ROUTING & COMPLEXITY SCORING TESTS ---

test('simple message routes to LOW tier with score <= 2', () => {
  const score = scoreMessageComplexity({ text: 'Hello, what services do you provide?' });
  assert.equal(score, 0);
  assert.equal(scoreToTier(score), 'low');

  const resolved = resolveModel({
    task: 'customer_reply',
    text: 'Hello, what services do you provide?',
  }, {
    OPENAI_MODEL_DEFAULT: 'gpt-default-test',
    OPENAI_MODEL_MEDIUM: 'gpt-medium-test',
    OPENAI_MODEL_HIGH: 'gpt-high-test',
  });
  assert.equal(resolved.tier, 'low');
  assert.equal(resolved.model, 'gpt-default-test');
  assert.equal(resolved.score, 0);
});

test('medium complexity routes to MEDIUM tier (score 3-5)', () => {
  // Text > 300 (+1) and complex MEP term (+2) = 3 -> medium
  const text = 'We need quotation for a project with chiller and HVAC units. ' + 'x'.repeat(310);
  const score = scoreMessageComplexity({ text });
  assert.ok(score >= 3 && score <= 5, `Expected score between 3 and 5, got ${score}`);
  assert.equal(scoreToTier(score), 'medium');

  const resolved = resolveModel({ task: 'lead_enquiry', text }, {
    OPENAI_MODEL_DEFAULT: 'gpt-default-test',
    OPENAI_MODEL_MEDIUM: 'gpt-medium-test',
    OPENAI_MODEL_HIGH: 'gpt-high-test',
  });
  assert.equal(resolved.tier, 'medium');
  assert.equal(resolved.model, 'gpt-medium-test');
});

test('complex MEP enquiry routes to HIGH tier (score 6+)', () => {
  // Text > 1200 (+3: >300 & >1200), MEP keywords (+2), and multiple media (+2) -> score 7 -> HIGH
  const text = 'Project: Industrial Warehouse Substation. Scope: Supply and installation of 11kV Switchgear, '
    + '1500kVA Transformer, MDB, SMDB, and Capacitor Bank approved by DEWA. ' + 'Detailed specs: '.repeat(80);
  const score = scoreMessageComplexity({
    text,
    mediaCount: 2,
    hasConflictingInfo: true,
  });
  assert.ok(score >= 6, `Expected score >= 6, got ${score}`);
  assert.equal(scoreToTier(score), 'high');

  const resolved = resolveModel({
    task: 'lead_enquiry',
    text,
    mediaCount: 2,
    hasConflictingInfo: true,
  }, {
    OPENAI_MODEL_DEFAULT: 'gpt-default-test',
    OPENAI_MODEL_MEDIUM: 'gpt-medium-test',
    OPENAI_MODEL_HIGH: 'gpt-high-test',
  });
  assert.equal(resolved.tier, 'high');
  assert.equal(resolved.model, 'gpt-high-test');
});

test('single image does not automatically become HIGH tier', () => {
  // Single image attachment = +1, short text = 0 -> score = 1 -> LOW
  const score = scoreMessageComplexity({
    text: 'Here is our invoice',
    messageType: 'image',
    mediaCount: 1,
  });
  assert.equal(score, 1);
  assert.equal(scoreToTier(score), 'low');

  const resolved = resolveModel({
    task: 'media_ocr',
    messageType: 'image',
    mediaCount: 1,
  }, {
    OPENAI_MODEL_DEFAULT: 'gpt-default-test',
    OPENAI_MODEL_MEDIUM: 'gpt-medium-test',
    OPENAI_MODEL_HIGH: 'gpt-high-test',
  });
  assert.equal(resolved.tier, 'low');
  assert.equal(resolved.model, 'gpt-default-test');
});

test('multiple images increases score appropriately', () => {
  const single = scoreMessageComplexity({ mediaCount: 1 });
  const multiple = scoreMessageComplexity({ mediaCount: 3 });
  assert.equal(single, 1);
  assert.equal(multiple, 2);
  assert.ok(multiple > single, 'Multiple media must increase score over single media');
});

test('long enquiry increases score appropriately', () => {
  const shortMsg = scoreMessageComplexity({ text: 'Short message' });
  const medMsg = scoreMessageComplexity({ text: 'x'.repeat(350) });
  const longMsg = scoreMessageComplexity({ text: 'x'.repeat(1300) });

  assert.equal(shortMsg, 0);
  assert.equal(medMsg, 1);
  assert.ok(longMsg > medMsg, 'Long enquiry (>1200 chars) must score higher than 300 chars');
});

test('conflicting contact details increases score', () => {
  const withoutConflict = scoreMessageComplexity({ text: 'Call Ahmed at 0501234567' });
  const withConflict = scoreMessageComplexity({
    text: 'Call Ahmed at 0501234567 or Rashid at 0507654321',
    hasConflictingInfo: true,
  });
  assert.equal(withConflict - withoutConflict, 2);
});

test('retry increases score', () => {
  const initial = scoreMessageComplexity({ text: 'Standard enquiry' });
  const retried = scoreMessageComplexity({ text: 'Standard enquiry', isRetry: true });
  const attempts = scoreMessageComplexity({ text: 'Standard enquiry', previousAttempts: 1 });

  assert.equal(retried - initial, 2);
  assert.equal(attempts - initial, 2);
});

// --- 2. CONFIGURATION & FALLBACK TESTS ---

test('new environment variables OPENAI_MODEL_DEFAULT, MEDIUM, HIGH work', () => {
  const env = {
    OPENAI_MODEL_DEFAULT: 'custom-luna',
    OPENAI_MODEL_MEDIUM: 'custom-terra',
    OPENAI_MODEL_HIGH: 'custom-sol',
  };

  assert.equal(resolveTierModel('low', env), 'custom-luna');
  assert.equal(resolveTierModel('medium', env), 'custom-terra');
  assert.equal(resolveTierModel('high', env), 'custom-sol');
});

test('legacy OPENAI_MODEL works as fallback across all tiers', () => {
  const env = {
    OPENAI_MODEL: 'legacy-astra',
  };

  assert.equal(resolveTierModel('low', env), 'legacy-astra');
  assert.equal(resolveTierModel('medium', env), 'legacy-astra');
  assert.equal(resolveTierModel('high', env), 'legacy-astra');
});

test('missing configuration fails safely with AI_CONFIGURATION_ERROR', () => {
  assert.throws(() => resolveTierModel('low', {}), (error) => {
    return error.code === 'AI_CONFIGURATION_ERROR';
  });
  assert.throws(() => resolveTierModel('medium', { OPENAI_MODEL: '' }), (error) => {
    return error.code === 'AI_CONFIGURATION_ERROR';
  });
  assert.throws(() => resolveTierModel('high', { OPENAI_MODEL: '   ' }), (error) => {
    return error.code === 'AI_CONFIGURATION_ERROR';
  });
});

test('unavailable or invalid model is detected safely', () => {
  for (const bad of ['model/../../bad', 'spaces in model', 'bad\x00char', '@invalid!']) {
    assert.throws(() => resolveTierModel('low', { OPENAI_MODEL: bad }), (error) => {
      return error.code === 'AI_CONFIGURATION_ERROR';
    });
  }
});

// --- 3. REASONING PARAMETER SAFETY ---

test('reasoning configuration is applied only to reasoning models', () => {
  // Direct capability checks
  assert.equal(isReasoningModel('gpt-6-astra'), true);
  assert.equal(isReasoningModel('o1'), true);
  assert.equal(isReasoningModel('gpt-4o'), false);
  assert.equal(isReasoningModel('gpt-4o-mini'), false);

  // Reasoning models configuration
  assert.deepEqual(openAiReasoning('gpt-6-astra'), { reasoning: { effort: 'low' } });
  assert.deepEqual(openAiReasoning('o1'), { reasoning: { effort: 'low' } });
  assert.deepEqual(openAiReasoning('o3-mini'), { reasoning: { effort: 'low' } });

  // Non-reasoning models must NOT include reasoning parameters
  assert.deepEqual(openAiReasoning('gpt-4o'), {});
  assert.deepEqual(openAiReasoning('gpt-4o-mini'), {});
  assert.deepEqual(openAiReasoning('gpt-5.6-luna'), {});
  assert.deepEqual(openAiReasoning('test-model'), {});

  // Custom reasoning models via OPENAI_REASONING_MODELS env
  const customEnv = { OPENAI_REASONING_MODELS: 'custom-reasoner,gpt-special' };
  assert.equal(isReasoningModel('custom-reasoner', customEnv), true);
  assert.deepEqual(openAiReasoning('custom-reasoner', customEnv), { reasoning: { effort: 'low' } });
  assert.deepEqual(openAiReasoning('gpt-4o', customEnv), {});
});

// --- 4. OBSERVABILITY & ZERO-CREDENTIAL LOGGING ---

test('observability logger outputs safe string without leaking text, keys, or phones', () => {
  const logStr = formatRouterLog({
    task: 'lead_enquiry',
    tier: 'medium',
    score: 4,
    model: 'gpt-4o',
  });
  assert.equal(logStr, 'AI_ROUTER task=lead_enquiry tier=medium score=4 model=gpt-4o');
  assert.ok(!logStr.includes('050'), 'Must not log phone numbers');
  assert.ok(!logStr.includes('Bearer'), 'Must not log credentials');
});

// --- 5. AI SERVICE INTEGRATION & QUOTA TESTS ---

test('AI service generateReply routes through model router correctly', async () => {
  const calls = [];
  const env = {
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'mock-test-key',
    OPENAI_MODEL_DEFAULT: 'mock-luna',
    OPENAI_MODEL_MEDIUM: 'mock-terra',
    OPENAI_MODEL_HIGH: 'mock-sol',
  };
  const service = createAiService({
    env,
    http: {
      async post(url, body) {
        calls.push({ url, body });
        return {
          status: 200,
          data: {
            status: 'completed',
            output: [{
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Hello! How can Voltronix help you?' }],
            }],
          },
        };
      },
    },
  });

  const reply = await service.generateReply('Hi, do you do electrical work?');
  assert.equal(reply, 'Hello! How can Voltronix help you?');
  assert.equal(calls.length, 1);
  // Short greeting -> LOW tier -> mock-luna
  assert.equal(calls[0].body.model, 'mock-luna');
});

test('AI service extractLeadEnquiry routes through model router correctly', async () => {
  const calls = [];
  const env = {
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'mock-test-key',
    OPENAI_MODEL_DEFAULT: 'mock-luna',
    OPENAI_MODEL_MEDIUM: 'mock-terra',
    OPENAI_MODEL_HIGH: 'mock-sol',
  };
  const completeLead = {
    is_lead: true,
    lead: {
      company_name: 'Al Noor LLC',
      contact_name: 'Ahmed',
      phone: '+971501234567',
      email: null,
      project_name: null,
      project_location: 'Dubai',
      product_or_service: 'chiller',
      requirement: 'supply',
      quantity: null,
      deadline: null,
      notes: null,
      address: null,
      trn_no: null,
    },
  };
  const service = createAiService({
    env,
    http: {
      async post(url, body) {
        calls.push({ url, body });
        return {
          status: 200,
          data: {
            status: 'completed',
            output: [{
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: JSON.stringify(completeLead) }],
            }],
          },
        };
      },
    },
  });

  // Text with MEP keyword ('chiller') + >300 chars -> MEDIUM tier -> mock-terra
  const enquiryText = 'Al Noor LLC. Contact Ahmed 0501234567. We need supply of chiller for our Dubai site. ' + 'Requirement details: '.repeat(20);
  const result = await service.extractLeadEnquiry(enquiryText);
  assert.deepEqual(result, completeLead);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'mock-terra');
});

test('voice transcription keeps dedicated model and endpoint', async () => {
  const calls = [];
  const env = {
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'mock-test-key',
    OPENAI_MODEL_DEFAULT: 'mock-luna',
    OPENAI_TRANSCRIPTION_MODEL: 'custom-whisper',
  };
  const service = createAiService({
    env,
    http: {
      async post(url, body) {
        calls.push({ url, body });
        return {
          status: 200,
          data: { text: 'Customer Ahmed needs MDB panel' },
        };
      },
    },
  });

  const text = await service.extractMediaText({
    buffer: Buffer.from('mock audio bytes'),
    mimeType: 'audio/ogg',
    type: 'audio',
  });
  assert.equal(text, 'Customer Ahmed needs MDB panel');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/transcriptions');
  // Dedicated transcription model used, NOT the text tier model
  assert.equal(calls[0].body.get('model'), 'custom-whisper');
});

test('image extraction uses default tier model without unnecessary escalation', async () => {
  const calls = [];
  const env = {
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'mock-test-key',
    OPENAI_MODEL_DEFAULT: 'mock-luna',
    OPENAI_MODEL_MEDIUM: 'mock-terra',
    OPENAI_MODEL_HIGH: 'mock-sol',
  };
  const service = createAiService({
    env,
    http: {
      async post(url, body) {
        calls.push({ url, body });
        return {
          status: 200,
          data: {
            status: 'completed',
            output: [{
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Invoice text from image' }],
            }],
          },
        };
      },
    },
  });

  const text = await service.extractMediaText({
    buffer: Buffer.from('mock image bytes'),
    mimeType: 'image/jpeg',
    type: 'image',
  });
  assert.equal(text, 'Invoice text from image');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'mock-luna');
});

// --- 6. QUOTA EXHAUSTION (429) & NON-RETRYABILITY TESTS ---

test('429 insufficient_quota returns non-retryable error to prevent credit drain', async () => {
  const env = {
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'mock-test-key',
    OPENAI_MODEL: 'gpt-4o-mini',
  };
  const quotaError = {
    response: {
      status: 429,
      data: {
        error: {
          code: 'insufficient_quota',
          message: 'You exceeded your current quota, please check your plan and billing details.',
        },
      },
    },
  };
  const service = createAiService({
    env,
    http: {
      async post() {
        throw quotaError;
      },
    },
  });

  await assert.rejects(service.generateReply('Hello'), (err) => {
    assert.equal(err.code, 'AI_RATE_LIMIT');
    assert.equal(err.retryable, false, 'Quota exhaustion MUST NOT be retryable');
    return true;
  });
});

test('429 credit_balance_exhausted returns non-retryable error', async () => {
  const env = {
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'mock-test-key',
    OPENAI_MODEL: 'gpt-4o-mini',
  };
  const creditError = {
    response: {
      status: 429,
      data: {
        error: {
          type: 'credit_balance_exhausted',
          message: 'Credit balance exhausted.',
        },
      },
    },
  };
  const service = createAiService({
    env,
    http: {
      async post() {
        throw creditError;
      },
    },
  });

  await assert.rejects(service.extractLeadEnquiry('Ahmed 0501234567'), (err) => {
    assert.equal(err.code, 'AI_RATE_LIMIT');
    assert.equal(err.retryable, false, 'Credit exhaustion MUST NOT be retryable');
    return true;
  });
});

test('standard 429 rate limit without quota exhaustion is retryable', async () => {
  const env = {
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'mock-test-key',
    OPENAI_MODEL: 'gpt-4o-mini',
  };
  const rateLimitError = {
    response: {
      status: 429,
      data: {
        error: {
          code: 'rate_limit_exceeded',
          message: 'Please try again in 20ms.',
        },
      },
    },
  };
  const service = createAiService({
    env,
    http: {
      async post() {
        throw rateLimitError;
      },
    },
  });

  await assert.rejects(service.generateReply('Hello'), (err) => {
    assert.equal(err.code, 'AI_RATE_LIMIT');
    assert.equal(err.retryable, true, 'Temporary rate limit should be retryable');
    return true;
  });
});
