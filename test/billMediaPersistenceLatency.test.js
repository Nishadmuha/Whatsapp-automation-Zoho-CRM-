'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, validBill } = require('./billFixtures');

const turn = () => new Promise(resolve => setImmediate(resolve));
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

function harness({ storageGates = {}, visionGate = null, storageFailures = [], downloadFailures = [],
  visionFailure = false, missingReference = false } = {}) {
  const events = [], logs = [], visionInputs = [], stored = new Map();
  const f = fixture({ sourceStore: {
    async saveMediaFile(input) {
      events.push(`storage:${input.mediaId}`);
      const blocked = storageGates[input.mediaId];
      if (blocked) await blocked.promise;
      if (storageFailures.includes(input.mediaId)) throw Object.assign(Error('Fixture storage failure'), { code: 'FIXTURE_STORAGE_FAILED' });
      const reference = `stored:${input.mediaId}`;
      stored.set(reference, { ...input });
      return missingReference ? {} : { storageReference: reference };
    },
    async getMediaFile(reference) { return stored.get(reference); },
  }, whatsappOverrides: {
    async downloadMedia(id) {
      events.push(`download:${id}`);
      if (downloadFailures.includes(id)) throw Object.assign(Error('Fixture download failure'), { code: 'FIXTURE_DOWNLOAD_FAILED' });
      return { buffer: Buffer.from(`original:${id}`), mimeType: 'image/jpeg' };
    },
  }, extractionOverrides: {
    async extractBillFromMedia(input) {
      events.push('vision');
      visionInputs.push(input);
      if (visionGate) await visionGate.promise;
      if (visionFailure) return { success: false, bill: null, error: { code: 'AI_MALFORMED_RESPONSE' } };
      return { success: true, bill: validBill() };
    },
  }, logger: { info: event => logs.push(event), warn: event => logs.push(event), error: event => logs.push(event) } });
  return { ...f, events, logs, visionInputs, stored };
}

function assertNoDraft(h) {
  assert.equal(h.billStore.sessions.size, 0);
  assert.equal(h.billStore.bills.size, 0);
  assert.equal(h.calls.some(([action]) => ['vendor', 'create', 'attach', 'pdf', 'document'].includes(action)), false);
}

test('initial direct vision starts while durable storage is pending, but neither review nor draft can precede storage', async t => {
  const storage = gate(), vision = gate();
  t.after(() => { storage.release(); vision.release(); });
  const h = harness({ storageGates: { first: storage }, visionGate: vision });
  let finished = false;
  const pending = h.send('', { messageType: 'image', mediaId: 'first' }).then(result => { finished = true; return result; });
  await turn();
  assert.deepEqual(h.events, ['download:first', 'storage:first', 'vision']);
  assertNoDraft(h);
  assert.equal(finished, false);
  vision.release();
  await turn();
  assertNoDraft(h);
  assert.equal(finished, false, 'Even completed extraction must wait for the original attachment to be durable');
  storage.release();
  const result = await pending;
  assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
  const record = await h.billStore.getBill(result.billId);
  assert.equal(record.attachments[0].storage_reference, 'stored:first');
  assert.equal(h.visionInputs[0].media[0].buffer.toString(), 'original:first');
  assert.equal(h.calls.some(([action]) => action === 'ocr'), false);
});

test('failed storage awaits successful vision and creates no draft or financial write', async t => {
  const vision = gate();
  t.after(() => vision.release());
  const h = harness({ visionGate: vision, storageFailures: ['first'] });
  let finished = false;
  const pending = h.send('', { messageType: 'image', mediaId: 'first' }).then(result => { finished = true; return result; });
  await turn();
  assert.ok(h.events.includes('vision'));
  assert.equal(finished, false, 'A storage failure must still consume the already-started extraction');
  assertNoDraft(h);
  vision.release();
  assert.match((await pending).replyText, /could not read or store/i);
  assertNoDraft(h);
  assert.equal(h.logs.at(-1).category, 'MEDIA_STORAGE_FAILURE');
  assert.equal(h.logs.at(-1).reason, 'FIXTURE_STORAGE_FAILED');
});

test('failed vision awaits durable storage before returning, without creating a draft', async t => {
  const storage = gate();
  t.after(() => storage.release());
  const h = harness({ storageGates: { first: storage }, visionFailure: true });
  let finished = false;
  const pending = h.send('', { messageType: 'image', mediaId: 'first' }).then(result => { finished = true; return result; });
  await turn();
  assert.ok(h.events.includes('vision'));
  assert.equal(finished, false);
  assertNoDraft(h);
  storage.release();
  assert.match((await pending).replyText, /could not read or store/i);
  assert.equal(h.stored.has('stored:first'), true);
  assertNoDraft(h);
  assert.equal(h.logs.at(-1).category, 'C_INVALID_AI_JSON');
});

test('simultaneous storage and vision failures preserve storage error precedence', async () => {
  const h = harness({ storageFailures: ['first'], visionFailure: true });
  await h.send('', { messageType: 'image', mediaId: 'first' });
  assertNoDraft(h);
  assert.equal(h.logs.at(-1).category, 'MEDIA_STORAGE_FAILURE');
  assert.equal(h.logs.at(-1).reason, 'FIXTURE_STORAGE_FAILED');
});

test('a storage response without a durable reference still blocks a successful vision result', async () => {
  const h = harness({ missingReference: true });
  await h.send('', { messageType: 'image', mediaId: 'first' });
  assertNoDraft(h);
  assert.equal(h.logs.at(-1).reason, 'MEDIA_NOT_PERSISTED');
});

test('multi-image vision and attachments retain source order despite reverse storage completion', async t => {
  const first = gate(), second = gate();
  t.after(() => { first.release(); second.release(); });
  const h = harness({ storageGates: { first, second } });
  const pending = h.send('', { items: [
    { messageId: 'page-1', messageType: 'image', mediaId: 'first', mediaFilename: 'first.jpg' },
    { messageId: 'page-2', messageType: 'image', mediaId: 'second', mediaFilename: 'second.jpg' },
  ] });
  await turn();
  assert.equal(h.visionInputs.length, 1);
  assert.deepEqual(h.visionInputs[0].media.map(item => item.buffer.toString()), ['original:first', 'original:second']);
  assertNoDraft(h);
  second.release();
  await turn();
  assertNoDraft(h);
  first.release();
  const result = await pending;
  const record = await h.billStore.getBill(result.billId);
  assert.deepEqual(record.attachments.map(item => item.storage_reference), ['stored:first', 'stored:second']);
  assert.deepEqual(record.attachments.map(item => item.message_id), ['page-1', 'page-2']);
  assert.deepEqual(record.attachments.map(item => item.original_filename), ['first.jpg', 'second.jpg']);
  await h.send('SAVE');
  assert.deepEqual(h.calls.filter(([action]) => action === 'attach').map(([, input]) => input.buffer.toString()),
    ['original:first', 'original:second']);
});

test('one failed batch download still awaits storage already started for another image', async t => {
  const storage = gate();
  t.after(() => storage.release());
  const h = harness({ storageGates: { first: storage }, downloadFailures: ['second'] });
  let finished = false;
  const pending = h.send('', { items: [
    { messageId: 'page-1', messageType: 'image', mediaId: 'first' },
    { messageId: 'page-2', messageType: 'image', mediaId: 'second' },
  ] }).then(result => { finished = true; return result; });
  await turn();
  assert.equal(h.events.includes('vision'), false, 'An incomplete batch must not be sent for extraction');
  assert.equal(finished, false);
  assertNoDraft(h);
  storage.release();
  assert.match((await pending).replyText, /could not read or store/i);
  assert.equal(h.stored.has('stored:first'), true);
  assertNoDraft(h);
});

test('media edits keep their existing OCR and persistence boundary before applying corrections', async t => {
  const storage = gate();
  t.after(() => storage.release());
  const h = harness({ storageGates: { correction: storage } });
  const first = await h.send('Invoice details');
  await h.send('EDIT');
  const pending = h.send('', { messageType: 'image', mediaId: 'correction' });
  await turn();
  assert.equal(h.calls.filter(([action]) => action === 'ocr').length, 1);
  assert.equal(h.calls.some(([action]) => action === 'merge'), false);
  assert.equal(h.visionInputs.length, 0);
  assert.deepEqual((await h.billStore.getBill(first.billId)).attachments, []);
  storage.release();
  const result = await pending;
  assert.equal(result.billId, first.billId);
  assert.equal(h.calls.filter(([action]) => action === 'merge').length, 1);
  assert.equal((await h.billStore.getBill(first.billId)).attachments[0].storage_reference, 'stored:correction');
});
