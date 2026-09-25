'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomInt, scryptSync, timingSafeEqual } = require('node:crypto');

const USERS_FILE = path.resolve(process.env.VOLTRONIX_USERS_FILE || path.resolve(__dirname, '..', '..', '..', 'data', 'users.json'));
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64, maxmem: 32 * 1024 * 1024 });

function ensureUsersFile() {
  try {
    const dir = path.dirname(USERS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2), { encoding: 'utf8', mode: 0o600 });
    }
    fs.chmodSync(USERS_FILE, 0o600);
  } catch (err) {
    throw new Error('User account storage is unavailable.', { cause: err });
  }
}

function readUsers() {
  ensureUsersFile();
  try {
    const content = fs.readFileSync(USERS_FILE, 'utf8');
    const users = JSON.parse(content);
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
}

function writeUsers(users) {
  ensureUsersFile();
  const temporaryFile = `${USERS_FILE}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(users, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, USERS_FILE);
    fs.chmodSync(USERS_FILE, 0o600);
    return true;
  } catch {
    try { fs.rmSync(temporaryFile, { force: true }); } catch { /* Preserve the safe failure below. */ }
    throw new Error('User account storage is unavailable.');
  }
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(String(password), salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function legacyHashPassword(password) {
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(String(password)).digest('hex');
}

function verifyHash(password, encoded) {
  if (typeof encoded !== 'string' || !encoded.startsWith('scrypt$')) return false;
  const [, saltText, digestText] = encoded.split('$');
  if (!saltText || !digestText) return false;
  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(digestText, 'base64url');
    if (salt.length !== 16 || expected.length !== SCRYPT_PARAMS.keylen) return false;
    const actual = scryptSync(String(password), salt, expected.length, SCRYPT_PARAMS);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function publicUser(user) {
  return {
    username: user.username,
    access: user.access,
    createdAt: user.createdAt || new Date().toISOString(),
  };
}

/**
 * Valid access tiers:
 * - 'lead' : Leads only
 * - 'leads_chat' : Leads and Chats
 * - 'billing' : Bills only
 * - 'billing_dashboard' : Bills and Bill Dashboard
 * - 'full' : Full Access (all dashboard views + user management)
 */
const VALID_ACCESS_TIERS = ['lead', 'leads_chat', 'billing', 'billing_dashboard', 'full'];

const userService = {
  listUsers() {
    const users = readUsers();
    return users.map(publicUser);
  },

  getUser(username) {
    if (!username) return null;
    const users = readUsers();
    return users.find(u => u.username.toLowerCase() === String(username).toLowerCase().trim()) || null;
  },

  createUser({ username, password, access = 'lead' }) {
    if (!username || typeof username !== 'string' || !username.trim()) {
      throw new Error('Username is required');
    }
    const cleanUsername = username.trim().toLowerCase();
    if (cleanUsername.length < 3 || cleanUsername.length > 50) {
      throw new Error('Username must be between 3 and 50 characters');
    }
    if (!password || String(password).length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    const cleanAccess = VALID_ACCESS_TIERS.includes(access) ? access : 'lead';

    const users = readUsers();
    const existing = users.find(u => u.username.toLowerCase() === cleanUsername);
    if (existing) {
      throw new Error(`User "${cleanUsername}" already exists`);
    }

    const newUser = {
      username: cleanUsername,
      passwordHash: hashPassword(String(password).trim()),
      access: cleanAccess,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    writeUsers(users);

    return {
      username: newUser.username,
      access: newUser.access,
      // Return the supplied password once so the existing admin hand-off UI
      // continues to work; it is never persisted or returned by listUsers().
      password: String(password).trim(),
      createdAt: newUser.createdAt
    };
  },

  deleteUser(username) {
    if (!username) return false;
    const cleanUsername = String(username).trim().toLowerCase();
    const users = readUsers();
    const initialLen = users.length;
    const filtered = users.filter(u => u.username.toLowerCase() !== cleanUsername);
    if (filtered.length === initialLen) return false;
    writeUsers(filtered);
    return true;
  },

  verifyUser(username, password) {
    if (!username || !password) return null;
    let user = this.getUser(username);
    if (!user) return null;

    const cleanPassword = String(password).trim();
    const matchesModern = verifyHash(cleanPassword, user.passwordHash);
    const matchesLegacy = user.passwordHash && user.passwordHash === legacyHashPassword(cleanPassword);
    const matchesPlaintext = typeof user.password === 'string' && user.password === cleanPassword;
    if (matchesModern || matchesLegacy || matchesPlaintext) {
      if (!matchesModern) {
        const users = readUsers();
        const stored = users.find(item => item.username?.toLowerCase() === user.username.toLowerCase());
        if (stored) {
          stored.passwordHash = hashPassword(cleanPassword);
          delete stored.password;
          writeUsers(users);
          user = stored;
        }
      }
      return user;
    }
    return null;
  },

  generateNumericPassword(length = 10) {
    if (!Number.isInteger(length) || length < 8 || length > 12) throw new Error('Password length must be between 8 and 12.');
    const min = Math.pow(10, length - 1);
    const max = Math.pow(10, length) - 1;
    return String(randomInt(min, max + 1));
  }
};

module.exports = { userService, VALID_ACCESS_TIERS };
