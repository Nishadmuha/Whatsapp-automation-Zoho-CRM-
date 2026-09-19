'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspect } = require('node:util');

const {
  billCoreSchema,
  confidenceSchema,
  groundingSchema,
} = require('../src/services/books/billSchema');

const {
  normalizeDate,
  validateBill,
} = require('../src/services/books/billValidator');

const {
  createBillExtractionService,
  computeGrounding,
  resolveConfidence,
} = require('../src/services/ai/billExtractionService');

// Helper to construct mock OpenAI Responses API envelope
function mockOpenAiResponse(value, { status = 200 } = {}) {
  return {
    status,
    data: {
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: typeof value === 'string' ? value : JSON.stringify(value),
            },
          ],
        },
      ],
    },
  };
}

function mockEnvironment(overrides = {}) {
  return {
    OPENAI_API_KEY: 'test-mock-secret-key-12345',
    OPENAI_MODEL: 'gpt-4o-mini',
    AI_TIMEOUT_MS: '5000',
    AI_MAX_OUTPUT_TOKENS: '2048',
    ...overrides,
  };
}

function setupService({ env = mockEnvironment(), responseOutcome, logger } = {}) {
  const calls = [];
  const logs = [];
  const service = createBillExtractionService({
    env,
    logger: logger || {
      info: (rec) => logs.push(rec),
      error: (rec) => logs.push(rec),
    },
    http: {
      async post(...args) {
        calls.push(args);
        if (typeof responseOutcome === 'function') {
          return responseOutcome(...args);
        }
        return responseOutcome || mockOpenAiResponse({});
      },
    },
  });
  return { service, calls, logs, env };
}

// -------------------------------------------------------------
// 1. SCHEMA TESTS
// -------------------------------------------------------------

test('1. Valid bill passes schema', () => {
  const validBill = {
    vendor_name: 'ElectroTech Solutions LLC',
    bill_number: 'INV-2026-001',
    bill_date: '2026-09-17',
    due_date: '2026-10-17',
    currency: 'AED',
    subtotal: 1000,
    tax_amount: 50,
    total_amount: 1050,
    line_items: [
      {
        name: 'Circuit Breaker 100A',
        description: 'Schneider LV429630',
        quantity: 2,
        rate: 500,
        amount: 1000,
      },
    ],
    notes: 'Delivered to site',
    description: null,
  };

  const parsed = billCoreSchema.safeParse(validBill);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.vendor_name, 'ElectroTech Solutions LLC');
  assert.equal(parsed.data.total_amount, 1050);
});

test('2. Missing optional fields pass as null in schema', () => {
  const minimalBill = {
    vendor_name: 'Acme Hardware',
    bill_number: null,
    bill_date: null,
    due_date: null,
    currency: null,
    subtotal: null,
    tax_amount: null,
    total_amount: 500,
    line_items: [],
    notes: null,
    description: null,
  };

  const parsed = billCoreSchema.safeParse(minimalBill);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.bill_number, null);
  assert.equal(parsed.data.subtotal, null);
  assert.equal(parsed.data.tax_amount, null);
});

test('3. Invalid numeric values fail schema', () => {
  const billWithNaN = {
    vendor_name: 'Acme',
    bill_number: '123',
    bill_date: null,
    due_date: null,
    currency: 'AED',
    subtotal: NaN,
    tax_amount: Infinity,
    total_amount: 'not-a-number',
    line_items: [],
    notes: null,
    description: null,
  };

  const parsed = billCoreSchema.safeParse(billWithNaN);
  assert.equal(parsed.success, false);
});

test('4. Invalid confidence fails schema', () => {
  const validConfidence = { vendor_name: 0.95, bill_number: 1.0, total_amount: 0 };
  assert.equal(confidenceSchema.safeParse(validConfidence).success, true);

  const outOfRangeHigh = { vendor_name: 1.5 };
  assert.equal(confidenceSchema.safeParse(outOfRangeHigh).success, false);

  const outOfRangeLow = { vendor_name: -0.1 };
  assert.equal(confidenceSchema.safeParse(outOfRangeLow).success, false);

  const nanConfidence = { vendor_name: NaN };
  assert.equal(confidenceSchema.safeParse(nanConfidence).success, false);
});

test('5. Invalid grounding state fails schema', () => {
  const validGrounding = {
    vendor_name: 'explicit',
    bill_number: 'inferred',
    due_date: 'missing',
  };
  assert.equal(groundingSchema.safeParse(validGrounding).success, true);

  const invalidGrounding = {
    vendor_name: 'guessed', // Not in ['explicit', 'inferred', 'missing']
  };
  assert.equal(groundingSchema.safeParse(invalidGrounding).success, false);
});

// -------------------------------------------------------------
// 2. DATE TESTS
// -------------------------------------------------------------

test('6. ISO date normalizes correctly', () => {
  const res1 = normalizeDate('2026-09-17', 'bill_date');
  assert.equal(res1.issue, null);
  assert.equal(res1.date, '2026-09-17');

  const res2 = normalizeDate('2026/09/17', 'bill_date');
  assert.equal(res2.issue, null);
  assert.equal(res2.date, '2026-09-17');
});

test('7. DD/MM/YYYY supported when unambiguous (day > 12)', () => {
  const res = normalizeDate('25/12/2026', 'bill_date');
  assert.equal(res.issue, null);
  assert.equal(res.date, '2026-12-25');

  const res2 = normalizeDate('17-09-2026', 'bill_date');
  assert.equal(res2.issue, null);
  assert.equal(res2.date, '2026-09-17');
});

test('8. Textual date normalizes correctly', () => {
  const res1 = normalizeDate('17 Sep 2026', 'bill_date');
  assert.equal(res1.issue, null);
  assert.equal(res1.date, '2026-09-17');

  const res2 = normalizeDate('September 17, 2026', 'bill_date');
  assert.equal(res2.issue, null);
  assert.equal(res2.date, '2026-09-17');

  const res3 = normalizeDate('4 May 2026', 'bill_date');
  assert.equal(res3.issue, null);
  assert.equal(res3.date, '2026-05-04');
});

test('9. Invalid calendar date fails (e.g. 2026-02-31)', () => {
  const res = normalizeDate('2026-02-31', 'bill_date');
  assert.notEqual(res.issue, null);
  assert.equal(res.issue.code, 'INVALID_CALENDAR_DATE');
  assert.equal(res.date, null);

  const res2 = normalizeDate('31/04/2026', 'bill_date'); // April only has 30 days
  assert.notEqual(res2.issue, null);
  assert.equal(res2.issue.code, 'INVALID_CALENDAR_DATE');
});

test('10. Ambiguous date is not silently guessed (e.g. 03/04/2026)', () => {
  const res = normalizeDate('03/04/2026', 'bill_date');
  assert.notEqual(res.issue, null);
  assert.equal(res.issue.code, 'AMBIGUOUS_DATE');
  assert.equal(res.date, null);
});

// -------------------------------------------------------------
// 3. EXTRACTION TESTS
// -------------------------------------------------------------

test('11. Valid mocked model response produces normalized bill', async () => {
  const sourceText = 'TAX INVOICE\nSupplier: Power Electric LLC\nInvoice No: PE-9921\nDate: 17 Sep 2026\nItem: Copper Cable 16mm, Qty: 100, Rate: 10, Amount: 1000\nSubtotal: 1000 AED\nVAT: 50 AED\nTotal: 1050 AED';

  const mockPayload = {
    bill: {
      vendor_name: 'Power Electric LLC',
      bill_number: 'PE-9921',
      bill_date: '17 Sep 2026',
      due_date: null,
      currency: 'AED',
      subtotal: 1000,
      tax_amount: 50,
      total_amount: 1050,
      line_items: [
        {
          name: 'Copper Cable 16mm',
          description: null,
          quantity: 100,
          rate: 10,
          amount: 1000,
        },
      ],
      notes: null,
      description: null,
    },
    confidence: {
      vendor_name: 0.98,
      bill_number: 0.95,
      bill_date: 0.95,
      due_date: 0.0,
      currency: 0.99,
      subtotal: 0.95,
      tax_amount: 0.95,
      total_amount: 0.99,
      line_items: 0.95,
    },
  };

  const { service, calls } = setupService({
    responseOutcome: mockOpenAiResponse(mockPayload),
  });

  const result = await service.extractBillFromText({ text: sourceText });

  assert.equal(result.success, true);
  assert.equal(result.bill.vendor_name, 'Power Electric LLC');
  assert.equal(result.bill.bill_number, 'PE-9921');
  assert.equal(result.bill.bill_date, '2026-09-17'); // Normalized
  assert.equal(result.bill.currency, 'AED');
  assert.equal(result.bill.total_amount, 1050);
  assert.equal(result.validation.valid, true);
  assert.equal(calls.length, 1);
});

test('12. Missing vendor is detected', async () => {
  const sourceText = 'Receipt\nNo: 1001\nTotal: 250 AED';
  const mockPayload = {
    bill: {
      vendor_name: null,
      bill_number: '1001',
      bill_date: null,
      due_date: null,
      currency: 'AED',
      subtotal: null,
      tax_amount: null,
      total_amount: 250,
      line_items: [],
      notes: null,
      description: null,
    },
    confidence: {
      vendor_name: 0.0,
      bill_number: 0.95,
      total_amount: 0.95,
    },
  };

  const { service } = setupService({
    responseOutcome: mockOpenAiResponse(mockPayload),
  });

  const result = await service.extractBillFromText({ text: sourceText });
  assert.equal(result.success, true);
  assert.equal(result.bill.vendor_name, null);
  assert.equal(result.validation.valid, false);
  const vendorIssue = result.validation.issues.find((i) => i.field === 'vendor_name');
  assert.ok(vendorIssue);
  assert.equal(vendorIssue.code, 'MISSING_VENDOR');
});

test('13. Missing total is detected', async () => {
  const sourceText = 'Delivery Note\nVendor: Global MEP Supplies\nItems delivered: 5 switches';
  const mockPayload = {
    bill: {
      vendor_name: 'Global MEP Supplies',
      bill_number: null,
      bill_date: null,
      due_date: null,
      currency: null,
      subtotal: null,
      tax_amount: null,
      total_amount: null,
      line_items: [{ name: 'switches', description: null, quantity: 5, rate: null, amount: null }],
      notes: null,
      description: null,
    },
    confidence: {
      vendor_name: 0.95,
      total_amount: 0.0,
    },
  };

  const { service } = setupService({
    responseOutcome: mockOpenAiResponse(mockPayload),
  });

  const result = await service.extractBillFromText({ text: sourceText });
  assert.equal(result.success, true);
  assert.equal(result.bill.total_amount, null);
  assert.equal(result.validation.valid, false);
  const totalIssue = result.validation.issues.find((i) => i.field === 'total_amount');
  assert.ok(totalIssue);
  assert.equal(totalIssue.code, 'MISSING_TOTAL');
});

test('14. Missing line items are handled safely', async () => {
  const sourceText = 'Invoice from Tech Corp\nTotal: 500 AED';
  const mockPayload = {
    bill: {
      vendor_name: 'Tech Corp',
      bill_number: null,
      bill_date: null,
      due_date: null,
      currency: 'AED',
      subtotal: null,
      tax_amount: null,
      total_amount: 500,
      line_items: [],
      notes: null,
      description: null,
    },
    confidence: {
      vendor_name: 0.95,
      total_amount: 0.95,
    },
  };

  const { service } = setupService({
    responseOutcome: mockOpenAiResponse(mockPayload),
  });

  const result = await service.extractBillFromText({ text: sourceText });
  assert.equal(result.success, true);
  assert.deepEqual(result.bill.line_items, []);
  assert.equal(result.grounding.line_items, 'missing');
});

test('15. Tax missing remains null rather than fabricated', async () => {
  const sourceText = 'Vendor: Fast Logistics\nTotal: 1200 AED (No tax breakdown)';
  const mockPayload = {
    bill: {
      vendor_name: 'Fast Logistics',
      bill_number: null,
      bill_date: null,
      due_date: null,
      currency: 'AED',
      subtotal: null,
      tax_amount: null,
      total_amount: 1200,
      line_items: [],
      notes: null,
      description: null,
    },
    confidence: {
      vendor_name: 0.95,
      total_amount: 0.95,
      tax_amount: 0.0,
    },
  };

  const { service } = setupService({
    responseOutcome: mockOpenAiResponse(mockPayload),
  });

  const result = await service.extractBillFromText({ text: sourceText });
  assert.equal(result.success, true);
  assert.equal(result.bill.tax_amount, null);
  assert.notEqual(result.bill.tax_amount, 0); // Must remain null, NOT 0
});

test('16. Currency missing remains null', async () => {
  const sourceText = 'Vendor: Tools Depot\nTotal: 350';
  const mockPayload = {
    bill: {
      vendor_name: 'Tools Depot',
      bill_number: null,
      bill_date: null,
      due_date: null,
      currency: null,
      subtotal: null,
      tax_amount: null,
      total_amount: 350,
      line_items: [],
      notes: null,
      description: null,
    },
    confidence: {
      vendor_name: 0.95,
      total_amount: 0.95,
    },
  };

  const { service } = setupService({
    responseOutcome: mockOpenAiResponse(mockPayload),
  });

  const result = await service.extractBillFromText({ text: sourceText });
  assert.equal(result.success, true);
  assert.equal(result.bill.currency, null);
});

// -------------------------------------------------------------
// 4. GROUNDING TESTS
// -------------------------------------------------------------

test('17. Explicit values are marked correctly', () => {
  const text = 'Invoice 5543 from Delta Piping LLC for 4,500.00 AED on 2026-09-17';
  const bill = {
    vendor_name: 'Delta Piping LLC',
    bill_number: '5543',
    bill_date: '2026-09-17',
    due_date: null,
    currency: 'AED',
    subtotal: null,
    tax_amount: null,
    total_amount: 4500,
    line_items: [],
  };

  const grounding = computeGrounding(bill, text);
  assert.equal(grounding.vendor_name, 'explicit');
  assert.equal(grounding.bill_number, 'explicit');
  assert.equal(grounding.bill_date, 'explicit');
  assert.equal(grounding.currency, 'explicit');
  assert.equal(grounding.total_amount, 'explicit');
});

test('18. Inferred values are distinguishable', () => {
  const text = 'Paid 300 to John for site repair work';
  const bill = {
    vendor_name: 'John Site Services LLC', // Inferred expansion
    bill_number: null,
    bill_date: null,
    due_date: null,
    currency: 'AED', // Inferred currency not in text
    subtotal: null,
    tax_amount: null,
    total_amount: 300,
    line_items: [],
  };

  const grounding = computeGrounding(bill, text);
  assert.equal(grounding.vendor_name, 'inferred');
  assert.equal(grounding.currency, 'inferred');
  assert.equal(grounding.total_amount, 'explicit');
});

test('19. Missing values remain missing', () => {
  const text = 'Supplier: ABC General Trading\nAmount: 100';
  const bill = {
    vendor_name: 'ABC General Trading',
    bill_number: null,
    bill_date: null,
    due_date: null,
    currency: null,
    subtotal: null,
    tax_amount: null,
    total_amount: 100,
    line_items: [],
  };

  const grounding = computeGrounding(bill, text);
  assert.equal(grounding.bill_number, 'missing');
  assert.equal(grounding.bill_date, 'missing');
  assert.equal(grounding.due_date, 'missing');
  assert.equal(grounding.tax_amount, 'missing');
  assert.equal(grounding.line_items, 'missing');

  const conf = resolveConfidence({}, grounding);
  assert.equal(conf.bill_number, 0.0);
  assert.equal(conf.tax_amount, 0.0);
});

// -------------------------------------------------------------
// 5. VALIDATION TESTS
// -------------------------------------------------------------

test('20. Negative total fails validation', () => {
  const bill = {
    vendor_name: 'Supplier LLC',
    total_amount: -150,
  };
  const val = validateBill(bill);
  assert.equal(val.valid, false);
  const issue = val.issues.find((i) => i.code === 'NEGATIVE_TOTAL');
  assert.ok(issue);
});

test('21. NaN/Infinity fails validation', () => {
  const bill = {
    vendor_name: 'Supplier LLC',
    total_amount: Infinity,
    subtotal: NaN,
  };
  const val = validateBill(bill);
  assert.equal(val.valid, false);
  assert.ok(val.issues.some((i) => i.code === 'INVALID_AMOUNT'));
});

test('22. Invalid line item numbers fail validation', () => {
  const bill = {
    vendor_name: 'Supplier LLC',
    total_amount: 100,
    line_items: [
      { name: 'Item 1', quantity: -5, rate: 10, amount: -50 },
      { name: '', quantity: 1, rate: 10, amount: 10 },
    ],
  };
  const val = validateBill(bill);
  assert.equal(val.valid, false);
  assert.ok(val.issues.some((i) => i.code === 'NEGATIVE_LINE_ITEM_NUMBER'));
  assert.ok(val.issues.some((i) => i.code === 'INVALID_LINE_ITEM_NAME'));
});

test('23. Consistent subtotal + tax + total passes', () => {
  const bill = {
    vendor_name: 'Alpha Supplies',
    subtotal: 1000.0,
    tax_amount: 50.0,
    total_amount: 1050.0,
  };
  const val = validateBill(bill);
  assert.equal(val.valid, true);
  assert.equal(val.issues.length, 0);
});

test('24. Small rounding difference passes validation', () => {
  // 100.01 + 5.00 = 105.01, total = 105.03 (diff = 0.02 <= 0.05 tolerance)
  const bill = {
    vendor_name: 'Alpha Supplies',
    subtotal: 100.01,
    tax_amount: 5.0,
    total_amount: 105.03,
  };
  const val = validateBill(bill);
  assert.equal(val.valid, true);
  assert.equal(val.issues.length, 0);
});

test('25. Large total mismatch produces validation issue without altering numbers', () => {
  const bill = {
    vendor_name: 'Alpha Supplies',
    subtotal: 1000.0,
    tax_amount: 50.0,
    total_amount: 2000.0, // Large mismatch
  };
  const val = validateBill(bill);
  assert.equal(val.valid, false);
  const mismatch = val.issues.find((i) => i.code === 'TOTAL_MISMATCH');
  assert.ok(mismatch);
  // Numbers must not be silently changed
  assert.equal(val.normalizedBill.total_amount, 2000.0);
  assert.equal(val.normalizedBill.subtotal, 1000.0);
});

// -------------------------------------------------------------
// 6. ERROR RECOVERY TESTS
// -------------------------------------------------------------

test('26. Malformed model response does not crash and returns controlled error', async () => {
  const { service } = setupService({
    responseOutcome: mockOpenAiResponse('NOT VALID JSON AT ALL'),
  });

  const res = await service.extractBillFromText({ text: 'Some invoice text' });
  assert.equal(res.success, false);
  assert.equal(res.bill, null);
  assert.equal(res.error.code, 'AI_MALFORMED_RESPONSE');
});

test('27. Invalid structured output returns controlled error', async () => {
  // Violates schema (line_items not an array, total_amount not a number or null)
  const invalidStructuredJson = {
    bill: {
      vendor_name: 'Test',
      line_items: 'INVALID_TYPE',
    },
  };

  const { service } = setupService({
    responseOutcome: mockOpenAiResponse(invalidStructuredJson),
  });

  const res = await service.extractBillFromText({ text: 'Some invoice text' });
  assert.equal(res.success, false);
  assert.equal(res.bill, null);
  assert.equal(res.error.code, 'AI_MALFORMED_RESPONSE');
});

test('28. Mocked AI timeout returns controlled error', async () => {
  const timeoutErr = new Error('Request aborted');
  timeoutErr.code = 'ECONNABORTED';

  const { service } = setupService({
    responseOutcome: async () => {
      throw timeoutErr;
    },
  });

  const res = await service.extractBillFromText({ text: 'Some invoice text' });
  assert.equal(res.success, false);
  assert.equal(res.bill, null);
  assert.equal(res.error.code, 'AI_TIMEOUT');
});

test('29. Mocked AI provider error returns controlled error', async () => {
  const authErr = new Error('Unauthorized');
  authErr.response = { status: 401, data: { error: { message: 'Invalid API key' } } };

  const { service } = setupService({
    responseOutcome: async () => {
      throw authErr;
    },
  });

  const res = await service.extractBillFromText({ text: 'Some invoice text' });
  assert.equal(res.success, false);
  assert.equal(res.bill, null);
  assert.equal(res.error.code, 'AI_AUTHENTICATION_ERROR');
});

test('30. No secrets appear in thrown or returned public errors or logs', async () => {
  const privateApiKey = 'sk-proj-super-secret-production-openai-key-998877';
  const logs = [];
  const { service } = setupService({
    env: mockEnvironment({ OPENAI_API_KEY: privateApiKey }),
    logger: {
      info: (rec) => logs.push(rec),
      error: (rec) => logs.push(rec),
    },
    responseOutcome: async () => {
      const err = new Error(`Request to OpenAI failed with key ${privateApiKey}`);
      err.response = { status: 500 };
      throw err;
    },
  });

  const res = await service.extractBillFromText({ text: 'Sample invoice text' });
  assert.equal(res.success, false);
  assert.ok(res.error);

  const inspectedError = inspect(res.error);
  const inspectedLogs = inspect(logs);

  assert.equal(inspectedError.includes(privateApiKey), false, 'API key must not leak in error');
  assert.equal(inspectedLogs.includes(privateApiKey), false, 'API key must not leak in logs');
});
