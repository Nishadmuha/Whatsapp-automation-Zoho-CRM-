'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createZohoBooksAuthService,
  ZohoBooksAuthError,
  redactSecrets,
} = require('../src/services/books/zohoBooksAuthService');

function createMockHttp() {
  const calls = [];
  const handlers = {
    post: async () => ({ status: 200, data: {} }),
  };

  const http = {
    calls,
    post: async (url, data, options) => {
      calls.push({ method: 'POST', url, data, options });
      return handlers.post(url, data, options);
    },
    setHandler: (method, fn) => {
      handlers[method.toLowerCase()] = fn;
    },
  };

  return http;
}

const mockConfig = {
  clientId: 'test_client_id_1000',
  clientSecret: 'test_client_secret_xyz',
  refreshToken: '1000.refresh.token.mock',
  accessToken: '1000.access.token.mock',
  accountsUrl: 'https://accounts.zoho.com',
};

test('1. redactSecrets strips sensitive values from strings', () => {
  const text = 'Failed with secret test_client_secret_xyz and token 1000.refresh.token.mock';
  const cleaned = redactSecrets(text, ['test_client_secret_xyz', '1000.refresh.token.mock']);
  assert.ok(!cleaned.includes('test_client_secret_xyz'));
  assert.ok(!cleaned.includes('1000.refresh.token.mock'));
  assert.ok(cleaned.includes('[REDACTED]'));
});

test('2. exchangeAuthorizationCode validates inputs and calls /oauth/v2/token', async () => {
  const mockHttp = createMockHttp();
  mockHttp.setHandler('post', async () => ({
    status: 200,
    data: {
      access_token: 'new_mock_access_token',
      refresh_token: 'new_mock_refresh_token',
      expires_in: 3600,
      api_domain: 'https://www.zohoapis.com',
      token_type: 'Bearer',
    },
  }));

  const authService = createZohoBooksAuthService({
    ...mockConfig,
    http: mockHttp,
  });

  const result = await authService.exchangeAuthorizationCode({
    code: '1000.mock_auth_code_123',
  });

  assert.strictEqual(result.accessToken, 'new_mock_access_token');
  assert.strictEqual(result.refreshToken, 'new_mock_refresh_token');
  assert.strictEqual(result.expiresIn, 3600);
  assert.strictEqual(result.apiDomain, 'https://www.zohoapis.com');

  assert.strictEqual(mockHttp.calls.length, 1);
  const call = mockHttp.calls[0];
  assert.strictEqual(call.url, 'https://accounts.zoho.com/oauth/v2/token');
  assert.ok(call.data.includes('grant_type=authorization_code'));
  assert.ok(call.data.includes('code=1000.mock_auth_code_123'));
});

test('3. exchangeAuthorizationCode throws ZohoBooksAuthError on Zoho error response', async () => {
  const mockHttp = createMockHttp();
  mockHttp.setHandler('post', async () => ({
    status: 200,
    data: {
      error: 'invalid_code',
    },
  }));

  const authService = createZohoBooksAuthService({
    ...mockConfig,
    http: mockHttp,
  });

  await assert.rejects(
    async () => {
      await authService.exchangeAuthorizationCode({
        code: '1000.expired_code_xyz',
      });
    },
    (err) => {
      assert.ok(err instanceof ZohoBooksAuthError);
      assert.strictEqual(err.code, 'CODE_EXCHANGE_REJECTED');
      assert.strictEqual(err.providerError, 'invalid_code');
      assert.ok(!err.message.includes('test_client_secret_xyz'));
      return true;
    }
  );
});

test('4. refreshAccessToken validates credentials and returns new token', async () => {
  const mockHttp = createMockHttp();
  mockHttp.setHandler('post', async () => ({
    status: 200,
    data: {
      access_token: 'refreshed_access_token_abc',
      expires_in: 7200,
      api_domain: 'https://www.zohoapis.com',
    },
  }));

  const authService = createZohoBooksAuthService({
    ...mockConfig,
    http: mockHttp,
  });

  const result = await authService.refreshAccessToken();
  assert.strictEqual(result.accessToken, 'refreshed_access_token_abc');
  assert.strictEqual(result.expiresIn, 7200);

  const call = mockHttp.calls[0];
  assert.ok(call.data.includes('grant_type=refresh_token'));
  assert.ok(call.data.includes('client_id=test_client_id_1000'));
});

test('5. refreshAccessToken redacts secrets on HTTP network failure', async () => {
  const mockHttp = createMockHttp();
  mockHttp.setHandler('post', async () => {
    const error = new Error('Network timeout with secret test_client_secret_xyz');
    error.response = {
      status: 400,
      data: { error: 'invalid_client test_client_secret_xyz' },
    };
    throw error;
  });

  const authService = createZohoBooksAuthService({
    ...mockConfig,
    http: mockHttp,
  });

  await assert.rejects(
    async () => {
      await authService.refreshAccessToken();
    },
    (err) => {
      assert.ok(err instanceof ZohoBooksAuthError);
      assert.strictEqual(err.code, 'TOKEN_REFRESH_HTTP_FAILED');
      assert.strictEqual(err.httpStatus, 400);
      assert.ok(!err.message.includes('test_client_secret_xyz'));
      assert.ok(err.message.includes('[REDACTED]'));
      return true;
    }
  );
});

test('6. getAccessToken deduplicates concurrent refresh requests', async () => {
  let refreshCalls = 0;
  const mockHttp = createMockHttp();
  mockHttp.setHandler('post', async () => {
    refreshCalls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      status: 200,
      data: {
        access_token: 'concurrent_access_token',
        expires_in: 3600,
      },
    };
  });

  const authService = createZohoBooksAuthService({
    ...mockConfig,
    accessToken: null,
    http: mockHttp,
  });

  const [t1, t2] = await Promise.all([
    authService.getAccessToken({ forceRefresh: true }),
    authService.getAccessToken({ forceRefresh: true }),
  ]);

  assert.strictEqual(t1, 'concurrent_access_token');
  assert.strictEqual(t2, 'concurrent_access_token');
  assert.strictEqual(refreshCalls, 1);
});
