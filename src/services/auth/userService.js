'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const USERS_FILE = path.resolve(__dirname, '..', '..', '..', 'data', 'users.json');

function ensureUsersFile() {
  try {
    const dir = path.dirname(USERS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2), 'utf8');
    }
  } catch (err) {
    console.error('Error ensuring users file:', err);
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
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing users file:', err);
    return false;
  }
}

function hashPassword(password) {
  return createHash('sha256').update(String(password)).digest('hex');
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
    return users.map(u => ({
      username: u.username,
      access: u.access,
      password: u.password || '******', // Visible to administrator as requested
      createdAt: u.createdAt || new Date().toISOString()
    }));
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
    if (!password || String(password).length < 4) {
      throw new Error('Password must be at least 4 characters');
    }
    const cleanAccess = VALID_ACCESS_TIERS.includes(access) ? access : 'lead';

    const users = readUsers();
    const existing = users.find(u => u.username.toLowerCase() === cleanUsername);
    if (existing) {
      throw new Error(`User "${cleanUsername}" already exists`);
    }

    const newUser = {
      username: cleanUsername,
      password: String(password).trim(), // Displayed to admin so admin can give to user
      passwordHash: hashPassword(String(password).trim()),
      access: cleanAccess,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    writeUsers(users);

    return {
      username: newUser.username,
      access: newUser.access,
      password: newUser.password,
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
    const user = this.getUser(username);
    if (!user) return null;

    const inputHash = hashPassword(String(password).trim());
    if (user.passwordHash && user.passwordHash === inputHash) {
      return user;
    }
    // Fallback if plain match
    if (user.password && user.password === String(password).trim()) {
      return user;
    }
    return null;
  },

  generateNumericPassword(length = 6) {
    const min = Math.pow(10, length - 1);
    const max = Math.pow(10, length) - 1;
    return String(Math.floor(min + Math.random() * (max - min + 1)));
  }
};

module.exports = { userService, VALID_ACCESS_TIERS };
