'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { createWhatsAppService } = require('../src/services/whatsapp/whatsappService');
const { mediaKind, mediaSizeLimit, isAttachmentOnlyMimeType, MAX_MEDIA_BYTES } = require('../src/utils/media');
const { silent } = require('./helpers');

function setup({ mimeType = 'image/vnd.dwg', metadataPatch = {}, downloadType = mimeType } = {}) {
  const bytes = Buffer.from('AC1032 synthetic CAD original');
  const url = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=12345&signature=mock';
  const calls = [];
  const service = createWhatsAppService({
    env: { WHATSAPP_ACCESS_TOKEN: 'mock-token', WHATSAPP_PHONE_NUMBER_ID: '12345678', META_GRAPH_API_VERSION: 'v25.0' },
    logger: silent,
    http: { async get(target, options) {
      calls.push({ target, options });
      if (calls.length === 1) {
        assert.equal(target, 'https://graph.facebook.com/v25.0/12345');
        return { status: 200, data: { id: '12345', url, mime_type: mimeType, file_size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('base64'), ...metadataPatch } };
      }
      assert.equal(target, url);
      assert.equal(options.headers.Authorization, 'Bearer mock-token');
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.maxContentLength, MAX_MEDIA_BYTES);
      return { status: 200, headers: { 'content-type': downloadType }, data: bytes };
    } },
  });
  return { service, bytes, calls };
}

test('DWG original download requires attachment mode and never becomes OCR media', async () => {
  const f = setup();
  assert.equal(isAttachmentOnlyMimeType('IMAGE/VND.DWG; charset=binary'), true);
  assert.equal(mediaKind('image/vnd.dwg'), null);
  assert.equal(mediaSizeLimit('image/vnd.dwg'), 0);
  await assert.rejects(f.service.downloadMedia('12345'), { code: 'ERR_WHATSAPP_MEDIA' });
  assert.equal(f.calls.length, 1, 'default extraction cannot download CAD bytes');
});

test('attachment mode preserves original CAD bytes after authenticated checksum-verified download', async () => {
  for (const mimeType of ['image/vnd.dwg', 'image/x-dwg', 'application/acad', 'application/x-acad',
    'application/autocad', 'application/x-autocad', 'application/dwg', 'application/x-dwg']) {
    const f = setup({ mimeType });
    const result = await f.service.downloadMedia('12345', { purpose: 'attachment' });
    assert.deepEqual(result.buffer, f.bytes);
    assert.equal(result.mimeType, mimeType);
    assert.equal(f.calls.length, 2);
  }
});

test('attachment mode does not permit arbitrary unsupported file types', async () => {
  for (const mimeType of ['application/octet-stream', 'application/x-msdownload', 'video/mp4', 'image/svg+xml']) {
    const f = setup({ mimeType });
    await assert.rejects(f.service.downloadMedia('12345', { purpose: 'attachment' }), { code: 'ERR_WHATSAPP_MEDIA' });
    assert.equal(f.calls.length, 1);
  }
});

test('CAD original download rejects forged URLs before sending the bearer token', async () => {
  for (const url of ['https://example.com/whatsapp_business/attachments/file',
    'https://lookaside.fbsbx.com.example.com/whatsapp_business/attachments/file',
    'http://lookaside.fbsbx.com/whatsapp_business/attachments/file',
    'https://lookaside.fbsbx.com/other/file']) {
    const f = setup({ metadataPatch: { url } });
    await assert.rejects(f.service.downloadMedia('12345', { purpose: 'attachment' }), { code: 'ERR_WHATSAPP_MEDIA' });
    assert.equal(f.calls.length, 1);
  }
});

test('CAD original download rejects corrupt bytes and MIME mismatches', async () => {
  for (const options of [{ metadataPatch: { sha256: Buffer.alloc(32).toString('base64') } },
    { downloadType: 'application/octet-stream' }]) {
    const f = setup(options);
    await assert.rejects(f.service.downloadMedia('12345', { purpose: 'attachment' }), { code: 'ERR_WHATSAPP_MEDIA' });
    assert.equal(f.calls.length, 2);
  }
});

test('CAD original download rejects files exceeding the existing document size limit', async () => {
  const f = setup({ metadataPatch: { file_size: MAX_MEDIA_BYTES + 1 } });
  await assert.rejects(f.service.downloadMedia('12345', { purpose: 'attachment' }), { code: 'ERR_WHATSAPP_MEDIA' });
  assert.equal(f.calls.length, 1);
});
