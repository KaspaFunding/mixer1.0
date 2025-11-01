// Settings storage for application preferences

const fs = require('fs');
const path = require('path');
const os = require('os');
const { DB_PATH } = require('./config');

// Settings file location (same directory as wallet.json)
const SETTINGS_FILE = path.join(path.dirname(DB_PATH), 'settings.json');

// Default settings
const DEFAULT_SETTINGS = {
  nodeMode: 'private', // 'private' or 'public'
  lastUpdated: Date.now()
};

// Ensure settings directory exists
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

// Read settings from file
function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const settings = JSON.parse(data);
      // Merge with defaults to handle new settings
      return { ...DEFAULT_SETTINGS, ...settings };
    }
  } catch (error) {
    console.error('Error reading settings:', error);
  }
  return { ...DEFAULT_SETTINGS };
}

// Write settings to file
function writeSettings(settings) {
  try {
    const currentSettings = readSettings();
    const updatedSettings = {
      ...currentSettings,
      ...settings,
      lastUpdated: Date.now()
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updatedSettings, null, 2), 'utf8');
    return updatedSettings;
  } catch (error) {
    console.error('Error writing settings:', error);
    throw error;
  }
}

// Get node mode (public or private)
function getNodeMode() {
  const settings = readSettings();
  return settings.nodeMode || 'private';
}

// Set node mode
function setNodeMode(mode) {
  if (mode !== 'public' && mode !== 'private') {
    throw new Error('Node mode must be "public" or "private"');
  }
  const updates = { nodeMode: mode };
  // Clear external IP when switching to private mode
  if (mode === 'private') {
  }
  return writeSettings(updates);
}

module.exports = {
  readSettings,
  writeSettings,
  getNodeMode,
  setNodeMode,
  SETTINGS_FILE
};

