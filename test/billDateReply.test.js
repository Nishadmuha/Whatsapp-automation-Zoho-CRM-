'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDate, validateBill } = require('../src/services/books/billValidator');
const { parseBillDateReply } = require('../src/services/books/billDateReply');

test('printed 7-Oct-26 and named-month separator variants normalize without AI or clock lookup', () => {
  for (const source of ['7-Oct-26', '7-Oct-2026', '07-oct-26', '7 October 26',
    '7/Oct/26', '7 Oct, 2026', 'October 7, 26', 'Oct-7-2026', 'Oct/7/26']) {
    assert.deepEqual(normalizeDate(source, 'bill_date'), { date: '2026-10-07', issue: null }, source);
  }
  const validated = validateBill({ vendor_name: 'Fixture supplier', bill_date: '7-Oct-26', total_amount: 105 });
  assert.equal(validated.normalizedBill.bill_date, '2026-10-07');
  assert.deepEqual(validated.issues, []);
});

test('named-month short years deliberately mean 2000-2099; explicit historical years retain their century', () => {
  for (const [source, expected] of [
    ['1-Jan-00', '2000-01-01'], ['31-Dec-99', '2099-12-31'],
    ['1 Jan 1900', '1900-01-01'], ['31-Dec-1999', '1999-12-31'],
    ['29-Feb-00', '2000-02-29'], ['29 Feb 2024', '2024-02-29'],
  ]) assert.deepEqual(normalizeDate(source), { date: expected, issue: null }, source);
});

test('new named-month formats still reject impossible dates and unrecognized months', () => {
  for (const source of ['31-Apr-26', '29-Feb-26', '32-Oct-26', '0-Oct-26', 'Oct-32-2026']) {
    const result = normalizeDate(source, 'bill_date');
    assert.equal(result.date, null, source);
    assert.equal(result.issue.code, 'INVALID_CALENDAR_DATE', source);
    assert.equal(result.issue.field, 'bill_date');
  }
  assert.equal(normalizeDate('7-NotAMonth-26').issue.code, 'INVALID_DATE_FORMAT');
});

test('existing unambiguous ISO and numeric date formats retain their behavior', () => {
  for (const [source, expected] of [
    ['2026-10-07', '2026-10-07'], ['2026/10/07', '2026-10-07'],
    ['17/09/2026', '2026-09-17'], ['09/17/2026', '2026-09-17'],
    ['05/05/2026', '2026-05-05'], ['17 Sep 2026', '2026-09-17'],
  ]) assert.deepEqual(normalizeDate(source), { date: expected, issue: null }, source);
  assert.equal(normalizeDate('03/04/2026').issue.code, 'AMBIGUOUS_DATE');
});

test('short numeric dates, relative days and incomplete dates never receive a guessed date', () => {
  for (const source of ['7/10/26', '10/7/26', '17/09/26', 'today', 'yesterday',
    'tomorrow', '7 Oct', '7-Oct-6', '7-Oct-026', '2026-10-07T12:00:00Z']) {
    assert.equal(normalizeDate(source).date, null, source);
    assert.equal(parseBillDateReply(source, { allowBare: true }), null, source);
  }
});

test('bare worker date replies require the caller to explicitly allow missing-date input', () => {
  for (const source of ['7-oct-26', '2026-10-07', '17/09/2026']) {
    assert.equal(parseBillDateReply(source), null);
    assert.equal(parseBillDateReply(source, { allowBare: true }), normalizeDate(source).date);
  }
});

test('explicit bill and invoice date labels identify narrow corrections', () => {
  for (const source of ['Bill date: 7-Oct-26', 'Invoice date = 7-Oct-2026',
    'Date: 2026-10-07', 'Bill date is 7 October 26', 'Invoice date 7-Oct-26']) {
    assert.equal(parseBillDateReply(source), '2026-10-07', source);
  }
});

test('mixed corrections, due dates and unrelated bill data are not consumed as a bill date', () => {
  for (const source of ['Due date: 7-Oct-26', 'Delivery date: 7-Oct-26',
    'Bill number: 7-Oct-26', 'Bill date: 7-Oct-26; Total: 999',
    'Invoice date: 7-Oct-26\nVendor: Another supplier', '7-Oct-26 and change total to 999',
    'Bill date: today', 'Bill date: 03/04/2026', 'Bill date: 7/10/26',
    '', null, 20261007]) {
    assert.equal(parseBillDateReply(source, { allowBare: true }), null, String(source));
  }
});
