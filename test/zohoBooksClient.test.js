'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createZohoBooksClient,
  ZohoBooksError,
  normalizeDate,
  sanitizeErrorMessage,
} = require('../src/services/books/zohoBooksClient');

function createMockHttp() {
  const calls = [];
  const handlers = {
    get: async () => ({ status: 200, data: {} }),
    post: async () => ({ status: 200, data: {} }),
  };

  const http = {
    calls,
    get: async (url, options) => {
      calls.push({ method: 'GET', url, options });
      return handlers.get(url, options);
    },
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
  clientId: 'books_client_id_123',
  clientSecret: 'books_secret_456',
  refreshToken: 'books_refresh_789',
  organizationId: 'books_org_999',
  accountsUrl: 'https://accounts.zoho.com',
  baseUrl: 'https://www.zohoapis.com/books/v3',
};

test('1. Books credentials/config are read correctly and missing config throws ZohoBooksError', () => {
  const client = createZohoBooksClient({
    ...mockConfig,
  });
  assert.doesNotThrow(() => client.validateCredentials({ organizationId: mockConfig.organizationId }));

  const invalidClient = createZohoBooksClient({
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    organizationId: '',
  });
  assert.throws(
    () => invalidClient.validateCredentials(),
    (err) => err instanceof ZohoBooksError && err.code === 'ZOHO_BOOKS_CONFIG_ERROR'
  );
});

test('2. Access token is requested using the Books refresh token', async () => {
  const http = createMockHttp();
  http.setHandler('post', async (url, body) => {
    if (url.includes('/oauth/v2/token')) {
      assert.ok(body.includes('grant_type=refresh_token'));
      assert.ok(body.includes('client_id=books_client_id_123'));
      assert.ok(body.includes('client_secret=books_secret_456'));
      assert.ok(body.includes('refresh_token=books_refresh_789'));
      return {
        status: 200,
        data: { access_token: 'books_access_token_abc', expires_in: 3600 },
      };
    }
    return { status: 200, data: {} };
  });

  const client = createZohoBooksClient({ ...mockConfig, http });
  const token = await client.getAccessToken();

  assert.strictEqual(token, 'books_access_token_abc');
  assert.strictEqual(http.calls.length, 1);
  assert.strictEqual(http.calls[0].method, 'POST');
  assert.ok(http.calls[0].url.includes('https://accounts.zoho.com/oauth/v2/token'));
});

test('3. Access token is cached and does not make duplicate requests', async () => {
  const http = createMockHttp();
  let refreshCount = 0;
  http.setHandler('post', async (url) => {
    if (url.includes('/oauth/v2/token')) {
      refreshCount++;
      return {
        status: 200,
        data: { access_token: 'cached_token_123', expires_in: 3600 },
      };
    }
    return { status: 200, data: {} };
  });

  const client = createZohoBooksClient({ ...mockConfig, http });

  const token1 = await client.getAccessToken();
  const token2 = await client.getAccessToken();

  assert.strictEqual(token1, 'cached_token_123');
  assert.strictEqual(token2, 'cached_token_123');
  assert.strictEqual(refreshCount, 1);
});

test('4. Expired token causes refresh', async () => {
  const http = createMockHttp();
  let refreshCount = 0;
  http.setHandler('post', async () => {
    refreshCount++;
    return {
      status: 200,
      data: { access_token: `token_v${refreshCount}`, expires_in: 3600 },
    };
  });

  const client = createZohoBooksClient({ ...mockConfig, http });

  const token1 = await client.getAccessToken();
  assert.strictEqual(token1, 'token_v1');

  // Invalidate to simulate expiry
  client.invalidateToken();

  const token2 = await client.getAccessToken();
  assert.strictEqual(token2, 'token_v2');
  assert.strictEqual(refreshCount, 2);
});

test('5. Authentication failure (401 / expired token) causes exactly one token refresh and retry', async () => {
  const http = createMockHttp();
  let tokenCalls = 0;
  let vendorCalls = 0;

  http.setHandler('post', async (url) => {
    if (url.includes('/oauth/v2/token')) {
      tokenCalls++;
      return {
        status: 200,
        data: { access_token: `token_attempt_${tokenCalls}`, expires_in: 3600 },
      };
    }
    return { status: 200, data: {} };
  });

  http.setHandler('get', async (url, options) => {
    vendorCalls++;
    const authHeader = options.headers.Authorization;
    if (authHeader === 'Zoho-oauthtoken token_attempt_1') {
      const err = new Error('Token expired');
      err.response = { status: 401, data: { code: 57, message: 'Invalid OAuth token' } };
      throw err;
    }
    return {
      status: 200,
      data: {
        contacts: [{ contact_id: 'v_123', contact_name: 'Success Vendor' }],
      },
    };
  });

  const client = createZohoBooksClient({ ...mockConfig, http });
  const vendors = await client.searchVendor({ organizationId: mockConfig.organizationId, name: 'Success' });

  assert.strictEqual(tokenCalls, 2);
  assert.strictEqual(vendorCalls, 2);
  assert.strictEqual(vendors.length, 1);
  assert.strictEqual(vendors[0].name, 'Success Vendor');
});

test('6. searchVendor() lists all organization vendors without narrowing the provider search', async () => {
  const http = createMockHttp();
  http.setHandler('post', async () => ({
    status: 200,
    data: { access_token: 'valid_token', expires_in: 3600 },
  }));
  http.setHandler('get', async (url, options) => {
    assert.ok(url.endsWith('/contacts'));
    assert.strictEqual(options.params.organization_id, 'books_org_999');
    assert.strictEqual(options.params.contact_type, 'vendor');
    assert.strictEqual(options.params.search_text, undefined);
    assert.strictEqual(options.params.filter_by, 'Status.All');
    assert.strictEqual(options.params.page, 1);
    assert.strictEqual(options.params.per_page, 200);
    assert.strictEqual(options.headers.Authorization, 'Zoho-oauthtoken valid_token');

    return {
      status: 200,
      data: {
        contacts: [
          {
            contact_id: 'c_9988',
            contact_name: 'Gulf Supplies LLC',
            company_name: 'Gulf Supplies LLC',
            email: 'info@gulfsupplies.ae',
            phone: '+97141234567',
            tax_registration_number: '100123456700003',
          },
        ],
      },
    };
  });

  const client = createZohoBooksClient({ ...mockConfig, http });
  const result = await client.searchVendor({ organizationId: mockConfig.organizationId, searchText: 'Gulf Supplies' });

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 'c_9988');
  assert.strictEqual(result[0].name, 'Gulf Supplies LLC');
  assert.strictEqual(result[0].email, 'info@gulfsupplies.ae');
  assert.strictEqual(result[0].trn, '100123456700003');
});

test('7. searchVendor() returns empty array when none found and does NOT create vendors', async () => {
  const http = createMockHttp();
  http.setHandler('post', async () => ({
    status: 200,
    data: { access_token: 'valid_token', expires_in: 3600 },
  }));
  http.setHandler('get', async () => ({
    status: 200,
    data: { contacts: [] },
  }));

  const client = createZohoBooksClient({ ...mockConfig, http });
  const result = await client.searchVendor({ organizationId: mockConfig.organizationId, name: 'Non Existent Vendor' });

  assert.deepStrictEqual(result, []);
  // Ensure NO post request to /contacts was made
  const postContactsCalls = http.calls.filter(c => c.method === 'POST' && c.url.includes('/contacts'));
  assert.strictEqual(postContactsCalls.length, 0);
});

test('vendor lookup scans later pages, includes inactive contacts, and keeps the selected organization', async () => {
  const http = createMockHttp();
  http.setHandler('post', async () => ({ data: { access_token: 'fixture-token' } }));
  http.setHandler('get', async (_url, options) => {
    assert.equal(options.params.organization_id, '828765858');
    assert.equal(options.params.contact_type, 'vendor');
    assert.equal(options.params.filter_by, 'Status.All');
    return options.params.page === 1
      ? { data: { code: 0, contacts: [{ contact_id: 'other', contact_name: 'Other Vendor', contact_type: 'vendor', status: 'active' }], page_context: { has_more_page: true } } }
      : { data: { code: 0, contacts: [{ contact_id: 'meitech', contact_name: 'Meitech International FZC', contact_type: 'vendor', status: 'active', organization_id: '828765858' }, { contact_id: 'inactive', contact_name: 'Inactive Vendor', contact_type: 'vendor', status: 'inactive' }], page_context: { has_more_page: false } } };
  });
  const client = createZohoBooksClient({ ...mockConfig, http });
  const vendors = await client.searchVendor({ name: 'Meitech International FZC', organizationId: '828765858' });
  assert.deepEqual(vendors.map(vendor => vendor.id), ['other', 'meitech', 'inactive']);
  assert.equal(vendors[1].organizationId, '828765858');
  assert.deepEqual(http.calls.filter(call => call.method === 'GET').map(call => call.options.params.page), [1, 2]);
});

test('incomplete vendor pagination fails closed before a vendor can be created', async () => {
  const http = createMockHttp();
  http.setHandler('post', async () => ({ data: { access_token: 'fixture-token' } }));
  http.setHandler('get', async () => ({ data: { code: 0, contacts: [], page_context: { has_more_page: true } } }));
  const client = createZohoBooksClient({ ...mockConfig, http });
  await assert.rejects(client.searchVendor({ name: 'Missing', organizationId: '828765858' }), /vendor lookup could not be completed safely/i);
  assert.equal(http.calls.filter(call => call.method === 'GET').length, 100);
  assert.equal(http.calls.some(call => call.method === 'POST' && call.url.endsWith('/contacts')), false);
});

test('createVendor posts only a vendor to the selected organization and requires a confirmed ID', async () => {
  const http = createMockHttp();
  http.setHandler('post', async (url, payload, options) => {
    if (url.endsWith('/oauth/v2/token')) return { data: { access_token: 'fixture-token' } };
    assert.ok(url.endsWith('/contacts'));
    assert.equal(options.params.organization_id, '802911060');
    assert.deepEqual(payload, { contact_name: 'New Vendor LLC', contact_type: 'vendor' });
    return { data: { code: 0, contact: { contact_id: 'new-vendor', contact_name: 'New Vendor LLC', contact_type: 'vendor' } } };
  });
  const client = createZohoBooksClient({ ...mockConfig, http });
  assert.equal((await client.createVendor({ name: 'New Vendor LLC', organizationId: '802911060' })).id, 'new-vendor');
  await assert.rejects(client.createVendor({ name: '', organizationId: '802911060' }), error => error.code === 'INVALID_INPUT');
});

test('7a. searchCustomer() reads Zoho Books customers without creating contacts', async () => {
  const http = createMockHttp();
  http.setHandler('post', async () => ({ status: 200, data: { access_token: 'valid_token', expires_in: 3600 } }));
  http.setHandler('get', async (url, options) => {
    assert.ok(url.endsWith('/contacts'));
    assert.equal(options.params.organization_id, 'books_org_999');
    assert.equal(options.params.contact_type, 'customer');
    assert.equal(options.params.page, 1);
    assert.equal(options.params.per_page, 200);
    assert.equal(options.params.search_text, 'Gulf');
    return { status: 200, data: { code: 0, contacts: [{ contact_id: 'cust-1', contact_name: 'Gulf Client', phone: '+971501112233' }] } };
  });
  const client = createZohoBooksClient({ ...mockConfig, http });
  assert.deepEqual(await client.searchCustomer({ organizationId: mockConfig.organizationId, searchText: 'Gulf' }), [{
    contactId: 'cust-1', contactName: 'Gulf Client', companyName: null, email: null,
    phone: '+971501112233', mobile: null, contactType: null, status: null,
    displayName: 'Gulf Client', id: 'cust-1', name: 'Gulf Client',
    raw: { contact_id: 'cust-1', contact_name: 'Gulf Client', phone: '+971501112233' },
  }]);
  assert.equal(http.calls.filter(call => call.method === 'POST' && call.url.includes('/contacts')).length, 0);
});

test('7b. customer lookup paginates and individual lookup preserves the authoritative record', async () => {
  const http = createMockHttp();
  http.setHandler('post', async () => ({ status: 200, data: { access_token: 'valid_token', expires_in: 3600 } }));
  http.setHandler('get', async (url, options) => {
    assert.equal(options.params.organization_id, 'books_org_999');
    if (url.endsWith('/contacts')) {
      const contacts = options.params.page === 1
        ? [{ contact_id: 'cust-1', contact_name: 'Contact One', company_name: 'Company One', phone: '+971500000001', mobile: '+971550000001', email: 'one@example.invalid', contact_type: 'customer', status: 'active' }]
        : [{ contact_id: 'cust-3', contact_name: 'Contact Three', company_name: 'Company Three', email: 'three@example.invalid', contact_type: 'customer', status: 'active' }];
      return { status: 200, data: { code: 0, contacts, page_context: { has_more_page: options.params.page === 1 } } };
    }
    assert.ok(url.endsWith('/contacts/cust-3'));
    return { status: 200, data: { code: 0, contact: { contact_id: 'cust-3', contact_name: 'Contact Three', company_name: 'Company Three', email: 'three@example.invalid', mobile: '+971550000003', contact_type: 'customer', status: 'active' } } };
  });
  const client = createZohoBooksClient({ ...mockConfig, http });
  const customers = await client.searchCustomer({ organizationId: mockConfig.organizationId });
  assert.deepEqual(customers.map(customer => customer.contactId), ['cust-1', 'cust-3']);
  assert.equal(customers[0].companyName, 'Company One');
  assert.equal(customers[0].contactName, 'Contact One');
  assert.equal(customers[0].phone, '+971500000001');
  assert.equal(customers[0].mobile, '+971550000001');
  assert.equal(customers[0].name, 'Company One (Contact One)');
  const selected = await client.getCustomer('cust-3', { organizationId: mockConfig.organizationId });
  assert.equal(selected.contactId, 'cust-3');
  assert.equal(selected.companyName, 'Company Three');
  assert.equal(selected.contactName, 'Contact Three');
  assert.equal(selected.mobile, '+971550000003');
  assert.ok(http.calls.some(call => call.method === 'GET' && call.url.endsWith('/contacts/cust-3')));
});

test('8. checkDuplicateBill() sends expected bill search request and filters exact bill number', async () => {
  const http = createMockHttp();
  http.setHandler('post', async () => ({
    status: 200,
    data: { access_token: 'valid_token', expires_in: 3600 },
  }));
  http.setHandler('get', async (url, options) => {
    assert.ok(url.endsWith('/bills'));
    assert.strictEqual(options.params.organization_id, 'books_org_999');
    assert.strictEqual(options.params.search_text, 'INV-8899');

    return {
      status: 200,
      data: {
        code: 0,
        bills: [
          {
            bill_id: 'b_101',
            bill_number: 'INV-8899',
            vendor_id: 'v_456',
            vendor_name: 'Delta Corp',
            total: 550,
            date: '2026-03-10',
          },
          {
            bill_id: 'b_102',
            bill_number: 'INV-8899-OTHER', // partial match returned by search_text
            vendor_id: 'v_789',
            total: 200,
          },
        ],
      },
    };
  });

  const client = createZohoBooksClient({ ...mockConfig, http });

  // Exact match found
  const dupCheck = await client.checkDuplicateBill({ organizationId: mockConfig.organizationId, billNumber: 'INV-8899', vendorId: 'v_456' });
  assert.strictEqual(dupCheck.found, true);
  assert.strictEqual(dupCheck.bills.length, 1);
  assert.strictEqual(dupCheck.bills[0].id, 'b_101');
  assert.strictEqual(dupCheck.bills[0].billNumber, 'INV-8899');

  // Vendor mismatch returns not duplicate for that vendor
  const vendorMismatch = await client.checkDuplicateBill({ organizationId: mockConfig.organizationId, billNumber: 'INV-8899', vendorId: 'v_different' });
  assert.strictEqual(vendorMismatch.found, false);
});

test('9. createBill() sends the expected payload to Zoho Books', async () => {
  const http = createMockHttp();
  http.setHandler('post', async (url, data, options) => {
    if (url.includes('/oauth/v2/token')) {
      return { status: 200, data: { access_token: 'valid_token', expires_in: 3600 } };
    }
    if (url.endsWith('/bills')) {
      assert.strictEqual(options.params.organization_id, 'books_org_999');
      assert.strictEqual(data.vendor_id, 'v_777');
      assert.strictEqual(data.bill_number, 'BILL-1234');
      assert.strictEqual(data.date, '2026-03-15');
      assert.strictEqual(data.due_date, '2026-04-15');
      assert.strictEqual(data.currency_id, 'currency-aed');
      assert.strictEqual(data.line_items.length, 1);
      assert.strictEqual(data.line_items[0].description, 'LED Lights');
      assert.strictEqual(data.line_items[0].rate, 50);
      assert.strictEqual(data.line_items[0].quantity, 10);
      assert.strictEqual(data.notes, 'Payment terms: Net 30\nPayment method: Cheque');

      return {
        status: 201,
        data: {
          code: 0,
          message: 'The bill has been created.',
          bill: {
            bill_id: 'zb_new_999',
            bill_number: 'BILL-1234',
            status: 'open',
            total: 500,
            vendor_id: 'v_777',
            vendor_name: 'Light World',
            date: '2026-03-15',
            due_date: '2026-04-15',
          },
        },
      };
    }
    return { status: 200, data: {} };
  });

  const client = createZohoBooksClient({ ...mockConfig, http });
  const created = await client.createBill({ organizationId: mockConfig.organizationId,
    vendorId: 'v_777',
    billNumber: 'BILL-1234',
    billDate: '2026-03-15',
    dueDate: '2026-04-15',
    currency: 'AED',
    currencyId: 'currency-aed',
    paymentType: 'Cheque',
    notes: 'Payment terms: Net 30',
    lineItems: [
      {
        name: 'LED Lights',
        description: 'LED Lights',
        rate: 50,
        quantity: 10,
        amount: 500,
      },
    ],
  });

  assert.ok(created);
  assert.strictEqual(created.id, 'zb_new_999');
  assert.strictEqual(created.billNumber, 'BILL-1234');
  assert.strictEqual(created.total, 500);
});

test('9a. createBill() forwards the selected Zoho contact_id as customer_id', async () => {
  const http = createMockHttp();
  http.setHandler('post', async (url, data) => {
    if (url.includes('/oauth/v2/token')) return { status: 200, data: { access_token: 'valid_token', expires_in: 3600 } };
    assert.equal(url.endsWith('/bills'), true);
    assert.equal(data.customer_id, 'cust-789');
    return { status: 201, data: { code: 0, bill: { bill_id: 'bill-with-customer-id' } } };
  });
  const client = createZohoBooksClient({ ...mockConfig, http });
  const created = await client.createBill({ organizationId: mockConfig.organizationId,
    vendorId: 'v-1', billNumber: 'INV-1', billDate: '2026-03-15', customerId: 'cust-789',
    lineItems: [{ name: 'Cable', quantity: 1, rate: 10 }],
  });
  assert.equal(created.id, 'bill-with-customer-id');
});

test('10. createBill() uses YYYY-MM-DD dates and normalizes variations', async () => {
  assert.strictEqual(normalizeDate('2026-03-15'), '2026-03-15');
  assert.strictEqual(normalizeDate('15/03/2026'), '2026-03-15');
  assert.strictEqual(normalizeDate('15-03-2026'), '2026-03-15');

  const http = createMockHttp();
  http.setHandler('post', async (url, data) => {
    if (url.includes('/oauth/v2/token')) {
      return { status: 200, data: { access_token: 'valid_token', expires_in: 3600 } };
    }
    if (url.endsWith('/bills')) {
      assert.strictEqual(data.date, '2026-03-15');
      assert.strictEqual(data.due_date, '2026-03-25');
      return { status: 200, data: { code: 0, bill: { bill_id: 'zb_date_ok' } } };
    }
    return { status: 200, data: {} };
  });

  const client = createZohoBooksClient({ ...mockConfig, http });
  const created = await client.createBill({ organizationId: mockConfig.organizationId,
    vendorId: 'v_123',
    billNumber: 'INV-1',
    billDate: '15/03/2026',
    dueDate: '25/03/2026',
    lineItems: [{ name: 'Cable', quantity: 1, rate: 100 }],
  });

  assert.strictEqual(created.id, 'zb_date_ok');
});

test('11. createBill() requires vendor ID and bill number', async () => {
  const client = createZohoBooksClient({ ...mockConfig });

  await assert.rejects(
    async () => {
      await client.createBill({ organizationId: mockConfig.organizationId,
        vendorId: '',
        billNumber: 'INV-1',
        billDate: '2026-03-15',
      });
    },
    (err) => err instanceof ZohoBooksError && err.code === 'INVALID_INPUT'
  );

  await assert.rejects(
    async () => {
      await client.createBill({ organizationId: mockConfig.organizationId,
        vendorId: 'v_123',
        billNumber: '',
        billDate: '2026-03-15',
      });
    },
    (err) => err instanceof ZohoBooksError && err.code === 'INVALID_INPUT'
  );
});

test('12. attachBillFile() sends multipart attachment data correctly', async () => {
  const http = createMockHttp();
  http.setHandler('post', async (url, data, options) => {
    if (url.includes('/oauth/v2/token')) {
      return { status: 200, data: { access_token: 'valid_token', expires_in: 3600 } };
    }
    if (url.includes('/bills/zb_bill_123/attachment')) {
      assert.strictEqual(options.params.organization_id, 'books_org_999');
      assert.ok(data instanceof globalThis.FormData);
      assert.ok(data.has('attachment'));
      return {
        status: 200,
        data: {
          code: 0,
          message: 'The file has been attached.',
          attachment_id: 'att_98765',
        },
      };
    }
    return { status: 200, data: {} };
  });

  const client = createZohoBooksClient({ ...mockConfig, http });
  const fileBuffer = Buffer.from('%PDF-1.5 test invoice content');

  const result = await client.attachBillFile({ organizationId: mockConfig.organizationId,
    billId: 'zb_bill_123',
    buffer: fileBuffer,
    filename: 'invoice.pdf',
    mimeType: 'application/pdf',
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.attachmentId, 'att_98765');
});

test('13. API errors are surfaced safely with HTTP status and operation name', async () => {
  const http = createMockHttp();
  http.setHandler('post', async (url) => {
    if (url.includes('/oauth/v2/token')) {
      return { status: 200, data: { access_token: 'valid_token', expires_in: 3600 } };
    }
    if (url.endsWith('/bills')) {
      const err = new Error('Request failed');
      err.response = {
        status: 400,
        data: {
          code: 36004,
          message: 'Please enter a valid bill number.',
        },
      };
      throw err;
    }
    return { status: 200, data: {} };
  });

  const client = createZohoBooksClient({ ...mockConfig, http });

  await assert.rejects(
    async () => {
      await client.createBill({ organizationId: mockConfig.organizationId,
        vendorId: 'v_123',
        billNumber: 'INVALID_NUM',
        billDate: '2026-03-15',
        lineItems: [{ name: 'Cable', quantity: 1, rate: 100 }],
      });
    },
    (err) => {
      assert.ok(err instanceof ZohoBooksError);
      assert.strictEqual(err.code, 'ZOHO_BOOKS_API_ERROR');
      assert.strictEqual(err.httpStatus, 400);
      assert.strictEqual(err.providerCode, 36004);
      assert.strictEqual(err.operation, 'createBill');
      assert.ok(err.message.includes('Please enter a valid bill number.'));
      return true;
    }
  );
});

test('14. Secrets/tokens are not included in error messages', () => {
  const secret1 = 'books_secret_456';
  const secret2 = 'books_refresh_789';
  const rawError = `Authentication failed for client_secret ${secret1} and refresh_token ${secret2}`;

  const sanitized = sanitizeErrorMessage(rawError, [secret1, secret2]);
  assert.strictEqual(sanitized.includes(secret1), false);
  assert.strictEqual(sanitized.includes(secret2), false);
  assert.ok(sanitized.includes('[REDACTED]'));
});

test('15. CRM OAuth code remains untouched and separate', () => {
  const { createZohoAuthService } = require('../src/services/zoho/zohoAuthService');
  assert.strictEqual(typeof createZohoAuthService, 'function');

  // Verify that zohoBooksClient does NOT export or wrap CRM auth
  const booksModule = require('../src/services/books/zohoBooksClient');
  assert.strictEqual(typeof booksModule.createZohoBooksClient, 'function');
  assert.strictEqual(booksModule.createZohoAuthService, undefined);
  assert.strictEqual(booksModule.createZohoLeadService, undefined);
});
