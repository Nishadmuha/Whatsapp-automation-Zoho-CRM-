'use strict';
const { randomBytes } = require('node:crypto');
const { after } = require('node:test');
const mongoose = require('mongoose');
process.env.NODE_ENV = 'test';
const { createMessageStore } = require('../src/database');

if (typeof after === 'function') {
  try {
    after(async () => {
      await mongoose.disconnect().catch(() => {});
    });
  } catch (_err) {
    // ignore
  }
}

const silent = { info() {}, warn() {}, error() {} };

const TEST_MONGO_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';

async function temporaryStore(t) {
  const testDbName = 'test_' + randomBytes(8).toString('hex');
  const baseUri = TEST_MONGO_URI;
  const store = createMessageStore({
    mongoUri: baseUri,
    databaseName: testDbName,
    logger: silent
  });
  await store.init();
  if (t && typeof t.after === 'function') {
    t.after(async () => {
      try {
        if (store.db && /^test_[0-9a-f]{16}$/.test(store.db.databaseName)) {
          await store.db.dropDatabase();
        }
      } catch (_err) {
        // ignore cleanup errors in test teardown
      }
      await store.close();
    });
  }
  let dbUri;
  try {
    const urlObj = new URL(baseUri);
    urlObj.pathname = '/' + testDbName;
    dbUri = urlObj.toString();
  } catch {
    dbUri = `${baseUri.replace(/\/+$/, '')}/${testDbName}`;
  }
  return { store, databaseUrl: dbUri };
}

function testEnv(overrides = {}) {
  const baseUri = TEST_MONGO_URI;
  return {
    NODE_ENV: 'test',
    AUTOMATION_ENABLED: 'false',
    WEBHOOK_VERIFY_TOKEN: randomBytes(32).toString('hex'),
    MONGODB_URI: overrides.MONGODB_URI || `${baseUri.replace(/\/+$/, '')}/test_env`,
    ...overrides,
  };
}

function incoming(overrides = {}) {
  return {
    whatsapp_message_id: 'wamid.test-' + randomBytes(8).toString('hex'),
    sender_phone: '+971551234567',
    message_type: 'text',
    authenticated: true,
    message_text: 'Ahmed from ABC Contracting, 0501234567, needs AC maintenance in Dubai.',
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

function lead(overrides = {}) {
  return {
    name: 'Ahmed',
    phone: '+971501234567',
    email: null,
    company: 'ABC Contracting',
    service: 'AC maintenance',
    location: 'Dubai',
    requirement: 'AC maintenance',
    notes: null,
    ...overrides
  };
}

class ClassList {
  constructor(el) { this.el = el; }
  _classes() {
    const cls = this.el.attributes['class'] || '';
    return cls ? cls.split(/\s+/).filter(Boolean) : [];
  }
  _set(arr) { this.el.attributes['class'] = arr.join(' '); }
  add(...tokens) {
    const set = new Set(this._classes());
    for (const t of tokens) if (t) set.add(t);
    this._set([...set]);
  }
  remove(...tokens) {
    const set = new Set(this._classes());
    for (const t of tokens) set.delete(t);
    this._set([...set]);
  }
  toggle(token, force) {
    const set = new Set(this._classes());
    let has = set.has(token);
    if (force !== undefined) {
      if (force) set.add(token); else set.delete(token);
      has = force;
    } else {
      if (has) set.delete(token); else set.add(token);
      has = !has;
    }
    this._set([...set]);
    return has;
  }
  contains(token) { return this._classes().includes(token); }
  toString() { return this._classes().join(' '); }
}

function matchesSelector(el, selector) {
  if (!selector || !(el instanceof MockElement)) return false;
  const s = selector.trim();
  if (s === '*') return true;
  if (s.startsWith('.')) return el.classList.contains(s.slice(1));
  if (s.startsWith('#')) return el.id === s.slice(1) || el.getAttribute('id') === s.slice(1);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1);
    if (inner.includes('=')) {
      const [k, v] = inner.split('=');
      const cleanV = v.replace(/^["']|["']$/g, '');
      return el.getAttribute(k.trim()) === cleanV;
    }
    return el.hasAttribute(inner.trim());
  }
  return el.tagName.toLowerCase() === s.toLowerCase();
}

function queryAll(root, selector) {
  const results = [];
  function walk(node) {
    for (const child of node.children) {
      if (matchesSelector(child, selector)) results.push(child);
      walk(child);
    }
  }
  walk(root);
  return results;
}

class MockElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.listeners = new Map();
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this._text = '';
    this.attributes = {};
    this.dataset = {};
    this.style = {};
  }
  get id() { return this.attributes['id'] || ''; }
  set id(val) { this.attributes['id'] = String(val); }
  get className() { return this.attributes['class'] || ''; }
  set className(val) { this.attributes['class'] = String(val); }
  get classList() { return new ClassList(this); }
  set textContent(value) {
    this._text = String(value ?? '');
    for (const child of this.children) child.parentElement = null;
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }
  set innerHTML(html) {
    this._text = '';
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    if (!html) return;
    const tagRegex = /<\/?([a-zA-Z0-9_-]+)([^>]*)>|([^<]+)/gs;
    let match;
    let current = this;
    const stack = [current];
    while ((match = tagRegex.exec(html)) !== null) {
      const [full, tagName, attrStr, text] = match;
      if (text) {
        current._text += text;
      } else if (full.startsWith('</')) {
        if (stack.length > 1) {
          stack.pop();
          current = stack[stack.length - 1];
        }
      } else {
        const isSelfClosing = full.endsWith('/>') || ['img', 'input', 'br', 'hr'].includes(tagName.toLowerCase());
        const childEl = new MockElement(tagName.toLowerCase());
        if (attrStr) {
          const attrRegex = /([a-zA-Z0-9_-]+)(?:=["']([^"']*)["'])?/g;
          let am;
          while ((am = attrRegex.exec(attrStr)) !== null) {
            childEl.setAttribute(am[1], am[2] !== undefined ? am[2] : '');
          }
        }
        current.append(childEl);
        if (!isSelfClosing) {
          stack.push(childEl);
          current = childEl;
        }
      }
    }
  }
  get innerHTML() {
    return this.textContent;
  }
  append(...children) {
    for (const child of children) {
      if (child instanceof MockElement) {
        child.parentElement = this;
        child.parentNode = this;
        this.children.push(child);
      }
    }
  }
  appendChild(child) {
    this.append(child);
    return child;
  }
  replaceChildren(...children) {
    this._text = '';
    for (const c of this.children) c.parentElement = null;
    this.children = [];
    this.append(...children);
  }
  addEventListener(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }
  removeEventListener(event, handler) {
    const list = this.listeners.get(event);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
    }
  }
  dispatch(event, eventObj = {}) {
    const list = this.listeners.get(event) || [];
    const ev = {
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
      ...eventObj
    };
    for (const handler of list) {
      handler(ev);
    }
    return true;
  }
  setAttribute(name, value) {
    const strVal = String(value);
    this.attributes[name] = strVal;
    if (name === 'id') this.id = strVal;
    if (name === 'class') this.className = strVal;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = strVal;
    }
  }
  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name === 'id') return this.id;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (key in this.dataset) return this.dataset[key];
    }
    return this.attributes[name] ?? null;
  }
  hasAttribute(name) { return name in this.attributes; }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'id') this.id = '';
    if (name === 'class') this.className = '';
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      delete this.dataset[key];
    }
  }
  querySelector(selector) {
    const all = queryAll(this, selector);
    return all.length > 0 ? all[0] : null;
  }
  querySelectorAll(selector) {
    return queryAll(this, selector);
  }
  closest(selector) {
    let cur = this;
    while (cur) {
      if (matchesSelector(cur, selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  blur() {}
}

function createMockDocument(elements, tags = []) {
  const document = {
    getElementById(id) {
      const assert = require('node:assert/strict');
      assert.ok(elements.has(id), 'Unknown dashboard element: ' + id);
      return elements.get(id);
    },
    createElement(tag) {
      tags.push(tag);
      return new MockElement(tag);
    },
    querySelector(selector) {
      for (const el of elements.values()) {
        if (matchesSelector(el, selector)) return el;
        const found = el.querySelector(selector);
        if (found) return found;
      }
      return null;
    },
    querySelectorAll(selector) {
      const results = [];
      for (const el of elements.values()) {
        if (matchesSelector(el, selector)) results.push(el);
        results.push(...el.querySelectorAll(selector));
      }
      return [...new Set(results)];
    },
    hidden: false,
  };
  Object.defineProperty(document, 'cookie', {
    get() { throw new Error('Cookie access is forbidden'); },
    set() { throw new Error('Cookie storage is forbidden'); }
  });
  return document;
}

module.exports = {
  temporaryStore,
  testEnv,
  incoming,
  lead,
  silent,
  MockElement,
  matchesSelector,
  queryAll,
  createMockDocument,
};
