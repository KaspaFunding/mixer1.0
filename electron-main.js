// Electron main process - GUI entry point

const { app, BrowserWindow, ipcMain, session } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureNodeRunning } = require('./lib/node-starter');

// Import backend modules
const { createSession, getSession, getAllSessions } = require('./lib/session-manager');
const { deleteSession } = require('./lib/database');
const { checkNodeStatus } = require('./lib/rpc-client');
const { importPrivateKey, getWalletInfo, getWalletBalance, sendFromWallet, removeWallet } = require('./lib/wallet');
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
    if (fs.existsSync(userCfgPath)) return userCfgPath;
    const userDir = path.dirname(userCfgPath);
    fs.mkdirSync(userDir, { recursive: true });
    // Source default from app resources
    const defaultCfgPath = path.join(__dirname, 'pool', 'config.json');
    if (fs.existsSync(defaultCfgPath)) {
      fs.copyFileSync(defaultCfgPath, userCfgPath);
    } else {
      // Create minimal default
      fs.writeFileSync(userCfgPath, JSON.stringify({}, null, 2));
    }
  } catch (_) {}
  return userCfgPath;
}
function readPoolConfig() {
  const cfgPath = ensureUserConfig();
  try {
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    return JSON.parse(raw);
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
      next.treasury = next.treasury || {};
      next.treasury.privateKey = partial.treasuryPrivateKey;
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
function startPool(opts = {}) {
  if (poolProcess && !poolProcess.killed && poolStatus.running) {
    return { started: false, message: 'Pool already running', pid: poolProcess.pid };
  }
  // clean any stale reference
  if (poolProcess && (poolProcess.killed || poolStatus.exited)) {
    poolProcess = null;
  }
  const port = Number(opts.port || 7777);
  const cwd = path.join(__dirname, 'pool');
  const bunCmd = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const bun = bunCmd; // assume in PATH; otherwise user should install Bun
  // Persist desired config before start
  try {
    writePoolConfig({
      port,
      difficulty: opts.difficulty,
      paymentThresholdSompi: opts.paymentThresholdSompi
    });
  } catch (_) {}
  const entry = path.join(cwd, 'index.ts');
  const args = ['run', entry];
  try {
    poolProcess = spawn(bun, args, { cwd, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { started: false, error: `Failed to start pool: ${e.message}` };
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
    const res = startPool(opts || { port: 7777 });
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
        confirmed: Number(balance.confirmed) / 1e8,
        unconfirmed: Number(balance.unconfirmed) / 1e8,
        total: Number(balance.total) / 1e8,
        utxoCount: balance.utxoCount
      }
    };
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

