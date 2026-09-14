'use strict';

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');

const SESSION_COOKIE = 'voltronix_admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;
const SESSION_TOKEN = /^[a-f0-9]{64}$/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
function validApiToken(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 256 && !/[^\x21-\x7e]/.test(value);
}

function validCredential(value, maxLength) {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= maxLength && !CONTROLS.test(value);
}

function credentialHash(username, password) {
  return createHash('sha256').update(username).update('\0').update(password).digest();
}

function sessionCookie(req) {
  const header = req.get('cookie');
  if (typeof header !== 'string' || header.length > 4096) return null;
  let token = null;
  let found = false;
  const parts = header.split(';');
  if (parts.length > 100) return null;
  for (const part of parts) {
    const cookie = part.trim();
    const separator = cookie.indexOf('=');
    if (separator < 1) return null;
    if (cookie.slice(0, separator) !== SESSION_COOKIE) continue;
    if (found) return null;
    found = true;
    token = cookie.slice(separator + 1);
    if (!SESSION_TOKEN.test(token)) return null;
  }
  return token;
}

function requestOrigin(req) {
  const site = req.get('sec-fetch-site');
  if (site !== undefined && !['same-origin', 'none'].includes(site)) return { allowed: false };
  const origin = req.get('origin');
  // Non-browser local tools do not necessarily send Origin or Fetch Metadata.
  if (origin === undefined) return { allowed: true, secure: false };
  if (typeof origin !== 'string' || origin.length > 2048) return { allowed: false };
  try {
    const url = new URL(origin);
    const host = new URL('http://' + req.host);
    if (url.origin !== origin || url.username || url.password || url.host !== host.host
        || !['http:', 'https:'].includes(url.protocol) || (req.secure && url.protocol !== 'https:')) {
      return { allowed: false };
    }
    // The existing ngrok HTTPS endpoint terminates TLS before this HTTP server.
    // A browser HTTPS Origin with the same host is permitted without trusting
    // raw forwarded headers or changing global proxy settings. Its cookie is
    // Secure; a genuinely secure request never accepts a downgraded HTTP Origin.
    return { allowed: true, secure: url.protocol === 'https:' };
  } catch { return { allowed: false }; }
}

function createAdminAccess({ adminUsername, adminPassword, adminApiToken, production = false } = {}, { now = Date.now } = {}) {
  const configured = validCredential(adminUsername, 128) && validCredential(adminPassword, 256);
  const expected = configured ? credentialHash(adminUsername, adminPassword) : null;
  const apiConfigured = validApiToken(adminApiToken);
  const expectedApiToken = apiConfigured ? createHash('sha256').update(adminApiToken).digest() : null;
  const sessions = new Map();
  const router = express.Router();
  const unavailable = res => res.status(503).json({ success: false, message: 'Internal leads access is unavailable' });
  const unauthorized = res => res.status(401).json({ success: false, message: 'Authentication required' });

  function prune() {
    const timestamp = now();
    for (const [token, expiresAt] of sessions) if (expiresAt <= timestamp) sessions.delete(token);
  }

  function authenticated(req) {
    prune();
    const token = sessionCookie(req);
    return configured && token !== null && sessions.has(token);
  }

  function requireAuth(req, res, next) {
    if (!configured && !apiConfigured) return unavailable(res);
    if (!authenticated(req) && !authenticatedApiToken(req)) return unauthorized(res);
    return next();
  }

  function authenticatedApiToken(req) {
    if (!apiConfigured) return false;
    const header = req.get('authorization');
    if (typeof header !== 'string' || header.length > 263) return false;
    // Node can discard repeated Authorization headers. Reject an ambiguous
    // credential envelope before checking the one exposed by Express.
    let count = 0;
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index].toLowerCase() === 'authorization') count++;
    }
    if (count !== 1 || !/^Bearer /i.test(header)) return false;
    const token = header.slice(7);
    if (!validApiToken(token)) return false;
    return timingSafeEqual(createHash('sha256').update(token).digest(), expectedApiToken);
  }

  function sameOrigin(req, res, next) {
    const origin = requestOrigin(req);
    if (!origin.allowed) return res.status(403).json({ success: false, message: 'Request origin is not allowed' });
    res.locals.adminSecureOrigin = origin.secure;
    return next();
  }

  function cookieOptions(req, res) {
    return { httpOnly: true, sameSite: 'strict', path: '/api',
      secure: Boolean(production || req.secure || res.locals.adminSecureOrigin) };
  }

  router.use((_req, res, next) => {
    prune();
    res.set('Cache-Control', 'no-store');
    next();
  });
  const loginLimiter = rateLimit({
    windowMs: 60_000, limit: 10, skipSuccessfulRequests: true,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { success: false, message: 'Too many login attempts. Please try again later.' },
  });
  router.post('/login', loginLimiter, sameOrigin, (req, res) => {
    if (!configured) return unavailable(res);
    if (!req.is('application/json')) return res.status(415).json({ success: false, message: 'Use application/json' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2
        || !Object.hasOwn(body, 'username') || !Object.hasOwn(body, 'password')
        || !validCredential(body.username, 128) || !validCredential(body.password, 256)) {
      return res.status(400).json({ success: false, message: 'Invalid login request' });
    }
    // Hash both supplied credentials together and perform one fixed-length
    // comparison, so a wrong username has the same path as a wrong password.
    if (!timingSafeEqual(credentialHash(body.username, body.password), expected)) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
    const previous = sessionCookie(req);
    if (previous) sessions.delete(previous);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, now() + SESSION_TTL_MS);
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req, res), maxAge: SESSION_TTL_MS });
    return res.json({ authenticated: true, username: adminUsername });
  });
  router.get('/session', (req, res) => res.json(authenticated(req)
    ? { authenticated: true, username: adminUsername } : { authenticated: false }));
  router.post('/logout', sameOrigin, (req, res) => {
    const token = sessionCookie(req);
    if (token) sessions.delete(token);
    res.clearCookie(SESSION_COOKIE, cookieOptions(req, res));
    return res.json({ authenticated: false });
  });

  return { requireAuth, router };
}

module.exports = { createAdminAccess, SESSION_COOKIE, SESSION_TTL_MS };
