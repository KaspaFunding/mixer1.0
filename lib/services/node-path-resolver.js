// Node path resolution service

const path = require('path');
const fs = require('fs');

const KASPAD_EXE = 'kaspad.exe';
const KASPAD_BAT = 'start-kaspad.bat';

// Determine base directory for packaged/exe execution
function determineBaseDirectory() {
  if (process.execPath && !process.execPath.includes('electron')) {
    const baseDir = path.dirname(process.execPath);
    console.log('[Node Path] Base directory (from execPath):', baseDir);
    return baseDir;
  }
  
  if (typeof require !== 'undefined') {
    try {
      const { app } = require('electron');
      if (app) {
        const baseDir = app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
        console.log('[Node Path] Base directory (from Electron app):', baseDir);
        console.log('[Node Path] App is packaged:', app.isPackaged);
        console.log('[Node Path] Exe path:', app.getPath('exe'));
        console.log('[Node Path] Resources path:', process.resourcesPath);
        return baseDir;
      }
    } catch (_) {
      // Not in Electron context
    }
  }
  
  const fallbackDir = path.join(__dirname, '..');
  console.log('[Node Path] Base directory (fallback):', fallbackDir);
  return fallbackDir;
}

// Build candidate paths for kaspad.exe
function buildCandidatePaths(baseDir) {
  const candidates = [path.join(baseDir, KASPAD_EXE)];
  
  if (typeof require !== 'undefined') {
    try {
      const { app } = require('electron');
      if (app) {
        candidates.push(path.join(baseDir, KASPAD_BAT));
        const resourcesPath = app.isPackaged ? process.resourcesPath : undefined;
        if (resourcesPath) {
          candidates.push(path.join(resourcesPath, KASPAD_EXE));
          candidates.push(path.join(resourcesPath, 'kaspa', KASPAD_EXE));
          candidates.push(path.join(resourcesPath, KASPAD_BAT));
          // Also check in app.asar.unpacked for files marked as asarUnpack
          candidates.push(path.join(resourcesPath, 'app.asar.unpacked', 'kaspa', KASPAD_EXE));
        }
      }
    } catch (_) {
      // Not in Electron context
    }
  }
  
  console.log('[Node Path] Candidate paths for kaspad:', candidates);
  return candidates;
}

// Find kaspad executable
function findKaspadExe() {
  console.log('[Node Path] Starting kaspad.exe search...');
  const baseDir = determineBaseDirectory();
  const candidates = buildCandidatePaths(baseDir);
  
  // Check each candidate and log results
  candidates.forEach((candidatePath, index) => {
    const exists = candidatePath && fs.existsSync(candidatePath);
    console.log(`[Node Path] Candidate ${index + 1}: ${candidatePath} - ${exists ? 'EXISTS' : 'NOT FOUND'}`);
  });
  
  const exePath = candidates.find(p => p && p.toLowerCase().endsWith('kaspad.exe') && fs.existsSync(p));
  const batPath = candidates.find(p => p && p.toLowerCase().endsWith('start-kaspad.bat') && fs.existsSync(p));
  
  console.log('[Node Path] Selected exe path:', exePath || 'NOT FOUND');
  console.log('[Node Path] Selected bat path:', batPath || 'NOT FOUND');
  
  return {
    exePath: exePath || path.join(baseDir, KASPAD_EXE),
    batPath: batPath || path.join(baseDir, KASPAD_BAT),
    baseDir
  };
}

// Determine writable batch file path
function getWritableBatPath(defaultBatPath) {
  if (typeof require !== 'undefined') {
    try {
      const { app } = require('electron');
      if (app && app.isPackaged) {
        const exeDir = path.dirname(app.getPath('exe'));
        if (defaultBatPath.startsWith(exeDir) || defaultBatPath.includes('Program Files')) {
          const userDataDir = app.getPath('userData');
          return path.join(userDataDir, 'start-kaspad.bat');
        }
      }
    } catch (_) {
      // Not in Electron context
    }
  }
  return defaultBatPath;
}

module.exports = {
  findKaspadExe,
  getWritableBatPath,
  KASPAD_EXE,
  KASPAD_BAT,
};

