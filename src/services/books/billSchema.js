'use strict';

const { z } = require('zod');

const GROUNDING_STATES = Object.freeze(['explicit', 'inferred', 'missing']);

const TRACKED_FIELDS = Object.freeze([
  'vendor_name',
  'bill_number',
  'bill_date',
  'due_date',
  'currency',
  'subtotal',
  'tax_amount',
  'total_amount',
  'line_items',
]);

const finiteNumberSchema = z.number().refine(
  (n) => Number.isFinite(n) && !Number.isNaN(n),
  { message: 'Must be a finite number' }
);

const lineItemSchema = z.object({
  name: z.string().min(1, 'Line item name must not be empty'),
  description: z.string().nullable().default(null),
  quantity: finiteNumberSchema.nullable().default(null),
  rate: finiteNumberSchema.nullable().default(null),
  amount: finiteNumberSchema.nullable().default(null),
  tax_percentage: finiteNumberSchema.nullable().default(null),
}).strict();

const billCoreSchema = z.object({
  vendor_name: z.string().nullable().default(null),
  bill_number: z.string().nullable().default(null),
  bill_date: z.string().nullable().default(null),
  due_date: z.string().nullable().default(null),
  currency: z.string().nullable().default(null),
  payment_type: z.string().nullable().default(null),
  subtotal: finiteNumberSchema.nullable().default(null),
  tax_amount: finiteNumberSchema.nullable().default(null),
  total_amount: finiteNumberSchema.nullable().default(null),
  line_items: z.array(lineItemSchema).default([]),
  notes: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
}).strict();

const groundingStateSchema = z.enum(['explicit', 'inferred', 'missing']);

const groundingSchema = z.record(z.string(), groundingStateSchema);

const confidenceScoreSchema = z.number().refine(
  (n) => Number.isFinite(n) && !Number.isNaN(n) && n >= 0 && n <= 1,
  { message: 'Confidence must be a finite number between 0 and 1' }
);

const confidenceSchema = z.record(z.string(), confidenceScoreSchema);

const extractedBillEnvelopeSchema = z.object({
  bill: billCoreSchema,
  confidence: confidenceSchema.optional().default({}),
  grounding: groundingSchema.optional(),
}).strict();

/**
 * Strict JSON schema for OpenAI Responses API structured outputs
 */
const billExtractionJsonSchema = {
  type: 'object',
  properties: {
    bill: {
      type: 'object',
      properties: {
        vendor_name: { type: ['string', 'null'] },
        bill_number: { type: ['string', 'null'] },
        bill_date: { type: ['string', 'null'] },
        due_date: { type: ['string', 'null'] },
        currency: { type: ['string', 'null'] },
        payment_type: { type: ['string', 'null'] },
        subtotal: { type: ['number', 'null'] },
        tax_amount: { type: ['number', 'null'] },
        total_amount: { type: ['number', 'null'] },
        line_items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: ['string', 'null'] },
              quantity: { type: ['number', 'null'] },
              rate: { type: ['number', 'null'] },
              amount: { type: ['number', 'null'] },
              tax_percentage: { type: ['number', 'null'] },
            },
            required: ['name', 'description', 'quantity', 'rate', 'amount', 'tax_percentage'],
            additionalProperties: false,
          },
        },
        notes: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
      },
      required: [
        'vendor_name',
        'bill_number',
        'bill_date',
        'due_date',
        'currency',
        'payment_type',
        'subtotal',
        'tax_amount',
        'total_amount',
        'line_items',
        'notes',
        'description',
      ],
      additionalProperties: false,
    },
    confidence: {
      type: 'object',
      properties: {
        vendor_name: { type: ['number', 'null'] },
        bill_number: { type: ['number', 'null'] },
        bill_date: { type: ['number', 'null'] },
        due_date: { type: ['number', 'null'] },
        currency: { type: ['number', 'null'] },
        subtotal: { type: ['number', 'null'] },
        tax_amount: { type: ['number', 'null'] },
        total_amount: { type: ['number', 'null'] },
        line_items: { type: ['number', 'null'] },
      },
      required: [
        'vendor_name',
        'bill_number',
        'bill_date',
        'due_date',
        'currency',
        'subtotal',
        'tax_amount',
        'total_amount',
        'line_items',
      ],
      additionalProperties: false,
    },
  },
  required: ['bill', 'confidence'],
  additionalProperties: false,
};

module.exports = {
  GROUNDING_STATES,
  TRACKED_FIELDS,
  lineItemSchema,
  billCoreSchema,
  groundingStateSchema,
  groundingSchema,
  confidenceScoreSchema,
  confidenceSchema,
  extractedBillEnvelopeSchema,
  billExtractionJsonSchema,
};
