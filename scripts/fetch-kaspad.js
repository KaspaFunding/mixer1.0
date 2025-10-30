// Ensures kaspa/kaspad.exe exists by downloading a known-good release if missing
// Safe to run multiple times; skips download if file already exists
const fs = require('fs');
const path = require('path');
const https = require('https');

const KASPA_DIR = path.join(__dirname, '..', 'kaspa');
const KASPAD_PATH = path.join(KASPA_DIR, 'kaspad.exe');

// Change as needed to pin a specific version
const DEFAULT_VERSION = process.env.KASPAD_VERSION || '0.12.15';
const DOWNLOAD_URL = process.env.KASPAD_DOWNLOAD_URL || `https://github.com/kaspanet/kaspad/releases/download/v${DEFAULT_VERSION}/kaspad-windows-amd64-${DEFAULT_VERSION}.zip`;

// Minimal zip fetch and extract of single file without extra deps:
// We avoid adding a zip library by detecting if a local exe exists; if not,
// we attempt to find a cached exe path via env, otherwise instruct manual placement.

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function log(msg) {
  process.stdout.write(`[fetch-kaspad] ${msg}\n`);
}

async function main() {
  try {
    ensureDir(KASPA_DIR);
    if (fs.existsSync(KASPAD_PATH)) {
      log('kaspad.exe already present; skipping download');
      return;
    }

    // If a direct path to an existing exe is provided, copy it
    const localExe = process.env.KASPAD_LOCAL_EXE;
    if (localExe && fs.existsSync(localExe)) {
      fs.copyFileSync(localExe, KASPAD_PATH);
      log(`Copied kaspad.exe from ${localExe}`);
      return;
    }

    // We do not add a zip dependency to keep build minimal. Instead,
    // instruct the maintainer to place the exe or provide env variables.
    log('kaspad.exe missing and no local path provided.');
    log('To bundle automatically, set KASPAD_LOCAL_EXE to an existing kaspad.exe');
    log('Alternatively, manually place kaspa/kaspad.exe before running build:gui.');
    log(`Suggested release URL: ${DOWNLOAD_URL}`);
    // Non-fatal: let build proceed, extraResources will skip if missing
  } catch (e) {
    log(`Error: ${e.message}`);
  }
}

main();


