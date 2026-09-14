'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createIncomingTriggerGate } = require('../src/services/whatsapp/incomingTriggerGate');

const START = Date.UTC(2026, 8, 13, 12);
const seconds = milliseconds => String(Math.floor(milliseconds / 1000));

test('incoming trigger accepts the startup second and rejects historical, future and malformed timestamps', () => {
  let now = START + 750;
  const gate = createIncomingTriggerGate({ now: () => now });
  assert.equal(gate.reason(seconds(START)), null);
  assert.equal(gate.reason(seconds(START - 1000)), 'historical');
  assert.equal(gate.reason(seconds(START + 1000)), 'future');
  for (const timestamp of [undefined, null, '', '0', '-1', '1.5', {}, 123]) {
    assert.equal(gate.reason(timestamp), 'invalid');
  }
  now += 301000;
  assert.equal(gate.reason(seconds(START)), 'historical');
});

test('each admitted incoming message can begin processing once and completion revokes its authority', () => {
  const gate = createIncomingTriggerGate({ now: () => START });
  assert.equal(gate.beginProcessing('unknown'), false);
  assert.equal(gate.admit('fresh', seconds(START)), true);
  assert.equal(gate.admit('fresh', seconds(START)), false);
  assert.equal(gate.allows('fresh'), true);
  assert.equal(gate.beginProcessing('fresh'), true);
  assert.equal(gate.beginProcessing('fresh'), false);
  assert.deepEqual(gate.messageIds(), ['fresh']);
  gate.finish('fresh');
  assert.equal(gate.allows('fresh'), false);
  assert.equal(gate.beginProcessing('fresh'), false);
  assert.equal(gate.admit('fresh', seconds(START)), false);
  assert.deepEqual(gate.messageIds(), []);
});

test('expiry and shutdown revoke pending AI and reply permission without creating another trigger', () => {
  let now = START;
  const gate = createIncomingTriggerGate({ now: () => now, maxAgeMs: 5000 });
  assert.equal(gate.admit('pending', seconds(now)), true);
  assert.equal(gate.beginProcessing('pending'), true);
  now += 5001;
  assert.equal(gate.allows('pending'), false);
  assert.deepEqual(gate.messageIds(), []);
  assert.equal(gate.admit('next', seconds(now)), true);
  gate.close();
  gate.close();
  assert.equal(gate.reason(seconds(now)), 'stopped');
  assert.equal(gate.allows('next'), false);
  assert.equal(gate.beginProcessing('next'), false);
  assert.equal(gate.admit('after-stop', seconds(now)), false);
  assert.deepEqual(gate.messageIds(), []);
});

test('a restarted trigger gate cannot authorize any persisted message from a prior runtime', () => {
  const original = createIncomingTriggerGate({ now: () => START });
  original.admit('previous', seconds(START));
  original.beginProcessing('previous');
  const restarted = createIncomingTriggerGate({ now: () => START + 1000 });
  assert.equal(restarted.allows('previous'), false);
  assert.equal(restarted.beginProcessing('previous'), false);
  assert.equal(restarted.admit('previous', seconds(START)), false);
  assert.deepEqual(restarted.messageIds(), []);
});

test('claim batches are bounded while every accepted fresh message remains reachable', () => {
  const gate = createIncomingTriggerGate({ now: () => START });
  const accepted = [];
  for (let index = 0; index < 1005; index++) {
    const id = 'fresh-' + index;
    if (gate.admit(id, seconds(START))) accepted.push(id);
  }
  assert.ok(accepted.length >= 1000);
  const claimed = new Set();
  while (gate.messageIds().length) {
    const batch = gate.messageIds();
    assert.ok(batch.length <= 1000);
    for (const id of batch) {
      assert.equal(claimed.has(id), false);
      claimed.add(id);
      gate.finish(id);
    }
  }
  assert.deepEqual([...claimed], accepted);
});
