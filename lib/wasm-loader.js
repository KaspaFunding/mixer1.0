// WASM file loader - embeds WASM file as base64 for single-file distribution

const fs = require('fs');
const path = require('path');

let embeddedWasmBytes = null;

// Load WASM from embedded base64 string
function loadEmbeddedBase64() {
  if (embeddedWasmBytes) {
    return embeddedWasmBytes;
  }
  
  try {
    // Try to load embedded WASM (created during build)
    const embedded = require('./wasm-embedded');
    if (embedded && embedded.wasmBase64) {
      embeddedWasmBytes = Buffer.from(embedded.wasmBase64, 'base64');
      return embeddedWasmBytes;
    }
  } catch (err) {
    // Embedded file doesn't exist - will fall back to file system
  }
  return null;
}

// Try to load WASM from file system or embedded version
function loadWasmEmbedded() {
  // First try embedded base64 version
  const embedded = loadEmbeddedBase64();
  if (embedded) {
    return embedded;
  }
  
  // Fallback to file system (for development or if embedding failed)
  try {
    const possiblePaths = [
      path.join(__dirname, '..', 'kaspa', 'kaspa_bg.wasm'),
      path.join(process.execPath ? path.dirname(process.execPath) : __dirname, 'kaspa', 'kaspa_bg.wasm'),
      path.join(process.cwd(), 'kaspa', 'kaspa_bg.wasm'),
    ];
    
    for (const wasmPath of possiblePaths) {
      if (fs.existsSync(wasmPath)) {
        return fs.readFileSync(wasmPath);
      }
    }
  } catch (err) {
    // File system read failed
  }
  
  return null;
}

// Patch fs.readFileSync to intercept kaspa_bg.wasm loads
function patchKaspaWasmLoading() {
  const originalReadFileSync = fs.readFileSync;
  const wasmBytes = loadWasmEmbedded();
  
  if (wasmBytes) {
    // Intercept readFileSync calls for kaspa_bg.wasm
    fs.readFileSync = function(...args) {
      const filePath = args[0];
      
      // Check if this is a request for kaspa_bg.wasm
      // kaspa.js uses: require('path').join(__dirname, 'kaspa_bg.wasm')
      if (typeof filePath === 'string') {
        // Match any path ending in kaspa_bg.wasm
        if (filePath.includes('kaspa_bg.wasm') || filePath.endsWith('kaspa_bg.wasm')) {
          return wasmBytes;
        }
        
        // Also check if it's trying to read from the same directory as kaspa.js
        // kaspa.js does: path.join(__dirname, 'kaspa_bg.wasm')
        // In pkg, __dirname might be different, so we check the filename
        if (path.basename(filePath) === 'kaspa_bg.wasm') {
          return wasmBytes;
        }
      }
      
      // For all other files, use original function
      return originalReadFileSync.apply(fs, args);
    };
  } else {
    // In development, allow file system reads
    console.warn('⚠ Warning: Could not load embedded WASM, will try file system');
  }
}

module.exports = {
  loadWasmEmbedded,
  patchKaspaWasmLoading,
};

