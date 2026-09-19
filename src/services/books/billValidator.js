'use strict';
const { normalizePaymentMethod } = require('./paymentMethods');

const MONTH_NAMES = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const CURRENCY_SYMBOLS = {
  '$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '₹': 'INR',
  '¥': 'JPY',
  'د.إ': 'AED',
  'ر.س': 'SAR',
};

const CURRENCY_ALIASES = {
  aed: 'AED', dhs: 'AED', dh: 'AED', dirham: 'AED', dirhams: 'AED',
  usd: 'USD',
  eur: 'EUR', euro: 'EUR', euros: 'EUR',
  gbp: 'GBP', pound: 'GBP', pounds: 'GBP',
  sar: 'SAR',
  qar: 'QAR',
  kwd: 'KWD',
  bhd: 'BHD',
  omr: 'OMR',
  inr: 'INR',
};

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

function getDaysInMonth(year, month) {
  if ([4, 6, 9, 11].includes(month)) return 30;
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return 31;
}

function isValidCalendarDate(year, month, day) {
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  const maxDays = getDaysInMonth(year, month);
  return day >= 1 && day <= maxDays;
}

function formatYyyyMmDd(year, month, day) {
  const y = String(year);
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Deterministic date normalization.
 * Supports:
 * - ISO: YYYY-MM-DD
 * - DD/MM/YYYY or DD-MM-YYYY (unambiguous)
 * - Textual dates (e.g. 17 Sep 2026, September 17, 2026)
 *
 * Rejects ambiguous dates (e.g. 03/04/2026) without guessing.
 * Rejects invalid calendar dates (e.g. 2026-02-31).
 */
function normalizeDate(input, fieldName = 'date') {
  if (!input || typeof input !== 'string') {
    return { date: null, issue: null };
  }

  const raw = input.trim();
  if (!raw) {
    return { date: null, issue: null };
  }

  // 1. ISO format: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    if (!isValidCalendarDate(year, month, day)) {
      return {
        date: null,
        issue: {
          field: fieldName,
          code: 'INVALID_CALENDAR_DATE',
          message: `Invalid calendar date: "${raw}".`,
        },
      };
    }
    return { date: formatYyyyMmDd(year, month, day), issue: null };
  }

  // 2. Textual dates: "17 Sep 2026", "17 September 2026", "September 17, 2026", "Sep 17, 2026"
  // Day Month Year
  const dmyText = raw.match(/^(\d{1,2})[\s-]+([a-zA-Z]+)[\s,]+(\d{4})$/);
  if (dmyText) {
    const day = parseInt(dmyText[1], 10);
    const monthName = dmyText[2].toLowerCase();
    const year = parseInt(dmyText[3], 10);
    const month = MONTH_NAMES[monthName];
    if (!month) {
      return {
        date: null,
        issue: {
          field: fieldName,
          code: 'INVALID_DATE_FORMAT',
          message: `Unrecognized month name in date: "${raw}".`,
        },
      };
    }
    if (!isValidCalendarDate(year, month, day)) {
      return {
        date: null,
        issue: {
          field: fieldName,
          code: 'INVALID_CALENDAR_DATE',
          message: `Invalid calendar date: "${raw}".`,
        },
      };
    }
    return { date: formatYyyyMmDd(year, month, day), issue: null };
  }

  // Month Day Year: "September 17, 2026" or "Sep 17 2026"
  const mdyText = raw.match(/^([a-zA-Z]+)[\s-]+(\d{1,2})[\s,]+(\d{4})$/);
  if (mdyText) {
    const monthName = mdyText[1].toLowerCase();
    const day = parseInt(mdyText[2], 10);
    const year = parseInt(mdyText[3], 10);
    const month = MONTH_NAMES[monthName];
    if (!month) {
      return {
        date: null,
        issue: {
          field: fieldName,
          code: 'INVALID_DATE_FORMAT',
          message: `Unrecognized month name in date: "${raw}".`,
        },
      };
    }
    if (!isValidCalendarDate(year, month, day)) {
      return {
        date: null,
        issue: {
          field: fieldName,
          code: 'INVALID_CALENDAR_DATE',
          message: `Invalid calendar date: "${raw}".`,
        },
      };
    }
    return { date: formatYyyyMmDd(year, month, day), issue: null };
  }

  // 3. Numeric formats with delimiters: DD/MM/YYYY, MM/DD/YYYY, DD-MM-YYYY
  const numMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (numMatch) {
    const p1 = parseInt(numMatch[1], 10);
    const p2 = parseInt(numMatch[2], 10);
    const year = parseInt(numMatch[3], 10);

    // If both numbers are <= 12 and not equal, it's ambiguous!
    if (p1 <= 12 && p2 <= 12 && p1 !== p2) {
      return {
        date: null,
        issue: {
          field: fieldName,
          code: 'AMBIGUOUS_DATE',
          message: `Ambiguous date "${raw}". Cannot deterministically distinguish day from month without contextual evidence.`,
        },
      };
    }

    let day;
    let month;
    if (p1 > 12 && p2 <= 12) {
      // Unambiguously DD/MM/YYYY
      day = p1;
      month = p2;
    } else if (p2 > 12 && p1 <= 12) {
      // Unambiguously MM/DD/YYYY
      month = p1;
      day = p2;
    } else if (p1 === p2 && p1 <= 12) {
      // Day and month are identical (e.g. 05/05/2026)
      day = p1;
      month = p2;
    } else {
      return {
        date: null,
        issue: {
          field: fieldName,
          code: 'INVALID_DATE_FORMAT',
          message: `Invalid numeric date: "${raw}".`,
        },
      };
    }

    if (!isValidCalendarDate(year, month, day)) {
      return {
        date: null,
        issue: {
          field: fieldName,
          code: 'INVALID_CALENDAR_DATE',
          message: `Invalid calendar date: "${raw}".`,
        },
      };
    }

    return { date: formatYyyyMmDd(year, month, day), issue: null };
  }

  return {
    date: null,
    issue: {
      field: fieldName,
      code: 'UNRECOGNIZED_DATE_FORMAT',
      message: `Cannot parse date: "${raw}".`,
    },
  };
}

/**
 * Normalizes currency string to standard ISO currency code.
 * Returns null if missing.
 */
function normalizeCurrency(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (CURRENCY_SYMBOLS[trimmed]) {
    return CURRENCY_SYMBOLS[trimmed];
  }

  const lower = trimmed.toLowerCase();
  if (CURRENCY_ALIASES[lower]) {
    return CURRENCY_ALIASES[lower];
  }

  // If 3 letters ISO code, uppercase it
  if (/^[a-zA-Z]{3}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  return trimmed.toUpperCase();
}

/**
 * Validates extracted bill fields according to business accounting rules.
 */
function validateBill(bill = {}) {
  const issues = [];
  const normalized = { ...bill };

  // 1. Vendor Name
  if (!normalized.vendor_name || typeof normalized.vendor_name !== 'string' || !normalized.vendor_name.trim()) {
    issues.push({
      field: 'vendor_name',
      code: 'MISSING_VENDOR',
      message: 'Vendor name is required.',
    });
    normalized.vendor_name = null;
  } else {
    normalized.vendor_name = normalized.vendor_name.trim();
  }

  // 2. Bill Date Normalization & Verification
  if (normalized.bill_date) {
    const { date, issue } = normalizeDate(normalized.bill_date, 'bill_date');
    if (issue) issues.push(issue);
    normalized.bill_date = date;
  }

  // 3. Due Date Normalization & Verification
  if (normalized.due_date) {
    const { date, issue } = normalizeDate(normalized.due_date, 'due_date');
    if (issue) issues.push(issue);
    normalized.due_date = date;
  }

  // 4. Currency Normalization
  normalized.currency = normalizeCurrency(normalized.currency);

  // 4a. Payment method normalization; unsupported values remain missing and must be supplied by the worker.
  normalized.payment_type = normalized.payment_type ? normalizePaymentMethod(normalized.payment_type) : null;

  // 5. Total Amount Validation
  if (normalized.total_amount === null || normalized.total_amount === undefined) {
    issues.push({
      field: 'total_amount',
      code: 'MISSING_TOTAL',
      message: 'Total amount is required.',
    });
  } else if (typeof normalized.total_amount !== 'number' || !Number.isFinite(normalized.total_amount)) {
    issues.push({
      field: 'total_amount',
      code: 'INVALID_AMOUNT',
      message: 'Total amount must be a finite number.',
    });
    normalized.total_amount = null;
  } else if (normalized.total_amount < 0) {
    issues.push({
      field: 'total_amount',
      code: 'NEGATIVE_TOTAL',
      message: 'Total amount cannot be negative.',
    });
  }

  // 6. Subtotal Validation
  if (normalized.subtotal !== null && normalized.subtotal !== undefined) {
    if (typeof normalized.subtotal !== 'number' || !Number.isFinite(normalized.subtotal)) {
      issues.push({
        field: 'subtotal',
        code: 'INVALID_AMOUNT',
        message: 'Subtotal must be a finite number.',
      });
      normalized.subtotal = null;
    } else if (normalized.subtotal < 0) {
      issues.push({
        field: 'subtotal',
        code: 'NEGATIVE_AMOUNT',
        message: 'Subtotal cannot be negative.',
      });
    }
  }

  // 7. Tax Amount Validation
  if (normalized.tax_amount !== null && normalized.tax_amount !== undefined) {
    if (typeof normalized.tax_amount !== 'number' || !Number.isFinite(normalized.tax_amount)) {
      issues.push({
        field: 'tax_amount',
        code: 'INVALID_AMOUNT',
        message: 'Tax amount must be a finite number.',
      });
      normalized.tax_amount = null;
    } else if (normalized.tax_amount < 0) {
      issues.push({
        field: 'tax_amount',
        code: 'NEGATIVE_AMOUNT',
        message: 'Tax amount cannot be negative.',
      });
    }
  }

  // 8. Line Items Validation
  if (Array.isArray(normalized.line_items)) {
    normalized.line_items.forEach((item, index) => {
      const path = `line_items[${index}]`;
      if (!item || typeof item !== 'object') {
        issues.push({
          field: path,
          code: 'INVALID_LINE_ITEM',
          message: 'Line item must be an object.',
        });
        return;
      }
      if (!item.name || typeof item.name !== 'string' || !item.name.trim()) {
        issues.push({
          field: `${path}.name`,
          code: 'INVALID_LINE_ITEM_NAME',
          message: 'Line item name must not be empty.',
        });
      }

      ['quantity', 'rate', 'amount'].forEach((prop) => {
        if (item[prop] !== null && item[prop] !== undefined) {
          if (typeof item[prop] !== 'number' || !Number.isFinite(item[prop])) {
            issues.push({
              field: `${path}.${prop}`,
              code: 'INVALID_LINE_ITEM_NUMBER',
              message: `Line item ${prop} must be a finite number.`,
            });
          } else if (item[prop] < 0) {
            issues.push({
              field: `${path}.${prop}`,
              code: 'NEGATIVE_LINE_ITEM_NUMBER',
              message: `Line item ${prop} cannot be negative.`,
            });
          }
        }
      });
    });
  } else {
    normalized.line_items = [];
  }

  // 9. Totals Consistency Check (subtotal + tax ≈ total)
  if (
    normalized.subtotal !== null &&
    normalized.tax_amount !== null &&
    normalized.total_amount !== null &&
    Number.isFinite(normalized.subtotal) &&
    Number.isFinite(normalized.tax_amount) &&
    Number.isFinite(normalized.total_amount)
  ) {
    const expectedTotal = normalized.subtotal + normalized.tax_amount;
    const diff = Math.abs(normalized.total_amount - expectedTotal);
    // Allow small rounding tolerance (0.05)
    const ROUNDING_TOLERANCE = 0.05;
    if (diff > ROUNDING_TOLERANCE) {
      issues.push({
        field: 'total_amount',
        code: 'TOTAL_MISMATCH',
        message: `Subtotal (${normalized.subtotal}) + Tax (${normalized.tax_amount}) = ${expectedTotal.toFixed(2)} does not match Total (${normalized.total_amount}). Difference: ${diff.toFixed(2)}.`,
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    normalizedBill: normalized,
  };
}

module.exports = {
  MONTH_NAMES,
  normalizeDate,
  normalizeCurrency,
  validateBill,
  isValidCalendarDate,
};
