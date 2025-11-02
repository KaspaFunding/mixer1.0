// Auto-start Kaspa node if not already running

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getNodeMode } = require('./settings');

const KASPAD_EXE = 'kaspad.exe';
const KASPAD_BAT = 'start-kaspad.bat';

// Check if kaspad.exe is running
function isKaspadRunning() {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq kaspad.exe"', (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      resolve(stdout.includes('kaspad.exe'));
    });
  });
}

// Check if node is listening on port
function isNodeListening(host = '127.0.0.1', port = 17110, timeout = 5000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    const checkPort = () => {
      const net = require('net');
      const socket = new net.Socket();
      
      socket.setTimeout(1000);
      
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      
      socket.on('timeout', () => {
        socket.destroy();
        if (Date.now() - startTime < timeout) {
          setTimeout(checkPort, 500);
        } else {
          resolve(false);
        }
      });
      
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - startTime < timeout) {
          setTimeout(checkPort, 500);
        } else {
          resolve(false);
        }
      });
      
      socket.connect(port, host);
    };
    
    checkPort();
  });
}

// Stop kaspad.exe (gracefully if possible)
async function stopNode() {
  return new Promise((resolve) => {
    exec('taskkill /F /IM kaspad.exe', (error, stdout) => {
      if (error) {
        // Process might not be running, which is fine
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

// Generate bat file content with mode parameter
function generateBatContent(isPublic = false, kaspadExePath = 'kaspad.exe') {
  const nodeMode = isPublic ? 'Public' : 'Private';
  const upnpFlag = isPublic ? '' : ' --disable-upnp';
  const modeDescription = isPublic ? 'Public (UPnP Enabled)' : 'Private (UPnP Disabled)';
  
  // Use full path to kaspad.exe if provided, otherwise use relative
  const kaspadCmd = path.isAbsolute(kaspadExePath) ? `"${kaspadExePath}"` : kaspadExePath;
  const kaspadDir = path.isAbsolute(kaspadExePath) ? path.dirname(kaspadExePath) : '';
  
  return `@echo off
REM Kaspa Node Auto-Start Script (Auto-generated)
REM This script starts kaspad.exe and automatically restarts it if it crashes

title Kaspa Node - Auto-Restart Script

${kaspadDir ? `REM Change to kaspad.exe directory to ensure it can find any dependencies
cd /d "${kaspadDir}"` : ''}

:xxx
echo Starting Kaspa Node (kaspad.exe)...
${kaspadDir ? `echo Directory: ${kaspadDir}` : ''}
echo Parameters: --utxoindex --rpclisten=127.0.0.1:16110 --rpclisten-borsh=127.0.0.1:17110 --perf-metrics --perf-metrics-interval-sec=1 --outpeers=128${upnpFlag}
echo Node Mode: ${modeDescription}
echo.
echo To stop, press Ctrl+C and then 'Y' when prompted, or press S when asked.
echo.

${kaspadCmd} --utxoindex --rpclisten=127.0.0.1:16110 --rpclisten-borsh=127.0.0.1:17110 --perf-metrics --perf-metrics-interval-sec=1 --outpeers=128${upnpFlag}

echo.
echo Kaspa Node process exited. Restarting in 5 seconds...
echo Press Ctrl+C to abort restart, or press S to stop now.
choice /C SR /N /T 5 /D R >nul
if errorlevel 2 goto xxx
echo Stopping by user request.
goto :eof
`;
}

// Start kaspad.exe automatically
async function ensureNodeRunning(forcePublic = null) {
  // Determine node mode
  const isPublic = forcePublic !== null ? forcePublic : (getNodeMode() === 'public');
  // Check if node is already running
  const alreadyRunning = await isKaspadRunning();
  if (alreadyRunning) {
    console.log('✓ Kaspa node (kaspad.exe) is already running');
    
    // Check if it's actually listening
    const listening = await isNodeListening();
    if (listening) {
      console.log('✓ Node is ready and listening');
      return { started: false, alreadyRunning: true };
    } else {
      console.log('⚠ Node process exists but not ready yet. Waiting...');
      // Wait for it to become ready
      const maxWait = 60; // 60 seconds max
      for (let i = 0; i < maxWait; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (await isNodeListening()) {
          console.log('✓ Node is now ready');
          return { started: false, alreadyRunning: true };
        }
        if (i % 5 === 0 && i > 0) {
          process.stdout.write('.');
        }
      }
      console.log('\n⚠ Node did not become ready in time');
      return { started: false, alreadyRunning: true, ready: false };
    }
  }
  
      // Check if kaspad.exe exists
      // Resolve likely locations across CLI, Electron dev, and packaged installer
      let baseDir;
      let candidatePaths = [];
      if (process.execPath && !process.execPath.includes('electron')) {
        // Running from packaged CLI .exe
        baseDir = path.dirname(process.execPath);
      } else if (typeof require !== 'undefined') {
        try {
          const { app } = require('electron');
          if (app) {
            // In Electron: use install dir for packaged, app path for dev
            baseDir = app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
            // Common packaged locations
            candidatePaths.push(path.join(baseDir, KASPAD_EXE));
            candidatePaths.push(path.join(baseDir, KASPAD_BAT));
            // Also check resources path (electron-builder extraResources)
            const resourcesPath = app.isPackaged ? process.resourcesPath : undefined;
            if (resourcesPath) {
              candidatePaths.push(path.join(resourcesPath, KASPAD_EXE));
              candidatePaths.push(path.join(resourcesPath, 'kaspa', KASPAD_EXE));
              candidatePaths.push(path.join(resourcesPath, KASPAD_BAT));
            }
          }
        } catch (_) {
          // ignore
        }
      }
      if (!baseDir) {
        // Development fallback
        baseDir = path.join(__dirname, '..');
      }
  const exePath = candidatePaths.find(p => p && p.toLowerCase().endsWith('kaspad.exe') && fs.existsSync(p)) || path.join(baseDir, KASPAD_EXE);
  const batPath = candidatePaths.find(p => p && p.toLowerCase().endsWith('start-kaspad.bat') && fs.existsSync(p)) || path.join(baseDir, KASPAD_BAT);
  
  const exeExists = fs.existsSync(exePath);
  const batExists = fs.existsSync(batPath);
  
  if (!exeExists && !batExists) {
    console.log('⚠ kaspad.exe not found. Starting mixer without auto-starting node.');
    console.log(`  Looking in: ${baseDir}`);
    console.log('  You need to start kaspad.exe manually or use start-mixer-with-node.bat');
    return { started: false, found: false };
  }
  
  console.log('Starting Kaspa node automatically...');
  
  try {
    let process;
    
    // Prefer using the batch file if it exists (has auto-restart)
    if (batExists) {
      // Update bat file if mode has changed (ensures correct mode is used)
      // In packaged apps, use userData for batch file (writable location)
      let actualBatPath = batPath;
      if (typeof require !== 'undefined') {
        try {
          const { app } = require('electron');
          if (app && app.isPackaged) {
            // Check if batPath is in Program Files (not writable)
            const exeDir = path.dirname(app.getPath('exe'));
            if (batPath.startsWith(exeDir) || batPath.includes('Program Files')) {
              // Use userData instead
              const userDataDir = app.getPath('userData');
              actualBatPath = path.join(userDataDir, 'start-kaspad.bat');
            }
          }
        } catch (_) {}
      }
      const batContent = generateBatContent(isPublic, exePath);
      fs.writeFileSync(actualBatPath, batContent, 'utf8');
      if (actualBatPath !== batPath) {
        batPath = actualBatPath; // Update for use below
      }
      console.log(`  Using start-kaspad.bat (${isPublic ? 'Public' : 'Private'} mode, auto-restart enabled)`);
      // Start in a new window so user can see it
      // Use absolute path to batch file
      const batFullPath = path.resolve(batPath);
      // Change to the batch file's directory for execution
      const batDir = path.dirname(batFullPath);
      // Use empty title argument ("") so START doesn't treat next token as command
      process = spawn('cmd', ['/c', `start "" cmd /c cd /d "${batDir}" && "${batFullPath}"`], {
        detached: true,
        stdio: 'ignore',
        shell: true
      });
      process.unref();
    } else if (exeExists) {
      // If batch file doesn't exist but exe exists, create batch file on-the-fly
      // In packaged apps, create in userData (writable) instead of Program Files
      let actualBatPath = batPath;
      if (typeof require !== 'undefined') {
        try {
          const { app } = require('electron');
          if (app && app.isPackaged) {
            // Use userData for batch file (writable location)
            const userDataDir = app.getPath('userData');
            actualBatPath = path.join(userDataDir, 'start-kaspad.bat');
          }
        } catch (_) {}
      }
      
      console.log(`  Creating start-kaspad.bat automatically (${isPublic ? 'Public' : 'Private'} mode)`);
      const batContent = generateBatContent(isPublic, exePath);
      try {
        fs.writeFileSync(actualBatPath, batContent, 'utf8');
        batPath = actualBatPath; // Update batPath for use below
        console.log(`  Created start-kaspad.bat at ${actualBatPath}`);
        // Now use the newly created batch file
        const batFullPath = path.resolve(actualBatPath);
        const batDir = path.dirname(batFullPath);
        process = spawn('cmd', ['/c', `start "" cmd /c cd /d "${batDir}" && "${batFullPath}"`], {
          detached: true,
          stdio: 'ignore',
          shell: true
        });
        process.unref();
      } catch (err) {
        console.error('  Failed to create batch file:', err.message);
        // Fall back to direct exe start
        console.log(`  Starting kaspad.exe directly instead (${isPublic ? 'Public' : 'Private'} mode)`);
        const exeFullPath = path.resolve(exePath);
        const args = [
          '--utxoindex',
          '--rpclisten=127.0.0.1:16110',
          '--rpclisten-borsh=127.0.0.1:17110',
          '--perf-metrics',
          '--perf-metrics-interval-sec=1',
          '--outpeers=128'
        ];
        if (!isPublic) {
          args.push('--disable-upnp');
        }
        process = spawn(`"${exeFullPath}"`, args, {
          detached: true,
          stdio: 'ignore',
          shell: true
        });
        process.unref();
      }
    }
    
    console.log('  Node starting... waiting for it to become ready...');
    console.log('  (This may take 30-60 seconds on first run)');
    
    // Wait for node to become ready
    const maxWait = 90; // 90 seconds max
    for (let i = 0; i < maxWait; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      if (await isNodeListening()) {
        console.log('✓ Node is ready!');
        return { started: true, ready: true };
      }
      
      // Show progress every 5 seconds
      if (i % 5 === 0 && i > 0) {
        process.stdout.write('.');
      }
    }
    
    console.log('\n⚠ Node did not become ready within 90 seconds');
    console.log('  Continuing anyway - mixer will check connection...');
    return { started: true, ready: false };
    
  } catch (error) {
    console.error('✗ Error starting kaspad.exe:', error.message);
    return { started: false, error: error.message };
  }
}

// Restart node with new mode
async function restartNode(newMode) {
  const isPublic = newMode === 'public';
  console.log(`Restarting node in ${isPublic ? 'Public' : 'Private'} mode...`);
  
  // Stop existing node
  const stopped = await stopNode();
  if (stopped) {
    console.log('  Stopped existing node');
    // Wait a moment for process to fully terminate
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Start with new mode
  return await ensureNodeRunning(isPublic);
}

module.exports = {
  ensureNodeRunning,
  isKaspadRunning,
  isNodeListening,
  stopNode,
  restartNode,
  generateBatContent
};

