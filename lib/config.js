// Configuration and environment setup

const path = require('path');
const fs = require('fs');
const os = require('os');

// IMPORTANT: WebSocket must be set before requiring Kaspa
globalThis.WebSocket = require("websocket").w3cwebsocket;

// Embed WASM file before loading Kaspa (for single-file distribution)
const { patchKaspaWasmLoading } = require('./wasm-loader');
patchKaspaWasmLoading();

// Load Kaspa library from local kaspa/ directory or from pkg assets
let kaspa;
let kaspaLoadError = null;

try {
  // Try to load from pkg assets first (when packaged)
  const kaspaPath = path.join(__dirname, '..', 'kaspa', 'kaspa.js');
  if (fs.existsSync(kaspaPath)) {
    kaspa = require(kaspaPath);
    console.log('[Config] Loaded Kaspa from:', kaspaPath);
  } else {
    // When packaged with pkg, try direct require (assets are in snapshot)
    kaspa = require('../kaspa/kaspa.js');
    console.log('[Config] Loaded Kaspa from snapshot');
  }
} catch (err) {
  kaspaLoadError = err;
  console.warn('[Config] Failed to load Kaspa from normal path:', err.message);
  
  // Last resort: try to load from process.execPath directory (when running as .exe or Electron)
  try {
    // Use __dirname for development, process.execPath for packaged
    let execDir;
    
    // Check if we're in Electron main process
    const isElectron = typeof process !== 'undefined' && process.type === 'browser';
    
    if (isElectron) {
      // In Electron, use app.getAppPath() after app is ready
      // For now, use __dirname since we're in module load phase
      execDir = path.join(__dirname, '..');
      console.log('[Config] Electron detected, using dev path:', execDir);
    } else {
      execDir = process.execPath ? path.dirname(process.execPath) : path.join(__dirname, '..');
    }
    
    const kaspaPath = path.join(execDir, 'kaspa', 'kaspa.js');
    console.log('[Config] Trying Kaspa path:', kaspaPath);
    
    if (fs.existsSync(kaspaPath)) {
      kaspa = require(kaspaPath);
      console.log('[Config] Loaded Kaspa from:', kaspaPath);
    } else {
      // Try parent directory (for Electron packaged app)
      const parentKaspaPath = path.join(path.dirname(execDir), 'kaspa', 'kaspa.js');
      console.log('[Config] Trying parent Kaspa path:', parentKaspaPath);
      if (fs.existsSync(parentKaspaPath)) {
        kaspa = require(parentKaspaPath);
        console.log('[Config] Loaded Kaspa from:', parentKaspaPath);
      } else {
        throw new Error(`Kaspa library not found. Tried: ${kaspaPath}, ${parentKaspaPath}`);
      }
    }
  } catch (e2) {
    console.error('[Config] All Kaspa load attempts failed');
    throw new Error('Kaspa library not found. Please ensure kaspa.js is available. Last error: ' + e2.message);
  }
}

if (!kaspa) {
  throw new Error('Kaspa library failed to load. Original error: ' + (kaspaLoadError ? kaspaLoadError.message : 'Unknown'));
}

// Optional .env file support
try {
  const dotenv = require('dotenv');
  const envPath = path.join(process.execPath ? path.dirname(process.execPath) : __dirname, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config({ path: path.join(__dirname, '..', '.env') });
  }
} catch (e) {
  // dotenv not installed or .env file missing
}

// Configuration - uses environment variables or defaults
const KASPA_NODE_URL = process.env.KASPA_NODE_URL || 'ws://127.0.0.1:17110';
const KASPA_NETWORK = process.env.KASPA_NETWORK || 'mainnet';
const KASPA_ENCODING = 'borsh';

// Database path
const DB_PATH = path.join(os.homedir(), '.kaspa-mixer', 'sessions');

// Timing constants
const MIN_INTERMEDIATE_DELAY_MS = 1 * 60 * 1000;
const MAX_INTERMEDIATE_DELAY_MS = 2 * 60 * 1000;
const MIN_DELAY_MS = 1 * 1000;
const MAX_DELAY_MS = 5 * 1000;
const MIN_CONFIRMATIONS = 20;

module.exports = {
  kaspa,
  KASPA_NODE_URL,
  KASPA_NETWORK,
  KASPA_ENCODING,
  DB_PATH,
  MIN_INTERMEDIATE_DELAY_MS,
  MAX_INTERMEDIATE_DELAY_MS,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
  MIN_CONFIRMATIONS,
};

