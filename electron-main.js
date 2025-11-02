// Electron main process - GUI entry point

const { app, BrowserWindow, ipcMain, session } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');
const { ensureNodeRunning, restartNode, generateBatContent } = require('./lib/node-starter');
const { getNodeMode, setNodeMode } = require('./lib/settings');

// Import backend modules
const { createSession, getSession, getAllSessions } = require('./lib/session-manager');
const { deleteSession } = require('./lib/database');
const { checkNodeStatus } = require('./lib/rpc-client');
const { importPrivateKey, importMnemonic, generateAddressesFromKPUB, detectKPUBFormat, detectWalletType, getWalletInfo, getWalletBalance, getWalletTransactionHistory, estimateTransactionFee, sendFromWallet, removeWallet, getAddressBook, addAddressToBook, updateAddressInBook, removeAddressFromBook } = require('./lib/wallet');
const { kaspa, KASPA_NETWORK } = require('./lib/config');
const { startMonitoring, startIntermediateMonitoring } = require('./lib/monitor');
const { processFinalPayout } = require('./lib/payout');

let mainWindow = null;
let poolProcess = null;
let poolStatus = { running: false, pid: null, port: 7777, output: '', exited: false, exitCode: null };

// Keep a larger rolling buffer so more lines are visible in Recent Output
const MAX_LOG_CHARS = 20000;

// Remove ANSI color codes so logs render cleanly in the GUI
function stripAnsi(text) {
  try {
    return String(text).replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '');
  } catch (_) {
    return String(text);
  }
}

// Emphasize important events without changing IPC shape
function emphasizeIfImportant(line) {
  const l = line.toLowerCase();
  if (
    l.includes('block found') ||
    (l.includes('block') && l.includes('found')) ||
    l.includes('payout') ||
    l.includes('paid') ||
    l.includes('reward') ||
    l.includes('orphan') ||
    l.includes('reorg')
  ) {
    return `>>> ${line.trim()} <<<`;
  }
  return line;
}

// Pool config helpers (persist in userData; copy default on first run)
function getPoolConfigPath() {
  try {
    const userDir = app.getPath('userData');
    return path.join(userDir, 'pool', 'config.json');
  } catch (_) {
  return path.join(__dirname, 'pool', 'config.json');
  }
}
function ensureUserConfig() {
  const userCfgPath = getPoolConfigPath();
  try {
    if (fs.existsSync(userCfgPath)) {
      // Config already exists - validate it in readPoolConfig instead
      return userCfgPath;
    }
    
    const userDir = path.dirname(userCfgPath);
    fs.mkdirSync(userDir, { recursive: true });
    
    // Source default from app resources, but ensure privateKey is always empty
    const defaultCfgPath = path.join(__dirname, 'pool', 'config.json');
    if (fs.existsSync(defaultCfgPath)) {
      // Read default config and ensure privateKey is empty
      const defaultConfig = JSON.parse(fs.readFileSync(defaultCfgPath, 'utf-8'));
      // SECURITY: Always ensure privateKey is empty in fresh installs
      if (defaultConfig.treasury) {
        defaultConfig.treasury.privateKey = '';
      } else {
        defaultConfig.treasury = { privateKey: '' };
      }
      fs.writeFileSync(userCfgPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
      console.log('[Pool Config] Created user config with empty private key (secure default)');
    } else {
      // Create minimal default with empty private key
      const safeDefault = {
        treasury: {
          privateKey: '', // SECURITY: Always empty on fresh install
          fee: 1,
          rewarding: {
            paymentThreshold: '400000000'
          }
        },
        stratum: {
          hostName: '0.0.0.0',
          port: 7777,
          difficulty: '1024'
        },
        api: {
          enabled: true,
          port: 8080
        }
      };
      fs.writeFileSync(userCfgPath, JSON.stringify(safeDefault, null, 2), 'utf-8');
      console.log('[Pool Config] Created minimal user config with empty private key (secure default)');
    }
  } catch (err) {
    console.error('[Pool Config] Error ensuring user config:', err.message);
  }
  return userCfgPath;
}
function readPoolConfig() {
  const cfgPath = ensureUserConfig();
  try {
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const config = JSON.parse(raw);
    
    let configModified = false;
    
    // SECURITY: Always ensure treasury.privateKey structure exists
    if (!config.treasury) {
      config.treasury = {};
      configModified = true;
    }
    
    // Validate and clean treasury private key if present
    if (config.treasury.privateKey) {
      const key = String(config.treasury.privateKey).trim();
      
      if (key) {
        // Validate the key format - must be hex string
        if (!/^[0-9a-fA-F]+$/.test(key)) {
          console.warn('[Pool Config] Invalid private key format (contains non-hex characters), clearing...');
          config.treasury.privateKey = '';
          configModified = true;
        } else if (key.length !== 64) {
          // Private keys are typically 32 bytes = 64 hex characters
          console.warn(`[Pool Config] Invalid private key length (${key.length} chars, expected 64), clearing...`);
          config.treasury.privateKey = '';
          configModified = true;
        } else {
          // Validate using Kaspa library to ensure it's a valid secp256k1 key
          try {
            const privateKey = new kaspa.PrivateKey(key);
            const keypair = kaspa.Keypair.fromPrivateKey(privateKey);
            // Key is valid, normalize to lowercase
            config.treasury.privateKey = key.toLowerCase();
            configModified = true;
          } catch (err) {
            console.warn(`[Pool Config] Invalid private key (secp256k1 validation failed): ${err.message}, clearing...`);
            config.treasury.privateKey = '';
            configModified = true;
          }
        }
      } else {
        // Empty key - ensure it's explicitly empty
        config.treasury.privateKey = '';
        configModified = true;
      }
    } else {
      // Ensure treasury.privateKey exists and is empty if not set
      config.treasury.privateKey = '';
      configModified = true;
    }
    
    // Write back if we modified the config (cleared invalid key)
    if (configModified) {
      try {
        fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
        console.log('[Pool Config] Invalid private key cleared from config file');
      } catch (writeErr) {
        console.error('[Pool Config] Failed to save cleaned config:', writeErr.message);
      }
    }
    
    return config;
  } catch (e) {
    return null;
  }
}
function writePoolConfig(partial) {
  const cfgPath = ensureUserConfig();
  const current = readPoolConfig() || {};
  const next = { ...current };
  if (partial && typeof partial === 'object') {
    if (partial.port) {
      next.stratum = next.stratum || {};
      next.stratum.port = Number(partial.port);
    }
    if (partial.difficulty) {
      next.stratum = next.stratum || {};
      next.stratum.difficulty = String(partial.difficulty);
    }
    if (partial.paymentThresholdSompi) {
      next.treasury = next.treasury || {};
      next.treasury.rewarding = next.treasury.rewarding || {};
      next.treasury.rewarding.paymentThreshold = String(partial.paymentThresholdSompi);
    }
    if (typeof partial.treasuryPrivateKey === 'string') {
      const key = partial.treasuryPrivateKey.trim();
      if (key) {
        // Validate the private key before saving
        try {
          const privateKey = new kaspa.PrivateKey(key);
          // Verify it's valid by creating a keypair (this will throw if invalid)
          const keypair = kaspa.Keypair.fromPrivateKey(privateKey);
          // Key is valid, save it - ensure it's trimmed and normalized (lowercase hex)
          next.treasury = next.treasury || {};
          // Normalize to lowercase hex for consistency
          next.treasury.privateKey = key.toLowerCase();
          console.log('[Pool Config] Saved valid treasury private key (length:', key.length, ')');
        } catch (err) {
          throw new Error(`Invalid private key: ${err.message}. Key must be a valid hex-encoded secp256k1 private key.`);
        }
      } else {
        // Empty key - clear it
        next.treasury = next.treasury || {};
        next.treasury.privateKey = '';
      }
    }
  }
  fs.writeFileSync(cfgPath, JSON.stringify(next, null, 2));
  return next;
}

function createWindow() {
  const isWin = process.platform === 'win32';
  const appPath = app.isPackaged ? process.resourcesPath : __dirname;
  const assetsDir = path.join(__dirname, 'assets');
  const packagedAssetsDir = path.join(appPath, 'assets');
  const iconPath = isWin
    ? (require('fs').existsSync(path.join(assetsDir, 'icon.ico'))
        ? path.join(assetsDir, 'icon.ico')
        : path.join(packagedAssetsDir, 'icon.ico'))
    : (require('fs').existsSync(path.join(assetsDir, 'logo.png'))
        ? path.join(assetsDir, 'logo.png')
        : path.join(packagedAssetsDir, 'logo.png'));

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'gui', 'preload.js')
    },
    titleBarStyle: 'default',
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'gui', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    
    // Auto-start node if needed (same as CLI version)
    ensureNodeRunning().then(result => {
      if (result.found === false && result.found !== undefined) {
        mainWindow.webContents.send('node-status-update', {
          status: 'not_found',
          message: 'Kaspa node not found. Please start kaspad.exe manually.'
        });
      } else if (result.started) {
        mainWindow.webContents.send('node-status-update', {
          status: 'starting',
          message: 'Kaspa node is starting...'
        });
      }
    }).catch(err => {
      mainWindow.webContents.send('node-status-update', {
        status: 'error',
        error: err.message
      });
    });
    
    // Initial node status check
    checkNodeStatus().then(status => {
      mainWindow.webContents.send('node-status-update', {
        status: status.connected ? 'connected' : 'disconnected',
        connected: status.connected,
        synced: status.synced,
        peerCount: status.peerCount,
        networkId: status.networkId
      });
    }).catch(err => {
      mainWindow.webContents.send('node-status-update', {
        status: 'error',
        error: err.message
      });
    });
    
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open DevTools for debugging (uncomment to see errors)
  if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
  
  // Also open DevTools when external IP debugging is needed
  // You can remove this after finding the IP field
  mainWindow.webContents.openDevTools();
  
  // Log errors from renderer
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer ${level}]:`, message);
    if (level >= 2) { // Error or warning
      console.log(`  at ${sourceId}:${line}`);
    }
  });
  
  // Log renderer errors
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[Renderer] Failed to load:', errorCode, errorDescription);
  });
}

app.whenReady().then(async () => {
  // Enforce CSP via response headers to avoid meta limitations/warnings
  try {
    const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src http://127.0.0.1:8080 ws://127.0.0.1:17110; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      headers['Content-Security-Policy'] = [csp];
      callback({ responseHeaders: headers });
    });
  } catch (e) {
    console.error('[Electron] Failed to set header CSP:', e);
  }
  console.log('[Electron] App ready, creating window...');
  console.log('[Electron] App path:', app.getAppPath());
  console.log('[Electron] Exec path:', app.getPath('exe'));
  
  // Test if backend modules load correctly
  try {
    console.log('[Electron] Testing backend module loading...');
    console.log('[Electron] Testing getAllSessions...');
    const testSessions = await getAllSessions();
    console.log('[Electron] Backend test successful, found', testSessions ? testSessions.length : 0, 'sessions');
    
    if (!Array.isArray(testSessions)) {
      console.error('[Electron] CRITICAL: getAllSessions returned non-array:', typeof testSessions);
    }
  } catch (error) {
    console.error('[Electron] CRITICAL: Backend module test failed:', error);
    console.error('[Electron] Error stack:', error.stack);
    // Don't exit - allow GUI to show the error
  }
  
  // Initialize backend monitoring
  try {
    console.log('[Electron] Starting monitoring loops...');
    startMonitoring();
    startIntermediateMonitoring(processFinalPayout);
    console.log('[Electron] Monitoring loops started successfully');
  } catch (error) {
    console.error('[Electron] Error starting monitoring:', error);
    console.error('[Electron] Monitoring error stack:', error.stack);
    // Continue anyway - monitoring might start later
  }
  
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Mining Pool process controls
async function startPool(opts = {}) {
  if (poolProcess && !poolProcess.killed && poolStatus.running) {
    return { started: false, message: 'Pool already running', pid: poolProcess.pid };
  }
  // clean any stale reference
  if (poolProcess && (poolProcess.killed || poolStatus.exited)) {
    poolProcess = null;
  }
  
  // Validate treasury private key before starting
  const cfg = readPoolConfig();
  const treasuryKey = cfg?.treasury?.privateKey;
  if (!treasuryKey || typeof treasuryKey !== 'string' || !treasuryKey.trim()) {
    return { 
      started: false, 
      error: 'Treasury private key is required. Please generate or enter a valid private key in the Mining Pool settings.' 
    };
  }
  
  // Validate the key format
  const key = treasuryKey.trim();
  if (key.length !== 64 || !/^[0-9a-fA-F]+$/.test(key)) {
    return { 
      started: false, 
      error: 'Invalid treasury private key format. The key must be a 64-character hex string. Please generate a new key using the Generate button.' 
    };
  }
  
  // Validate using Kaspa library
  try {
    const privateKey = new kaspa.PrivateKey(key);
    const keypair = kaspa.Keypair.fromPrivateKey(privateKey);
    // Validation passed
  } catch (err) {
    return { 
      started: false, 
      error: `Invalid treasury private key: ${err.message}. Please generate a new key using the Generate button.` 
    };
  }
  
  const port = Number(opts.port || 7777);
  const cwd = path.join(__dirname, 'pool');
  const bunCmd = process.platform === 'win32' ? 'bun.exe' : 'bun';
  
  // Try to find bun executable
  let bun = bunCmd;
  let bunFound = false;
  
  // Helper function to check if bun exists at a path
  const checkBunPath = (bunPath) => {
    try {
      if (process.platform === 'win32') {
        // First check if file exists
        if (!fs.existsSync(bunPath)) {
          return false;
        }
        // Try to execute bun --version to verify it works
        const { execSync } = require('child_process');
        execSync(`"${bunPath}" --version`, { stdio: 'ignore', timeout: 5000 });
        return true;
      } else {
        // On Unix, check if file exists and is executable
        return fs.existsSync(bunPath) && fs.statSync(bunPath).isFile();
      }
    } catch (e) {
      return false;
    }
  };
  
  // First, try to find bun in PATH or common locations
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      try {
        // On Windows, use 'where' command to find bun in PATH
        const whereOutput = execSync(`where ${bunCmd}`, { stdio: 'pipe', encoding: 'utf8', timeout: 5000 }).trim();
        if (whereOutput) {
          const bunPathFromWhere = whereOutput.split('\n')[0].trim();
          if (bunPathFromWhere && checkBunPath(bunPathFromWhere)) {
            bun = bunPathFromWhere;
            bunFound = true;
            console.log(`[Pool] Found Bun in PATH at: ${bun}`);
          } else if (checkBunPath(bunCmd)) {
            // Try using just the command name
            bun = bunCmd;
            bunFound = true;
            console.log(`[Pool] Found Bun in PATH`);
          }
        }
      } catch (e) {
        // Not in PATH, check common installation locations
        const commonPaths = [
          path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'bun', 'bun.exe'),
          path.join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe'),
          path.join('C:', 'Program Files', 'bun', 'bun.exe'),
          path.join('C:', 'Program Files (x86)', 'bun', 'bun.exe'),
        ];
        
        for (const bunPath of commonPaths) {
          if (checkBunPath(bunPath)) {
            bun = bunPath;
            bunFound = true;
            console.log(`[Pool] Found Bun at: ${bun}`);
            break;
          }
        }
      }
    } else {
      // Unix-like systems: try 'which' command
      try {
        execSync(`which ${bunCmd}`, { stdio: 'ignore' });
        bun = bunCmd;
        bunFound = checkBunPath(bun);
        if (bunFound) {
          console.log(`[Pool] Found Bun in PATH`);
        }
      } catch (e) {
        // Check common Unix locations
        const commonPaths = [
          path.join(process.env.HOME || '', '.bun', 'bin', 'bun'),
          '/usr/local/bin/bun',
          '/opt/bun/bin/bun',
        ];
        
        for (const bunPath of commonPaths) {
          if (checkBunPath(bunPath)) {
            bun = bunPath;
            bunFound = true;
            console.log(`[Pool] Found Bun at: ${bun}`);
            break;
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Pool] Could not verify Bun installation:', err.message);
  }
  
  // If Bun not found, attempt automatic installation
  if (!bunFound) {
    const isPackaged = app.isPackaged;
    console.log(`[Pool] Bun not found, attempting automatic installation... (packaged: ${isPackaged})`);
    console.log('[Pool] This may take 30-60 seconds. Please wait...');
    
    try {
      const { execSync, spawn } = require('child_process');
      
      if (process.platform === 'win32') {
        // Windows: Use PowerShell to install Bun
        console.log('[Pool] Installing Bun via PowerShell...');
        try {
          // Run the installation script
          // Note: In packaged apps, this might require user elevation or fail due to security policies
          console.log('[Pool] Executing Bun installer...');
          
          // Try with different approaches for packaged vs dev
          let installCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"';
          
          // In packaged apps, we might need to handle this differently
          if (isPackaged) {
            // For packaged apps, try running in a way that might work better
            installCommand = 'powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"';
          }
          
          const installOutput = execSync(installCommand, {
            stdio: isPackaged ? 'pipe' : 'pipe', // Always pipe to avoid issues in packaged apps
            timeout: 120000, // 2 minute timeout
            shell: true,
            encoding: 'utf8'
          });
          
          if (installOutput && installOutput.trim()) {
            console.log('[Pool] Installation output:', installOutput.substring(0, 200));
          }
          console.log('[Pool] Bun installation command completed');
          
          // After installation, refresh PATH and check again
          // Bun typically installs to %USERPROFILE%\.bun\bin\bun.exe
          const installedPaths = [
            path.join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe'),
            path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'bun', 'bun.exe'),
          ];
          
          // Wait for installation to complete and files to be written
          console.log('[Pool] Waiting for installation to complete...');
          await new Promise(resolve => setTimeout(resolve, 5000)); // Give it time to download and install
          
          // Try multiple times to find Bun (it might take a moment for files to be written)
          console.log('[Pool] Checking for installed Bun...');
          let foundAfterInstall = false;
          for (let attempt = 0; attempt < 5; attempt++) {
            if (attempt > 0) {
              console.log(`[Pool] Retry ${attempt + 1}/5: Checking for Bun...`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            for (const bunPath of installedPaths) {
              console.log(`[Pool] Checking: ${bunPath}`);
              if (checkBunPath(bunPath)) {
                bun = bunPath;
                bunFound = true;
                foundAfterInstall = true;
                console.log(`[Pool] ✓ Bun installed successfully at: ${bun}`);
                break;
              }
            }
            
            if (foundAfterInstall) break;
            
            // Also try PATH again (Bun installer may add it)
            try {
              const whereOutput = execSync(`where ${bunCmd}`, { stdio: 'pipe', encoding: 'utf8', timeout: 5000 }).trim();
              if (whereOutput) {
                const bunPathFromWhere = whereOutput.split('\n')[0].trim();
                if (bunPathFromWhere && checkBunPath(bunPathFromWhere)) {
                  bun = bunPathFromWhere;
                  bunFound = true;
                  foundAfterInstall = true;
                  console.log(`[Pool] ✓ Bun found in PATH after installation: ${bun}`);
                  break;
                } else if (checkBunPath(bunCmd)) {
                  bun = bunCmd;
                  bunFound = true;
                  foundAfterInstall = true;
                  console.log(`[Pool] ✓ Bun found in PATH after installation`);
                  break;
                }
              }
            } catch (e) {
              // Still not found, continue to next attempt
            }
          }
          
          if (!bunFound) {
            const errorMsg = isPackaged 
              ? `Bun installation attempted but not found afterward.\n\n` +
                `For packaged applications, automatic installation may be blocked by security policies.\n\n` +
                `Please install Bun manually:\n` +
                `1. Open PowerShell as Administrator\n` +
                `2. Run: powershell -c "irm bun.sh/install.ps1 | iex"\n` +
                `3. Restart this application\n\n` +
                `Alternatively, download Bun from: https://bun.sh/install`
              : `Bun installation attempted but not found afterward. Please restart the application or manually install Bun from https://bun.sh/install`;
            
            return {
              started: false,
              error: errorMsg
            };
          }
        } catch (installErr) {
          console.error('[Pool] Bun installation failed:', installErr.message);
          const errorMsg = isPackaged
            ? `Failed to automatically install Bun (packaged app).\n\n` +
              `Automatic installation may be blocked in packaged applications.\n\n` +
              `Please install Bun manually:\n` +
              `1. Open PowerShell as Administrator\n` +
              `2. Run: powershell -c "irm bun.sh/install.ps1 | iex"\n` +
              `3. Restart this application\n\n` +
              `Error: ${installErr.message}\n\n` +
              `Download Bun from: https://bun.sh/install`
            : `Failed to automatically install Bun: ${installErr.message}\n\n` +
              `Please install Bun manually:\n  powershell -c "irm bun.sh/install.ps1 | iex"`;
          
          return {
            started: false,
            error: errorMsg
          };
        }
      } else {
        // Unix-like: Use curl to install Bun
        console.log('[Pool] Installing Bun via curl...');
        try {
          execSync('curl -fsSL https://bun.sh/install | bash', {
            stdio: 'inherit',
            timeout: 120000, // 2 minute timeout
            shell: true,
            env: { ...process.env, PATH: process.env.PATH }
          });
          
          // After installation, check common location
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          const installedPath = path.join(process.env.HOME || '', '.bun', 'bin', 'bun');
          if (checkBunPath(installedPath)) {
            bun = installedPath;
            bunFound = true;
            console.log(`[Pool] Bun installed successfully at: ${bun}`);
          } else {
            // Try PATH again
            try {
              execSync(`which ${bunCmd}`, { stdio: 'ignore' });
              bun = bunCmd;
              bunFound = checkBunPath(bun);
            } catch (e) {
              return {
                started: false,
                error: `Bun installation attempted but not found afterward. Please restart your terminal or run: source ~/.bashrc`
              };
            }
          }
        } catch (installErr) {
          console.error('[Pool] Bun installation failed:', installErr.message);
          return {
            started: false,
            error: `Failed to automatically install Bun: ${installErr.message}\n\nPlease install Bun manually:\n  curl -fsSL https://bun.sh/install | bash`
          };
        }
      }
    } catch (err) {
      console.error('[Pool] Error during Bun installation:', err.message);
      const errorMsg = app.isPackaged
        ? `Bun runtime not found and automatic installation failed.\n\n` +
          `For fresh installs on packaged applications, Bun must be installed manually:\n\n` +
          `Windows Installation:\n` +
          `1. Open PowerShell as Administrator (Right-click → Run as Administrator)\n` +
          `2. Run: powershell -c "irm bun.sh/install.ps1 | iex"\n` +
          `3. Restart this application\n\n` +
          `Or download from: https://bun.sh/install\n\n` +
          `Error: ${err.message}`
        : `Bun runtime not found and automatic installation failed. Please install Bun manually from https://bun.sh/install\n\nError: ${err.message}`;
      
      return {
        started: false,
        error: errorMsg
      };
    }
  }
  
  // Persist desired config before start
  try {
    writePoolConfig({
      port,
      difficulty: opts.difficulty,
      paymentThresholdSompi: opts.paymentThresholdSompi
    });
    
    // CRITICAL: Copy user config to pool directory so the pool can read it
    // The pool reads from ./config.json relative to its directory
    const userConfigPath = ensureUserConfig();
    const poolConfigPath = path.join(cwd, 'config.json');
    
    // Ensure the user config is up to date and has the validated private key
    const userConfig = readPoolConfig();
    
    // Write the user config to the pool directory
    if (userConfig) {
      // Ensure private key is trimmed and properly formatted
      if (userConfig.treasury && userConfig.treasury.privateKey) {
        userConfig.treasury.privateKey = String(userConfig.treasury.privateKey).trim().toLowerCase();
        console.log('[Pool] Treasury private key length:', userConfig.treasury.privateKey.length);
        console.log('[Pool] Treasury private key valid format:', /^[0-9a-f]{64}$/.test(userConfig.treasury.privateKey));
      }
      fs.writeFileSync(poolConfigPath, JSON.stringify(userConfig, null, 2), 'utf-8');
      console.log('[Pool] Copied user config to pool directory at:', poolConfigPath);
    } else {
      console.warn('[Pool] No user config found, pool will use default config.json');
    }
  } catch (err) {
    console.error('[Pool] Failed to write config:', err.message);
    return { started: false, error: `Failed to write pool config: ${err.message}` };
  }
  
  // Final verification that we have a valid Bun executable
  if (!bunFound) {
    return {
      started: false,
      error: `Bun runtime not found and automatic installation was not successful. Please install Bun manually from https://bun.sh/install\n\nWindows: Open PowerShell and run:\n  powershell -c "irm bun.sh/install.ps1 | iex"`
    };
  }
  
  // Verify bun is executable (for full paths)
  if (bun !== bunCmd && !fs.existsSync(bun)) {
    console.warn(`[Pool] Bun path ${bun} does not exist, trying from PATH...`);
    bun = bunCmd;
    bunFound = checkBunPath(bun);
    if (!bunFound) {
      return {
        started: false,
        error: `Bun executable not found at expected location. Please restart the application after installing Bun.`
      };
    }
  }
  
  const entry = path.join(cwd, 'index.ts');
  const args = ['run', entry];
  try {
    console.log(`[Pool] Starting pool with Bun: ${bun}`);
    poolProcess = spawn(bun, args, { cwd, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    let errorMsg = `Failed to start pool: ${e.message}`;
    if (e.code === 'ENOENT') {
      errorMsg = `Bun runtime not found at "${bun}". Automatic installation may have failed. Please install Bun manually from https://bun.sh/install\n\nWindows: Open PowerShell and run:\n  powershell -c "irm bun.sh/install.ps1 | iex"`;
    }
    return { started: false, error: errorMsg };
  }
  poolStatus = { running: true, pid: poolProcess.pid, port, output: '', exited: false, exitCode: null };
  poolProcess.stdout.on('data', (d) => {
    const raw = d.toString();
    const cleaned = stripAnsi(raw);
    const msg = emphasizeIfImportant(cleaned);
    poolStatus.output = (poolStatus.output + msg).slice(-MAX_LOG_CHARS);
    console.log('[POOL]', cleaned.trim());
  });
  poolProcess.stderr.on('data', (d) => {
    const raw = d.toString();
    const cleaned = stripAnsi(raw);
    const msg = emphasizeIfImportant(cleaned);
    poolStatus.output = (poolStatus.output + msg).slice(-MAX_LOG_CHARS);
    console.error('[POOL-ERR]', cleaned.trim());
  });
  poolProcess.on('exit', (code, signal) => {
    poolStatus.running = false;
    poolStatus.pid = null;
    poolStatus.exited = true;
    poolStatus.exitCode = code;
    console.log('[POOL] exited', code, signal);
    poolProcess = null;
  });
  return { started: true, pid: poolProcess.pid, port };
}

function stopPool() {
  if (!poolProcess || poolProcess.killed) {
    return { stopped: false, message: 'Pool is not running' };
  }
  try {
    poolProcess.kill();
    poolStatus.running = false;
    poolStatus.pid = null;
    poolStatus.exited = true;
    poolProcess = null;
    return { stopped: true };
  } catch (e) {
    return { stopped: false, error: e.message };
  }
}

ipcMain.handle('pool:start', async (event, opts) => {
  try {
    const res = await startPool(opts || { port: 7777 });
    return { success: !res.error, ...res };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('pool:stop', async () => {
  try {
    const res = stopPool();
    return { success: !res.error, ...res };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('pool:status', async () => {
  return { success: true, status: poolStatus };
});

ipcMain.handle('pool:config:get', async () => {
  const cfg = readPoolConfig();
  return { success: Boolean(cfg), config: cfg };
});

ipcMain.handle('pool:config:update', async (event, partial) => {
  try {
    const next = writePoolConfig(partial || {});
    return { success: true, config: next };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('pool:generate-keypair', async () => {
  try {
    // Generate a new random keypair
    const keypair = kaspa.Keypair.random();
    const address = keypair.toAddress(KASPA_NETWORK).toString();
    // keypair.privateKey already returns a hex string (see kaspa.js line 4094)
    const privateKeyHex = keypair.privateKey;
    
    // Validate the generated key to ensure it's correct format
    if (!privateKeyHex || typeof privateKeyHex !== 'string') {
      throw new Error('Failed to get private key hex string');
    }
    
    // Verify it's a valid private key by creating a PrivateKey object
    const testKey = new kaspa.PrivateKey(privateKeyHex);
    const testKeypair = kaspa.Keypair.fromPrivateKey(testKey);
    const testAddress = testKeypair.toAddress(KASPA_NETWORK).toString();
    
    // Verify address matches
    if (testAddress !== address) {
      throw new Error('Generated keypair validation failed: address mismatch');
    }
    
    return {
      success: true,
      address: address,
      privateKey: privateKeyHex
    };
  } catch (error) {
    console.error('[IPC] pool:generate-keypair error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('pool:force-payout-all', async () => {
  try {
    // Check if pool is running
    if (!poolStatus.running) {
      return { success: false, error: 'Mining pool is not running. Please start the pool first.' };
    }
    
    const http = require('http');
    const apiPort = 8080; // Default mining pool API port
    
    return new Promise((resolve) => {
      const options = {
        hostname: '127.0.0.1',
        port: apiPort,
        path: '/payouts/force-all',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      };
      
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (!data || data.trim() === '') {
              if (res.statusCode !== 200) {
                resolve({ success: false, error: `Pool API returned status ${res.statusCode} with empty body` });
              } else {
                resolve({ success: false, error: 'Empty response from pool API. Is the pool running?' });
              }
              return;
            }
            
            const result = JSON.parse(data);
            
            // If status is not 200, try to extract error message from response
            if (res.statusCode !== 200) {
              console.error(`[IPC] Pool API returned status ${res.statusCode}:`, data);
              const errorMsg = result.error || result.message || `Pool API returned status ${res.statusCode}`;
              resolve({ success: false, error: errorMsg });
              return;
            }
            
            // Success response
            resolve({ success: result.success !== false, ...result });
          } catch (e) {
            console.error('[IPC] Failed to parse pool API response:', e.message, 'Response:', data.substring(0, 200));
            const statusMsg = res.statusCode !== 200 ? ` (Status: ${res.statusCode})` : '';
            resolve({ success: false, error: `Invalid response from pool API: ${e.message}${statusMsg}${data ? ' (Response: ' + data.substring(0, 100) + '...)' : ''}` });
          }
        });
      });
      
      req.on('error', (error) => {
        console.error('[IPC] Pool API request error:', error.message, 'Code:', error.code);
        if (error.code === 'ECONNREFUSED' || error.code === 'EADDRNOTAVAIL') {
          resolve({ success: false, error: 'Pool API is not running. Please start the mining pool first.' });
        } else if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
          resolve({ success: false, error: 'Pool API request timed out. The pool may not be responding.' });
        } else {
          resolve({ success: false, error: `Pool API error: ${error.message} (${error.code || 'unknown'})` });
        }
      });
      
      // Set request timeout (30 seconds for force payout - may take longer)
      req.setTimeout(30000, () => {
        req.destroy();
        console.error('[IPC] Pool API request timeout');
        resolve({ success: false, error: 'Pool API request timed out. The pool may not be responding.' });
      });
      
      req.end();
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC Handlers - Miner Payment Settings
ipcMain.handle('pool:miner:update-payment-interval', async (event, { address, intervalHours, verificationIP }) => {
  try {
    // Check if pool is running
    if (!poolStatus.running) {
      return { success: false, error: 'Mining pool is not running. Please start the pool first.' };
    }
    
    const http = require('http');
    const apiPort = 8080; // Default mining pool API port
    
    return new Promise((resolve) => {
      const postData = JSON.stringify({
        address,
        intervalHours: intervalHours !== null && intervalHours !== undefined ? Number(intervalHours) : null,
        verificationIP
      });
      
      const options = {
        hostname: '127.0.0.1',
        port: apiPort,
        path: '/miner/update-payment-interval',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (!data || data.trim() === '') {
              if (res.statusCode !== 200) {
                resolve({ success: false, error: `Pool API returned status ${res.statusCode} with empty body` });
              } else {
                resolve({ success: false, error: 'Empty response from pool API. Is the pool running?' });
              }
              return;
            }
            
            const result = JSON.parse(data);
            
            // If status is not 200, try to extract error message from response
            if (res.statusCode !== 200) {
              console.error(`[IPC] Pool API returned status ${res.statusCode}:`, data);
              const errorMsg = result.error || result.message || `Pool API returned status ${res.statusCode}`;
              resolve({ success: false, error: errorMsg });
              return;
            }
            
            // Success response - use result.success if present, otherwise assume true for 200 status
            resolve({ success: result.success !== false, ...result });
          } catch (e) {
            console.error('[IPC] Failed to parse pool API response:', e.message, 'Response:', data.substring(0, 200));
            const statusMsg = res.statusCode !== 200 ? ` (Status: ${res.statusCode})` : '';
            resolve({ success: false, error: `Invalid response from pool API: ${e.message}${statusMsg}${data ? ' (Response: ' + data.substring(0, 100) + '...)' : ''}` });
          }
        });
      });
      
      req.on('error', (error) => {
        console.error('[IPC] Pool API request error:', error.message, 'Code:', error.code);
        if (error.code === 'ECONNREFUSED' || error.code === 'EADDRNOTAVAIL') {
          resolve({ success: false, error: 'Pool API is not running. Please start the mining pool first.' });
        } else if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
          resolve({ success: false, error: 'Pool API request timed out. The pool may not be responding.' });
        } else {
          resolve({ success: false, error: `Pool API error: ${error.message} (${error.code || 'unknown'})` });
        }
      });
      
      // Set request timeout (5 seconds)
      req.setTimeout(5000, () => {
        req.destroy();
        console.error('[IPC] Pool API request timeout');
        resolve({ success: false, error: 'Pool API request timed out. The pool may not be responding.' });
      });
      
      req.write(postData);
      req.end();
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('pool:miner:get', async (event, { address }) => {
  try {
    // Check if pool is running
    if (!poolStatus.running) {
      return { success: false, error: 'Mining pool is not running. Please start the pool first.' };
    }
    
    const http = require('http');
    const apiPort = 8080; // Default mining pool API port
    
    return new Promise((resolve) => {
      const options = {
        hostname: '127.0.0.1',
        port: apiPort,
        path: `/miner?address=${encodeURIComponent(address)}`,
        method: 'GET'
      };
      
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          // Check if we got a successful response
          if (res.statusCode !== 200) {
            console.error(`[IPC] Pool API returned status ${res.statusCode}:`, data);
            resolve({ success: false, error: `Pool API returned status ${res.statusCode}${data ? ': ' + data.substring(0, 200) : ''}` });
            return;
          }
          
          try {
            if (!data || data.trim() === '') {
              resolve({ success: false, error: 'Empty response from pool API. Is the pool running?' });
              return;
            }
            const result = JSON.parse(data);
            resolve({ success: true, miner: result });
          } catch (e) {
            console.error('[IPC] Failed to parse pool API response:', e.message, 'Response:', data.substring(0, 200));
            resolve({ success: false, error: `Invalid response from pool API: ${e.message}${data ? ' (Response: ' + data.substring(0, 100) + '...)' : ''}` });
          }
        });
      });
      
      req.on('error', (error) => {
        console.error('[IPC] Pool API request error:', error.message);
        if (error.code === 'ECONNREFUSED') {
          resolve({ success: false, error: 'Pool API is not running. Please start the mining pool first.' });
        } else {
          resolve({ success: false, error: `Pool API error: ${error.message}` });
        }
      });
      
      req.end();
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC Handlers - Session Management
ipcMain.handle('session:create', async (event, { destinations, amount }) => {
  try {
    console.log('[IPC] session:create called', { destinations, amount });
    const session = await createSession(destinations, amount);
    console.log('[IPC] session:create success', session.id);
    // Remove private keys for security
    const { depositPrivateKey, intermediatePrivateKey, ...publicSession } = session;
    return { success: true, session: publicSession };
  } catch (error) {
    console.error('[IPC] session:create error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('session:get', async (event, sessionId) => {
  try {
    console.log('[IPC] session:get called', sessionId);
    const session = await getSession(sessionId);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }
    // Remove private keys for security
    const { depositPrivateKey, intermediatePrivateKey, ...publicSession } = session;
    return { success: true, session: publicSession };
  } catch (error) {
    console.error('[IPC] session:get error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('session:list', async () => {
  try {
    console.log('[IPC] session:list called');
    const sessions = await getAllSessions();
    console.log('[IPC] session:list found', sessions ? sessions.length : 0, 'sessions');
    
    if (!sessions || !Array.isArray(sessions)) {
      console.error('[IPC] session:list - sessions is not an array:', typeof sessions);
      return { success: false, error: 'Invalid sessions data format' };
    }
    
    const result = { 
      success: true, 
      sessions: sessions.map(({ sessionId, session }) => {
        if (!session) {
          console.warn('[IPC] session:list - null session for', sessionId);
          return { sessionId, session: { status: 'unknown' } };
        }
        const { depositPrivateKey, intermediatePrivateKey, ...publicSession } = session;
        return { sessionId, session: publicSession };
      })
    };
    console.log('[IPC] session:list returning', result.sessions.length, 'sessions');
    return result;
  } catch (error) {
    console.error('[IPC] session:list error:', error);
    console.error('[IPC] session:list error stack:', error.stack);
    return { success: false, error: error.message, stack: error.stack };
  }
});

ipcMain.handle('session:delete', async (event, sessionId) => {
  try {
    await deleteSession(sessionId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('session:export-keys', async (event, sessionId) => {
  try {
    const session = await getSession(sessionId);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }
    return {
      success: true,
      keys: {
        depositPrivateKey: session.depositPrivateKey?.toString() || null,
        intermediatePrivateKey: session.intermediatePrivateKey?.toString() || null,
        depositAddress: session.depositAddress,
        intermediateAddress: session.intermediateAddress
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC Handlers - Wallet Management
ipcMain.handle('wallet:import', async (event, privateKeyHex) => {
  try {
    const wallet = importPrivateKey(privateKeyHex);
    return { success: true, wallet };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('wallet:import-mnemonic', async (event, { mnemonic, passphrase }) => {
  try {
    const wallet = importMnemonic(mnemonic, passphrase || '');
    return { success: true, wallet };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('wallet:generate-addresses-kpub', async (event, { kpub, startIndex, count }) => {
  try {
    const result = generateAddressesFromKPUB(kpub, startIndex || 0, count || 10);
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('wallet:detect-kpub-format', async (event, extendedKey) => {
  try {
    const formatInfo = detectKPUBFormat(extendedKey);
    return { success: true, formatInfo };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('wallet:detect-wallet-type', async (event, { extendedKey, mnemonic }) => {
  try {
    const walletInfo = detectWalletType(extendedKey, mnemonic || null);
    return { success: true, walletInfo };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('wallet:info', () => {
  try {
    const wallet = getWalletInfo();
    return { success: true, wallet };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('wallet:balance', async () => {
  try {
    const balance = await getWalletBalance();
    return {
      success: true,
      balance: {
        total: balance.total,
        confirmed: balance.confirmed,
        unconfirmed: balance.unconfirmed,
        mature: balance.mature || 0,
        utxoCount: balance.utxoCount || 0,
        lastUpdated: balance.lastUpdated || Date.now()
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('wallet:transaction-history', async (event, { limit, offset }) => {
  try {
    const result = await getWalletTransactionHistory(limit || 50, offset || 0);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('wallet:estimate-fee', async (event, { address, amountKAS }) => {
  try {
    const estimate = await estimateTransactionFee(address, amountKAS);
    return { success: true, estimate };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('wallet:send', async (event, { address, amountKAS }) => {
  try {
    const result = await sendFromWallet(address, amountKAS);
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('wallet:remove', () => {
  try {
    const removed = removeWallet();
    return { success: true, removed };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC Handlers - Address Book
ipcMain.handle('wallet:addressbook:list', () => {
  try {
    const addresses = getAddressBook();
    return { success: true, addresses };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('wallet:addressbook:add', async (event, { address, label, category }) => {
  try {
    const entry = addAddressToBook(address, label, category);
    return { success: true, entry };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('wallet:addressbook:update', async (event, { id, updates }) => {
  try {
    const entry = updateAddressInBook(id, updates);
    return { success: true, entry };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('wallet:addressbook:remove', async (event, { id }) => {
  try {
    const removed = removeAddressFromBook(id);
    return { success: true, removed };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC Handlers - Node Status
ipcMain.handle('node:status', async () => {
  try {
    const status = await checkNodeStatus();
    return { success: true, status };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('node:start', async () => {
  try {
    const result = await ensureNodeRunning();
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get node mode (public/private)
ipcMain.handle('node:get-mode', async () => {
  try {
    const mode = getNodeMode();
    return { success: true, mode };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Set node mode and restart if needed
ipcMain.handle('node:set-mode', async (event, { mode }) => {
  try {
    if (mode !== 'public' && mode !== 'private') {
      return { success: false, error: 'Mode must be "public" or "private"' };
    }
    
    const currentMode = getNodeMode();
    setNodeMode(mode);
    
    // Update bat file if it exists (use same path resolution as node-starter)
    const fs = require('fs');
    const path = require('path');
    let baseDir;
    let candidatePaths = [];
    
    if (typeof require !== 'undefined') {
      try {
        const { app } = require('electron');
        if (app) {
          // In Electron: use install dir for packaged, app path for dev
          baseDir = app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
          candidatePaths.push(path.join(baseDir, 'start-kaspad.bat'));
          // Also check resources path (electron-builder extraResources)
          const resourcesPath = app.isPackaged ? process.resourcesPath : undefined;
          if (resourcesPath) {
            candidatePaths.push(path.join(resourcesPath, 'start-kaspad.bat'));
          }
        }
      } catch (_) {}
    }
    if (!baseDir) {
      baseDir = path.join(__dirname);
    }
    
    // Find existing bat file or use base directory
    const batPath = candidatePaths.find(p => p && fs.existsSync(p)) || path.join(baseDir, 'start-kaspad.bat');
    
    // Update or create bat file with new mode
    const batContent = generateBatContent(mode === 'public');
    fs.writeFileSync(batPath, batContent, 'utf8');
    console.log(`Updated start-kaspad.bat for ${mode} mode at ${batPath}`);
    
    // If mode changed and node is running, restart it
    if (currentMode !== mode) {
      const { isKaspadRunning } = require('./lib/node-starter');
      const isRunning = await isKaspadRunning();
      if (isRunning) {
        // Restart node with new mode
        const result = await restartNode(mode);
        return { success: true, mode, restarted: true, result };
      }
    }
    
    return { success: true, mode, restarted: false };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Restart node (force restart regardless of mode change)
ipcMain.handle('node:restart', async () => {
  try {
    const mode = getNodeMode();
    const result = await restartNode(mode);
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get port information for display
ipcMain.handle('node:get-port-info', async () => {
  try {
    const { KASPA_NODE_URL } = require('./lib/config');
    const net = require('net');
    
    // Standard Kaspa node ports (from start-kaspad.bat)
    const STANDARD_GRPC_PORT = 16110;  // HTTP/GRPC RPC
    const STANDARD_P2P_PORT = 16111;   // P2P Server
    const STANDARD_WRPC_PORT = 17110;  // WebSocket RPC (Borsh)
    
    // Parse WebSocket RPC port from KASPA_NODE_URL (e.g., ws://127.0.0.1:17110)
    let wrpcPort = STANDARD_WRPC_PORT; // Default
    if (KASPA_NODE_URL) {
      const urlMatch = KASPA_NODE_URL.match(/:(\d+)/);
      if (urlMatch) {
        wrpcPort = parseInt(urlMatch[1], 10);
      }
    }
    
    // Check if ports are actually listening (optional verification)
    const checkPort = (port) => {
      return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(500);
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.once('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.connect(port, '127.0.0.1');
      });
    };
    
    // Check all node ports in parallel (non-blocking, fast timeout)
    const [grpcListening, p2pListening, wrpcListening] = await Promise.all([
      checkPort(STANDARD_GRPC_PORT),
      checkPort(STANDARD_P2P_PORT),
      checkPort(wrpcPort)
    ]);
    
    // Get pool status
    const poolRunning = poolStatus.running;
    const poolPort = poolStatus.port || null;
    const apiPort = poolRunning ? 8080 : null; // Default API port from pool config
    
    return {
      success: true,
      // Node ports (standard)
      grpcPort: STANDARD_GRPC_PORT,
      p2pPort: STANDARD_P2P_PORT,
      wrpcPort: wrpcPort,
      // Port listening status
      grpcListening,
      p2pListening,
      wrpcListening,
      // Pool ports
      poolPort,
      apiPort,
      poolRunning
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get local IPv4 address
ipcMain.handle('system:getLocalIp', async () => {
  try {
    const interfaces = os.networkInterfaces();
    // Find the first non-internal IPv4 address (prefer non-127.x.x.x addresses)
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // Skip internal (loopback) and non-IPv4 addresses
        if (iface.family === 'IPv4' && !iface.internal) {
          return { success: true, ip: iface.address };
        }
      }
    }
    // Fallback to first IPv4 address if no external found
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4') {
          return { success: true, ip: iface.address };
        }
      }
    }
    return { success: false, error: 'No IPv4 address found' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Generate QR code data URL
ipcMain.handle('qrcode:toDataURL', async (event, { text, options = {} }) => {
  try {
    const defaultOptions = {
      width: options.width || 200,
      margin: options.margin || 2,
      color: {
        dark: options.color?.dark || '#000000',
        light: options.color?.light || '#FFFFFF'
      },
      errorCorrectionLevel: options.errorCorrectionLevel || 'M'
    };
    
    const dataURL = await QRCode.toDataURL(text, defaultOptions);
    return { success: true, dataURL };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Send real-time updates to GUI
const statusUpdateInterval = setInterval(async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      // Update sessions
      const sessions = await getAllSessions();
      const sessionsData = sessions.map(({ sessionId, session }) => {
        const { depositPrivateKey, intermediatePrivateKey, ...publicSession } = session;
        return { sessionId, session: publicSession };
      });
      mainWindow.webContents.send('sessions-update', sessionsData);
      
      // Update node status periodically
      try {
        const nodeStatus = await checkNodeStatus();
        mainWindow.webContents.send('node-status-update', {
          status: nodeStatus.connected ? 'connected' : 'disconnected',
          connected: nodeStatus.connected,
          synced: nodeStatus.synced,
          peerCount: nodeStatus.peerCount,
          networkId: nodeStatus.networkId,
          healthy: nodeStatus.healthy
        });
      } catch (err) {
        // Ignore node status errors in update loop
      }
    } catch (error) {
      // Ignore errors in update loop
    }
  }
}, 10000); // Update every 10 seconds

// Cleanup on app quit
app.on('before-quit', () => {
  if (statusUpdateInterval) {
    clearInterval(statusUpdateInterval);
  }
});

