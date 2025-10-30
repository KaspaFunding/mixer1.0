// Database operations using JSON file storage (no native dependencies)

const path = require('path');
const fs = require('fs');
const { DB_PATH } = require('./config');

// Use JSON file instead of LMDB for standalone version
const SESSIONS_FILE = path.join(path.dirname(DB_PATH), 'sessions.json');

// Ensure database directory exists
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

// Helper to deserialize JSON back to proper format (convert string BigInts back)
function deserializeFromJSON(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => deserializeFromJSON(item));
  }
  
  if (typeof obj === 'object' && obj.constructor === Object) {
    const deserialized = {};
    for (const [key, value] of Object.entries(obj)) {
      // Keep amount fields as numbers (they're already stored as numbers, not BigInt strings)
      // UTXO amounts are stored as strings from RPC, so keep them as strings
      deserialized[key] = deserializeFromJSON(value);
    }
    return deserialized;
  }
  
  return obj;
}

// Read sessions from JSON file
function readSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      return deserializeFromJSON(parsed);
    }
  } catch (err) {
    console.error('Error reading sessions file:', err.message);
  }
  return {};
}

// Helper to serialize BigInt and other special values to JSON-safe format
function serializeForJSON(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => serializeForJSON(item));
  }
  
  if (typeof obj === 'object' && obj.constructor === Object) {
    const serialized = {};
    for (const [key, value] of Object.entries(obj)) {
      serialized[key] = serializeForJSON(value);
    }
    return serialized;
  }
  
  return obj;
}

// Write sessions to JSON file
function writeSessions(sessions) {
  try {
    const serialized = serializeForJSON(sessions);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(serialized, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing sessions file:', err.message);
    throw err;
  }
}

async function getSession(sessionId) {
  const sessions = readSessions();
  return sessions[sessionId] || null;
}

async function setSession(sessionId, session) {
  const sessions = readSessions();
  sessions[sessionId] = session;
  writeSessions(sessions);
}

async function deleteSession(sessionId) {
  const sessions = readSessions();
  if (sessions[sessionId]) {
    delete sessions[sessionId];
    writeSessions(sessions);
  }
}

async function getAllSessions() {
  const sessions = readSessions();
  const result = [];
  for (const [sessionId, session] of Object.entries(sessions)) {
    result.push({ sessionId, session });
  }
  return result;
}

module.exports = {
  getSession,
  setSession,
  deleteSession,
  getAllSessions,
};

