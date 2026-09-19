'use strict';

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { userService } = require('../services/auth/userService');

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
  return createHash('sha256').update(String(username)).update('\0').update(String(password)).digest();
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
  if (origin === undefined) return { allowed: true, secure: false };
  if (typeof origin !== 'string' || origin.length > 2048) return { allowed: false };
  try {
    const url = new URL(origin);
    const host = new URL('http://' + req.host);
    if (url.origin !== origin || url.username || url.password || url.host !== host.host
        || !['http:', 'https:'].includes(url.protocol) || (req.secure && url.protocol !== 'https:')) {
      return { allowed: false };
    }
    return { allowed: true, secure: url.protocol === 'https:' };
  } catch { return { allowed: false }; }
}

function createAdminAccess({
  adminUsername,
  adminPassword,
  adminApiToken,
  booksUsername,
  booksPassword,
  adminBooksAccess = true,
  production = false,
  cookiePath = '/api',
} = {}, { now = Date.now } = {}) {
  const adminConfigured = validCredential(adminUsername, 128) && validCredential(adminPassword, 256);
  const expectedAdmin = adminConfigured ? credentialHash(adminUsername, adminPassword) : null;

  const booksConfigured = validCredential(booksUsername, 128) && validCredential(booksPassword, 256);
  const expectedBooks = booksConfigured ? credentialHash(booksUsername, booksPassword) : null;

  const configured = adminConfigured || booksConfigured;

  const apiConfigured = validApiToken(adminApiToken);
  const expectedApiToken = apiConfigured ? createHash('sha256').update(adminApiToken).digest() : null;

  const sessions = new Map();
  const router = express.Router();
  const unavailable = res => res.status(503).json({ success: false, message: 'Internal access is unavailable' });
  const unauthorized = res => res.status(401).json({ success: false, message: 'Authentication required' });

  function prune() {
    const timestamp = now();
    for (const [token, data] of sessions) {
      const exp = typeof data === 'object' && data !== null ? data.expiresAt : data;
      if (exp <= timestamp) sessions.delete(token);
    }
  }

  function getSession(req) {
    prune();
    const token = sessionCookie(req);
    if (!token || !sessions.has(token)) return null;
    const sess = sessions.get(token);
    if (!sess) return null;
    if (typeof sess === 'number') {
      return {
        expiresAt: sess,
        username: adminUsername,
        role: 'admin',
        roles: ['admin', 'books', 'full'],
        access: 'full',
        permittedPages: ['dashboard', 'leads', 'chats', 'bills'],
        isAdmin: true,
      };
    }
    return sess;
  }

  function authenticated(req, requiredRole) {
    const sess = getSession(req);
    if (!sess) return false;
    if (!requiredRole) return true;
    return Array.isArray(sess.roles) && sess.roles.includes(requiredRole);
  }

  function authenticatedApiToken(req) {
    if (!apiConfigured) return false;
    const header = req.get('authorization');
    if (typeof header !== 'string' || header.length > 263) return false;
    let count = 0;
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index].toLowerCase() === 'authorization') count++;
    }
    if (count !== 1 || !/^Bearer /i.test(header)) return false;
    const token = header.slice(7);
    if (!validApiToken(token)) return false;
    return timingSafeEqual(createHash('sha256').update(token).digest(), expectedApiToken);
  }

  function requireAuth(req, res, next) {
    if (!configured && !apiConfigured) return unavailable(res);
    if (authenticatedApiToken(req)) return next();
    if (authenticated(req)) return next();
    return unauthorized(res);
  }

  function requireAdminAuth(req, res, next) {
    if (!adminConfigured && !apiConfigured) return unavailable(res);
    if (authenticatedApiToken(req)) return next();
    const sess = getSession(req);
    if (!sess) return unauthorized(res);
    if (!sess.roles?.includes('admin') && sess.access !== 'full') {
      return res.status(403).json({ success: false, message: 'Administrator access required' });
    }
    return next();
  }

  function requireLeadAuth(req, res, next) {
    if (!adminConfigured && !apiConfigured) return unavailable(res);
    if (authenticatedApiToken(req)) return next();
    const sess = getSession(req);
    if (!sess) return unauthorized(res);
    if (sess.isAdmin || sess.roles?.includes('admin') || sess.roles?.includes('lead') ||
        sess.permittedPages?.includes('leads') || sess.access === 'full') {
      return next();
    }
    return res.status(403).json({ success: false, message: 'Administrator access required' });
  }

  function requireChatAuth(req, res, next) {
    if (!adminConfigured && !apiConfigured) return unavailable(res);
    if (authenticatedApiToken(req)) return next();
    const sess = getSession(req);
    if (!sess) return unauthorized(res);
    if (sess.isAdmin || sess.roles?.includes('admin') || sess.roles?.includes('chat') ||
        sess.permittedPages?.includes('chats') || sess.access === 'full') {
      return next();
    }
    return res.status(403).json({ success: false, message: 'Chat access required' });
  }

  function requireBooksAuth(req, res, next) {
    if (!booksConfigured && !adminConfigured && !apiConfigured) return unavailable(res);
    if (authenticatedApiToken(req)) return next();
    const sess = getSession(req);
    if (!sess) return unauthorized(res);
    if (adminBooksAccess === false && sess.isAdmin && !sess.roles?.includes('books')) {
      return res.status(403).json({ success: false, message: 'Zoho Books authorization required' });
    }
    if (sess.isAdmin || sess.roles?.includes('books') || sess.roles?.includes('admin') ||
        sess.permittedPages?.includes('bills') || sess.access === 'full' || sess.access?.startsWith('billing')) {
      return next();
    }
    return res.status(403).json({ success: false, message: 'Zoho Books authorization required' });
  }

  function requireFullAdminAuth(req, res, next) {
    if (authenticatedApiToken(req)) return next();
    const sess = getSession(req);
    if (!sess) return unauthorized(res);
    if (sess.isAdmin) {
      return next();
    }
    return res.status(403).json({ success: false, message: 'Full administrator access required' });
  }

  // UI Route Guards
  function requireUiOverviewAuth(req, res, next) {
    const sess = getSession(req);
    if (!sess) return res.redirect('/login');
    if (sess.isAdmin) {
      return next();
    }
    // Added users cannot see administrator overview dashboard!
    if (sess.permittedPages?.includes('leads')) return res.redirect('/leads');
    if (sess.permittedPages?.includes('chats')) return res.redirect('/chats');
    if (sess.permittedPages?.includes('bills')) return res.redirect('/bills');
    return res.redirect('/login');
  }

  function requireUiLeadsAuth(req, res, next) {
    const sess = getSession(req);
    if (!sess) return res.redirect('/login');
    if (sess.isAdmin || sess.permittedPages?.includes('leads') || sess.roles?.includes('lead') || sess.roles?.includes('admin')) {
      return next();
    }
    if (sess.permittedPages?.includes('bills')) return res.redirect('/bills');
    return res.redirect('/login');
  }

  function requireUiChatsAuth(req, res, next) {
    const sess = getSession(req);
    if (!sess) return res.redirect('/login');
    if (sess.isAdmin || sess.permittedPages?.includes('chats') || sess.roles?.includes('chat') || sess.roles?.includes('admin')) {
      return next();
    }
    if (sess.permittedPages?.includes('leads')) return res.redirect('/leads');
    if (sess.permittedPages?.includes('bills')) return res.redirect('/bills');
    return res.redirect('/login');
  }

  function requireUiBooksAuth(req, res, next) {
    const sess = getSession(req);
    if (!sess) return res.redirect('/login');
    if (sess.isAdmin || sess.permittedPages?.includes('bills') || sess.roles?.includes('books')) {
      return next();
    }
    if (sess.permittedPages?.includes('leads')) return res.redirect('/leads');
    return res.redirect('/login');
  }

  function requireUiAuth(req, res, next) {
    return requireUiOverviewAuth(req, res, next);
  }

  function sameOrigin(req, res, next) {
    const origin = requestOrigin(req);
    if (!origin.allowed) return res.status(403).json({ success: false, message: 'Request origin is not allowed' });
    res.locals.adminSecureOrigin = origin.secure;
    return next();
  }

  function cookieOptions(req, res) {
    return {
      httpOnly: true,
      sameSite: 'strict',
      path: cookiePath,
      secure: Boolean(production || req.secure || res.locals.adminSecureOrigin),
    };
  }

  function clearLegacySessionCookie(req, res) {
    // Older deployments scoped the same cookie name to /api. Keeping both
    // paths makes API requests ambiguous while HTML still appears signed in.
    if (cookiePath === '/') res.clearCookie(SESSION_COOKIE, { ...cookieOptions(req, res), path: '/api' });
  }

  function clearSessionCookies(req, res) {
    res.clearCookie(SESSION_COOKIE, cookieOptions(req, res));
    clearLegacySessionCookie(req, res);
  }

  router.use((_req, res, next) => {
    prune();
    res.set('Cache-Control', 'no-store');
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, message: 'Too many login attempts. Please try again later.' },
  });

  const getPermittedPages = (access, isRootAdmin = false) => {
    if (isRootAdmin) return ['dashboard', 'leads', 'chats', 'bills'];
    if (access === 'full') return ['leads', 'chats', 'bills'];
    if (access === 'leads_chat') return ['leads', 'chats'];
    if (access === 'lead') return ['leads'];
    if (access === 'billing_dashboard') return ['bills'];
    if (access === 'billing') return ['bills'];
    return ['leads'];
  };

  const handleLogin = (req, res, expectedTargetRole) => {
    if (!adminConfigured && !booksConfigured) return unavailable(res);
    if (!req.is('application/json')) return res.status(415).json({ success: false, message: 'Use application/json' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 2
        || !Object.hasOwn(body, 'username') || !Object.hasOwn(body, 'password')
        || !validCredential(body.username, 128) || !validCredential(body.password, 256)) {
      return res.status(400).json({ success: false, message: 'Invalid login request' });
    }

    const inputHash = credentialHash(body.username, body.password);
    let matchedUser = null;
    let matchedRole = null;
    let matchedRoles = [];
    let matchedAccess = 'lead';
    let isRootAdmin = false;

    // 1. Check root administrator from .env
    if (adminConfigured && timingSafeEqual(inputHash, expectedAdmin)) {
      matchedUser = adminUsername;
      matchedRole = 'admin';
      matchedRoles = adminBooksAccess === false ? ['admin'] : ['admin', 'books'];
      matchedAccess = 'full';
      isRootAdmin = true;
    } else if (booksConfigured && timingSafeEqual(inputHash, expectedBooks)) {
      matchedUser = booksUsername;
      matchedRole = 'books';
      matchedRoles = ['books'];
      matchedAccess = 'billing';
      isRootAdmin = false;
    } else {
      // 2. Check custom user added by Administrator
      const customUser = userService.verifyUser(body.username, body.password);
      if (customUser) {
        matchedUser = customUser.username;
        matchedAccess = customUser.access || 'lead';
        matchedRole = 'user';
        isRootAdmin = false;
        if (matchedAccess === 'lead') {
          matchedRoles = ['lead'];
        } else if (matchedAccess === 'leads_chat') {
          matchedRoles = ['lead', 'chat'];
        } else if (matchedAccess === 'billing') {
          matchedRoles = ['books'];
        } else if (matchedAccess === 'billing_dashboard') {
          matchedRoles = ['books', 'billing_dashboard'];
        } else if (matchedAccess === 'full') {
          matchedRoles = ['lead', 'chat', 'books', 'full'];
        }
      }
    }

    if (!matchedUser) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    if (expectedTargetRole && !matchedRoles.includes(expectedTargetRole) && !isRootAdmin) {
      return res.status(403).json({ success: false, message: `Account does not have ${expectedTargetRole} access` });
    }

    const previous = sessionCookie(req);
    if (previous) sessions.delete(previous);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    const permittedPages = getPermittedPages(matchedAccess, isRootAdmin);
    const sessionData = {
      expiresAt: now() + SESSION_TTL_MS,
      username: matchedUser,
      role: matchedRole,
      roles: matchedRoles,
      access: matchedAccess,
      permittedPages,
      isAdmin: Boolean(isRootAdmin),
    };
    sessions.set(token, sessionData);

    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req, res), maxAge: SESSION_TTL_MS });
    clearLegacySessionCookie(req, res);
    if (isRootAdmin) {
      return res.json({
        authenticated: true,
        username: matchedUser,
        role: matchedRole,
        roles: matchedRoles,
      });
    }
    return res.json({
      authenticated: true,
      username: matchedUser,
      role: matchedRole,
      roles: matchedRoles,
      access: matchedAccess,
      permittedPages,
      isAdmin: sessionData.isAdmin,
    });
  };

  router.post('/login', loginLimiter, sameOrigin, (req, res) => handleLogin(req, res));
  router.post('/login-books', loginLimiter, sameOrigin, (req, res) => handleLogin(req, res, 'books'));
  router.post('/login-admin', loginLimiter, sameOrigin, (req, res) => handleLogin(req, res, 'admin'));

  router.get('/session', (req, res) => {
    const sess = getSession(req);
    if (!sess) {
      // Continue rejecting duplicate/invalid tokens, but end the browser's
      // login -> dashboard -> unauthenticated API -> login redirect cycle.
      clearSessionCookies(req, res);
      return res.json({ authenticated: false });
    }
    if (sess.isAdmin) {
      return res.json({
        authenticated: true,
        username: sess.username,
        role: sess.role,
        roles: sess.roles,
      });
    }
    return res.json({
      authenticated: true,
      username: sess.username,
      role: sess.role,
      roles: sess.roles,
      access: sess.access,
      permittedPages: sess.permittedPages,
      isAdmin: false,
    });
  });

  router.post('/logout', sameOrigin, (req, res) => {
    const token = sessionCookie(req);
    if (token) sessions.delete(token);
    clearSessionCookies(req, res);
    return res.json({ authenticated: false });
  });

  // User Management REST endpoints (Requires Full Administrator)
  router.get('/users', requireFullAdminAuth, (_req, res) => {
    try {
      const users = userService.listUsers();
      return res.json({ success: true, users });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  router.post('/users', requireFullAdminAuth, express.json(), (req, res) => {
    try {
      const { username, password, access } = req.body || {};
      const user = userService.createUser({ username, password, access });
      return res.json({ success: true, user });
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
  });

  router.delete('/users/:username', requireFullAdminAuth, (req, res) => {
    try {
      const { username } = req.params;
      if (adminConfigured && username.toLowerCase() === adminUsername.toLowerCase()) {
        return res.status(400).json({ success: false, message: 'Cannot delete primary root administrator' });
      }
      const deleted = userService.deleteUser(username);
      if (!deleted) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      return res.json({ success: true, message: `User "${username}" deleted successfully` });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  router.post('/generate-password', requireFullAdminAuth, (_req, res) => {
    const pin = userService.generateNumericPassword(6);
    return res.json({ success: true, password: pin });
  });

  // Verify access authorization for unlocking a restricted section on the fly
  router.post('/verify-access', sameOrigin, express.json(), (req, res) => {
    const { username, password, targetPage = 'bills' } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    const inputHash = credentialHash(username, password);
    const isRootAdmin = adminConfigured && timingSafeEqual(inputHash, expectedAdmin);
    let customUser = null;
    if (!isRootAdmin) {
      customUser = userService.verifyUser(username, password);
    }
    if (!isRootAdmin && !customUser) {
      return res.status(401).json({ success: false, message: 'Invalid username or access password' });
    }

    const access = isRootAdmin ? 'full' : customUser.access;
    const permitted = getPermittedPages(access, isRootAdmin);

    // Check if entered credentials have permission for the requested targetPage
    const target = String(targetPage).replace(/^\//, '').toLowerCase();
    if (target === 'dashboard' && !isRootAdmin) {
      return res.status(403).json({ success: false, message: 'Administrator overview dashboard requires primary administrator credentials' });
    }
    if (target === 'bills' && !isRootAdmin && !permitted.includes('bills')) {
      return res.status(403).json({ success: false, message: 'Entered account does not have billing access' });
    }
    if (target === 'chats' && !isRootAdmin && !permitted.includes('chats')) {
      return res.status(403).json({ success: false, message: 'Entered account does not have chats access' });
    }
    if (target === 'leads' && !isRootAdmin && !permitted.includes('leads')) {
      return res.status(403).json({ success: false, message: 'Entered account does not have leads access' });
    }

    // Set new session for this user so navigation succeeds
    const previous = sessionCookie(req);
    if (previous) sessions.delete(previous);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    const matchedUser = isRootAdmin ? adminUsername : customUser.username;
    const matchedRoles = isRootAdmin ? ['admin', 'books', 'full'] : (access === 'leads_chat' ? ['lead', 'chat'] : (access === 'billing' ? ['books'] : (access === 'billing_dashboard' ? ['books', 'billing_dashboard'] : (access === 'lead' ? ['lead'] : ['admin', 'books']))));
    const sessionData = {
      expiresAt: now() + SESSION_TTL_MS,
      username: matchedUser,
      role: isRootAdmin ? 'admin' : 'user',
      roles: matchedRoles,
      access,
      permittedPages: permitted,
      isAdmin: Boolean(isRootAdmin),
    };
    sessions.set(token, sessionData);
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req, res), maxAge: SESSION_TTL_MS });

    let redirectUrl = '/' + target;
    if (target === 'dashboard' || target === 'overview') redirectUrl = '/dashboard';
    else if (target === 'bills' || target === 'books') redirectUrl = '/bills';
    else if (target === 'chats') redirectUrl = '/chats';
    else if (target === 'leads') redirectUrl = '/leads';

    return res.json({ success: true, authorized: true, access, redirectUrl });
  });

  return {
    requireAuth,
    requireAdminAuth,
    requireLeadAuth,
    requireChatAuth,
    requireBooksAuth,
    requireFullAdminAuth,
    requireUiAuth,
    requireUiOverviewAuth,
    requireUiLeadsAuth,
    requireUiChatsAuth,
    requireUiBooksAuth,
    router,
    getSession,
  };
}

module.exports = { createAdminAccess, SESSION_COOKIE, SESSION_TTL_MS };
