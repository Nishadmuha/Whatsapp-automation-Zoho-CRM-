'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { renderAdminPage } = require('../src/views/adminPage');
const { test } = require('node:test');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.value = '';
    this.hidden = false;
    this._text = '';
    this.attributes = {};
    this.style = {};
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }
  set innerHTML(_value) {
    throw new Error('HTML injection sink is forbidden');
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this._text = '';
    this.children = children;
  }
  addEventListener(event, handler) {
    this.listeners.set(event, handler);
  }
  dispatch(event) {
    return this.listeners.get(event)?.({ preventDefault() {} });
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  get classList() {
    return {
      add: (...cls) => {
        const current = (this.attributes['class'] || '').split(' ').filter(Boolean);
        for (const c of cls) if (!current.includes(c)) current.push(c);
        this.attributes['class'] = current.join(' ');
      },
      remove: (...cls) => {
        const current = (this.attributes['class'] || '').split(' ').filter(Boolean);
        this.attributes['class'] = current.filter(c => !cls.includes(c)).join(' ');
      },
      contains: (c) => (this.attributes['class'] || '').split(' ').includes(c),
    };
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  querySelectorAll(selector) {
    const results = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matchesSelector && child.matchesSelector(selector)) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }
  matchesSelector(selector) {
    if (!selector) return false;
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.attributes.id === selector.slice(1);
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}

function response(data, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return data;
    },
  };
}

async function booksDashboard(fetch, { authenticated = false, loginStatus = 200, search = '' } = {}) {
  const [html, script] = await Promise.all(
    ['books.html', 'books.js'].map((file) =>
      file.endsWith('.html') ? renderAdminPage('books') : fs.readFile(path.resolve(__dirname, '../src/admin', file), 'utf8')
    )
  );

  const elements = new Map(
    [...html.matchAll(/id="([^"]+)"/g)].map((match) => {
      const el = new Element();
      el.attributes.id = match[1];
      return [match[1], el];
    })
  );
  if (elements.has('workspace')) elements.get('workspace').hidden = true;
  if (elements.has('page-size')) elements.get('page-size').value = '20';

  const tags = [];
  const document = {
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement(tag) {
      tags.push(tag);
      return new Element(tag);
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const results = [];
      for (const el of elements.values()) {
        if (el.matchesSelector(selector)) results.push(el);
        results.push(...el.querySelectorAll(selector));
      }
      return results;
    },
    hidden: false,
  };

  Object.defineProperty(document, 'cookie', {
    get() {
      throw new Error('Cookie access is forbidden');
    },
    set() {
      throw new Error('Cookie storage is forbidden');
    },
  });

  const window = new Element();
  window.location = { search };
  const requests = [];

  const context = {
    document,
    window,
    URLSearchParams,
    console,
    setInterval: () => 123,
    clearInterval: () => {},
    async fetch(url, options) {
      requests.push({ url, options });
      if (url === '/api/admin/session') return response({ authenticated });
      if (url === '/api/admin/login') return response({ authenticated: loginStatus === 200 }, loginStatus);
      if (url === '/api/admin/logout') return response({ authenticated: false });
      return fetch(url, options);
    },
  };

  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(context, name, {
      get() {
        throw new Error('Persistent credential storage is forbidden');
      },
    });
  }

  vm.runInNewContext(script, context, { filename: 'admin/books.js' });
  return { el: (id) => elements.get(id), tags, window, requests, html };
}

async function settled() {
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function signIn(h) {
  if (h.el('username')) h.el('username').value = 'synthetic.operator';
  if (h.el('password')) h.el('password').value = 'synthetic-password';
  if (h.el('login-form')) h.el('login-form').dispatch('submit');
}

test('books dashboard: signs in, loads real statistics, displays empty state, renders bill rows, and opens detail dialog without HTML injection', async () => {
  const injected = '<img src=x onerror="globalThis.injected=true">';
  const sampleBill = {
    bill_id: 'b1111111-2222-3333-4444-555555555555',
    vendor_name: 'Safe Cables ' + injected,
    bill_number: 'INV-101',
    bill_date: '2026-09-15',
    due_date: '2026-10-15',
    currency: 'AED',
    total_amount: 2500,
    subtotal: 2380.95,
    tax_amount: 119.05,
    status: 'COMPLETED',
    zoho_status: 'SYNCED',
    zoho_bill_id: '460000000012345',
    worker_phone: '+971501112233',
    created_at: '2026-09-15T10:00:00.000Z',
    updated_at: '2026-09-15T10:05:00.000Z',
    line_items: [
      { description: 'Armored Cable ' + injected, quantity: 10, rate: 238, tax: 11.9, amount: 2380 },
    ],
    session: {
      session_id: 's1111111-2222-3333-4444-555555555555',
      state: 'COMPLETED',
      worker_phone: '+971501112233',
      pending_action: 'Bill successfully created in Zoho Books',
    },
    extraction: {
      job_id: 'job-1',
      status: 'COMPLETED',
      model: 'gpt-4o-mini',
      confidence: { overall: 0.98 },
    },
    attachments: [
      { original_filename: 'invoice.pdf', mime_type: 'application/pdf', storage_reference: 'ref-1' },
    ],
  };

  const sampleStats = {
    total: 1,
    processing: 0,
    awaiting_additional_info: 0,
    awaiting_edit: 0,
    awaiting_final_confirmation: 0,
    creating_in_zoho: 0,
    completed: 1,
    cancelled: 0,
    failed: 0,
  };

  const h = await booksDashboard(async (url) => {
    if (url.endsWith('/stats')) {
      return response(sampleStats);
    }
    if (url.includes('?') || url.endsWith('/books')) {
      return response({ items: [sampleBill], total: 1, page: 1, page_size: 20, total_pages: 1 });
    }
    if (url.includes('/' + sampleBill.bill_id)) {
      return response(sampleBill);
    }
    return response({});
  }, { authenticated: true });

  // Verify elements in HTML
  assert.match(h.html, /id="stat-outstanding"/);
  assert.match(h.html, /id="stat-awaiting-approval"/);
  assert.match(h.html, /id="stat-synced-total"/);
  assert.match(h.html, /id="stat-success-rate"/);
  assert.match(h.html, /id="bill-rows"/);
  assert.match(h.html, /id="empty"/);

  // Sign in
  signIn(h);
  await settled();

  assert.equal(h.el('workspace').hidden, false);
  assert.equal(h.el('stat-synced-total').textContent, '1');

  // Verify rendered bill row
  assert.equal(h.el('empty').hidden, true);
  const rows = h.el('bill-rows').children;
  assert.equal(rows.length, 1);
  assert.ok(rows[0].textContent.includes('Safe Cables ' + injected));
  assert.ok(rows[0].textContent.includes('INV-101'));
  assert.ok(rows[0].textContent.includes('COMPLETED'));

  // Open detail dialog
  const openButton = rows[0].children[0];
  openButton.dispatch('click');
  await settled();

  assert.equal(h.el('detail').open, true);
  assert.ok(h.el('detail-title').textContent.includes('INV-101'));
  assert.ok(h.el('af-vendor').value.includes('Safe Cables ' + injected));
  assert.equal(h.el('af-status').textContent, 'COMPLETED');

  // Confirm no unauthorized script or img injection occurred
  assert.equal(h.tags.includes('script'), false);
  assert.equal(globalThis.injected, undefined);
});
