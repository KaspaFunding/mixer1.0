// Node path resolution service

const path = require('path');
const fs = require('fs');

const KASPAD_EXE = 'kaspad.exe';
const KASPAD_BAT = 'start-kaspad.bat';

// Determine base directory for packaged/exe execution
function determineBaseDirectory() {
  if (process.execPath && !process.execPath.includes('electron')) {
    return path.dirname(process.execPath);
  }
  
  if (typeof require !== 'undefined') {
    try {
      const { app } = require('electron');
      if (app) {
        return app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
      }
    } catch (_) {
      // Not in Electron context
    }
  }
  
  return path.join(__dirname, '..');
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
        }
      }
    } catch (_) {
      // Not in Electron context
    }
  }
  
  return candidates;
}

// Find kaspad executable
function findKaspadExe() {
  const baseDir = determineBaseDirectory();
  const candidates = buildCandidatePaths(baseDir);
  
  const exePath = candidates.find(p => p && p.toLowerCase().endsWith('kaspad.exe') && fs.existsSync(p));
  const batPath = candidates.find(p => p && p.toLowerCase().endsWith('start-kaspad.bat') && fs.existsSync(p));
  
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

