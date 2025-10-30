// Renderer process - GUI logic

var electronAPI = window.electronAPI;

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab;
    
    // Update buttons
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // Update content
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`${tabName}-tab`).classList.add('active');
    
    // Load tab data
    if (tabName === 'sessions') {
      loadSessions();
    } else if (tabName === 'wallet') {
      checkWalletStatus();
  } else if (tabName === 'pool') {
    refreshPoolStatus();
    }
  });
});

// Status message helper
function showMessage(text, type = 'info') {
  const msg = document.getElementById('status-message');
  msg.textContent = text;
  msg.className = `status-message ${type}`;
  setTimeout(() => {
    msg.classList.add('hidden');
  }, 5000);
}

// Sessions Tab
async function loadSessions() {
  const list = document.getElementById('sessions-list');
  const debugInfo = document.getElementById('debug-info');
  const debugContent = document.getElementById('debug-content');
  
  list.innerHTML = '<div class="loading">Loading sessions...</div>';
  
  try {
    console.log('[GUI] Calling session:list...');
    
    // Check if electronAPI is available
    if (!window.electronAPI) {
      const error = 'electronAPI not available - preload script may not have loaded';
      console.error('[GUI]', error);
      list.innerHTML = `<div class="error">${error}<br>Please check DevTools console.</div>`;
      debugInfo.classList.remove('hidden');
      debugContent.textContent = 'Error: electronAPI is undefined\n\nPossible causes:\n- Preload script failed to load\n- Context isolation issue\n- Check DevTools console for details';
      return;
    }
    
    const result = await electronAPI.session.list();
    console.log('[GUI] session:list result:', result);
    
    debugInfo.classList.remove('hidden');
    debugContent.textContent = JSON.stringify(result, null, 2);
    
    if (!result) {
      const error = 'No result returned from session:list';
      console.error('[GUI]', error);
      list.innerHTML = `<div class="error">${error}</div>`;
      return;
    }
    
    if (!result.success) {
      console.error('[GUI] session:list failed:', result.error);
      list.innerHTML = `<div class="error">Error: ${result.error}${result.stack ? '<br><br><small>Stack:<br>' + result.stack.replace(/\n/g, '<br>') + '</small>' : ''}</div>`;
      showMessage(`Failed to load sessions: ${result.error}`, 'error');
      return;
    }
    
    if (!result.sessions || result.sessions.length === 0) {
      list.innerHTML = '<div class="loading">No sessions found. Create a new session to get started!</div>';
      debugContent.textContent = 'No sessions found. This is normal if you haven\'t created any sessions yet.';
      return;
    }
    
    // Clear existing ETA timers before re-rendering
    if (window.__etaTimers) {
      Object.values(window.__etaTimers).forEach((t) => { try { clearInterval(t); } catch {} });
    }
    window.__etaTimers = {};

    list.innerHTML = result.sessions.map(({ sessionId, session }) => `
      <div class="session-card">
        <div class="session-header">
          <div>
            <div class="session-id">${sessionId.substring(0, 16)}...</div>
            <span class="status-badge status-${session.status}">${session.status.replace('_', ' ')}</span>
          </div>
        </div>
        <div class="session-details">
          <div class="detail-row">
            <span class="detail-label">Deposit Address:</span>
            <span class="address-display">${session.depositAddress}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Amount:</span>
            <span>${(session.amount / 1e8).toFixed(8)} KAS</span>
          </div>
          ${session.intermediateAddress ? `
            <div class="detail-row">
              <span class="detail-label">Intermediate:</span>
              <span class="address-display">${session.intermediateAddress}</span>
            </div>
          ` : ''}
          ${session.payoutTxIds && session.payoutTxIds.length > 0 ? `
            <div class="detail-row">
              <span class="detail-label">Payout TX:</span>
              <span class="address-display">${session.payoutTxIds[0]}</span>
            </div>
          ` : ''}
          ${session.intermediateConfirmed && session.intermediateDelayUntil ? `
            <div class="detail-row">
              <span class="detail-label">Payout ETA:</span>
              <span id="eta-${sessionId}">calculating...</span>
            </div>
          ` : ''}
        </div>
        <div class="session-actions">
          <button type="button" class="btn btn-secondary" data-action="view" data-id="${sessionId}">View</button>
          <button type="button" class="btn btn-secondary" data-action="export-keys" data-id="${sessionId}">Export Keys</button>
          <button type="button" class="btn btn-danger" data-action="delete" data-id="${sessionId}">Delete</button>
        </div>
      </div>
    `).join('');
    console.log('[GUI] Sessions rendered:', result.sessions.length);

    // Start/update countdown timers for intermediate-confirmed sessions
    (result.sessions || []).forEach(({ sessionId, session }) => {
      if (session && session.intermediateConfirmed && session.intermediateDelayUntil) {
        const etaEl = document.getElementById(`eta-${sessionId}`);
        if (!etaEl) return;
        const update = () => {
          const remainingMs = Number(session.intermediateDelayUntil) - Date.now();
          const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
          const m = Math.floor(seconds / 60);
          const s = seconds % 60;
          const fmt = `${m > 0 ? m + 'm ' : ''}${s}s`;
          etaEl.textContent = `Intermediate confirmed. Will payout after ${fmt}`;
        };
        update();
        window.__etaTimers[sessionId] = setInterval(update, 1000);
      }
    });
  } catch (error) {
    console.error('[GUI] loadSessions error:', error);
    list.innerHTML = `<div class="error">Error: ${error.message}<br><small>Check DevTools console for details</small></div>`;
    showMessage(`Failed to load sessions: ${error.message}`, 'error');
  }
}

window.viewSession = async (sessionId) => {
  const result = await electronAPI.session.get(sessionId);
  if (result.success) {
    alert(`Session Details:\n\nID: ${sessionId}\nStatus: ${result.session.status}\nAmount: ${(result.session.amount / 1e8).toFixed(8)} KAS`);
  } else {
    showMessage(result.error, 'error');
  }
};

window.exportKeys = async (sessionId) => {
  const result = await electronAPI.session.exportKeys(sessionId);
  if (result.success && result.keys) {
    const keys = result.keys;
    const text = `Private Keys for Session ${sessionId}:\n\n` +
      `Deposit Private Key: ${keys.depositPrivateKey || 'N/A'}\n` +
      `Deposit Address: ${keys.depositAddress}\n\n` +
      `Intermediate Private Key: ${keys.intermediatePrivateKey || 'N/A'}\n` +
      `Intermediate Address: ${keys.intermediateAddress || 'N/A'}\n\n` +
      `⚠ WARNING: Keep these keys secure!`;
    alert(text);
  } else {
    showMessage(result.error || 'Failed to export keys', 'error');
  }
};

window.deleteSession = async (sessionId) => {
  if (!confirm('Are you sure you want to delete this session?')) {
    return;
  }
  const result = await electronAPI.session.delete(sessionId);
  if (result.success) {
    showMessage('Session deleted successfully', 'success');
    loadSessions();
  } else {
    showMessage(result.error, 'error');
  }
};

document.getElementById('refresh-sessions').addEventListener('click', loadSessions);

// Event delegation for session action buttons (more robust with CSP/contextIsolation)
const sessionsListEl = document.getElementById('sessions-list');
if (sessionsListEl) {
  sessionsListEl.addEventListener('click', async (ev) => {
    const target = ev.target;
    if (!target || !target.getAttribute) return;
    const action = target.getAttribute('data-action');
    const sessionId = target.getAttribute('data-id');
    if (!action || !sessionId) return;
    if (action === 'view') {
      const result = await electronAPI.session.get(sessionId);
      if (result.success) {
        alert(`Session Details:\n\nID: ${sessionId}\nStatus: ${result.session.status}\nAmount: ${(result.session.amount / 1e8).toFixed(8)} KAS`);
      } else {
        showMessage(result.error, 'error');
      }
    } else if (action === 'export-keys') {
      const result = await electronAPI.session.exportKeys(sessionId);
      if (result.success && result.keys) {
        const keys = result.keys;
        const text = `Private Keys for Session ${sessionId}:\n\n` +
          `Deposit Private Key: ${keys.depositPrivateKey || 'N/A'}\n` +
          `Deposit Address: ${keys.depositAddress}\n\n` +
          `Intermediate Private Key: ${keys.intermediatePrivateKey || 'N/A'}\n` +
          `Intermediate Address: ${keys.intermediateAddress || 'N/A'}\n\n` +
          `⚠ WARNING: Keep these keys secure!`;
        alert(text);
      } else {
        showMessage(result.error || 'Failed to export keys', 'error');
      }
    } else if (action === 'delete') {
      if (!confirm('Are you sure you want to delete this session?')) return;
      const result = await electronAPI.session.delete(sessionId);
      if (result.success) {
        showMessage('Session deleted successfully', 'success');
        loadSessions();
      } else {
        showMessage(result.error, 'error');
      }
    }
  });
}

// Real-time updates
electronAPI.session.onUpdate((sessions) => {
  // Always refresh to keep data current even when tab isn't focused
  loadSessions();
});

// Create Session Tab
let destinationCount = 1;

function updateTotalAmount() {
  const inputs = document.querySelectorAll('.amount-input');
  let total = 0;
  inputs.forEach(input => {
    const value = parseFloat(input.value) || 0;
    total += value;
  });
  document.getElementById('total-amount').textContent = total.toFixed(8);
}

function addDestinationRow() {
  const container = document.getElementById('destinations-container');
  const row = document.createElement('div');
  row.className = 'destination-row';
  row.innerHTML = `
    <input type="text" placeholder="Kaspa address" class="address-input" required>
    <input type="number" step="0.00000001" min="0.00001" placeholder="Amount (KAS)" class="amount-input" required>
    <button type="button" class="btn btn-danger remove-dest">Remove</button>
  `;
  
  row.querySelector('.amount-input').addEventListener('input', updateTotalAmount);
  row.querySelector('.remove-dest').addEventListener('click', () => {
    row.remove();
    updateTotalAmount();
    destinationCount--;
  });
  
  container.appendChild(row);
  destinationCount++;
}

document.getElementById('add-destination').addEventListener('click', () => {
  if (destinationCount < 10) {
    addDestinationRow();
  } else {
    showMessage('Maximum 10 destinations allowed', 'error');
  }
});

document.querySelectorAll('.amount-input').forEach(input => {
  input.addEventListener('input', updateTotalAmount);
});

document.getElementById('create-session-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const rows = document.querySelectorAll('.destination-row');
  const destinations = [];
  
  for (const row of rows) {
    const address = row.querySelector('.address-input').value.trim();
    const amount = parseFloat(row.querySelector('.amount-input').value);
    
    if (!address || isNaN(amount) || amount <= 0) {
      showMessage('Please fill all destination fields correctly', 'error');
      return;
    }
    
    destinations.push({
      address,
      amount: Math.round(amount * 1e8) // Convert to sompi
    });
  }
  
  const totalAmount = destinations.reduce((sum, d) => sum + d.amount, 0);
  
  try {
    const result = await electronAPI.session.create(destinations, totalAmount);
    if (result.success) {
      showMessage(`Session created! Deposit Address: ${result.session.depositAddress}`, 'success');
      // Reset form
      document.getElementById('create-session-form').reset();
      document.getElementById('destinations-container').innerHTML = `
        <div class="destination-row">
          <input type="text" placeholder="Kaspa address" class="address-input" required>
          <input type="number" step="0.00000001" min="0.00001" placeholder="Amount (KAS)" class="amount-input" required>
          <button type="button" class="btn btn-danger remove-dest">Remove</button>
        </div>
      `;
      destinationCount = 1;
      updateTotalAmount();
      // Switch to sessions tab
      document.querySelector('[data-tab="sessions"]').click();
    } else {
      showMessage(result.error, 'error');
    }
  } catch (error) {
    showMessage(error.message, 'error');
  }
});

// Wallet Tab
async function checkWalletStatus() {
  const result = await electronAPI.wallet.info();
  if (result.success && result.wallet) {
    document.getElementById('wallet-not-imported').classList.add('hidden');
    document.getElementById('wallet-imported').classList.remove('hidden');
    document.getElementById('wallet-address').textContent = result.wallet.address;
    loadWalletBalance();
  } else {
    document.getElementById('wallet-not-imported').classList.remove('hidden');
    document.getElementById('wallet-imported').classList.add('hidden');
  }
}

async function loadWalletBalance() {
  try {
    const result = await electronAPI.wallet.balance();
    if (result.success) {
      document.getElementById('balance-amount').textContent = `${result.balance.total.toFixed(8)} KAS`;
    } else {
      document.getElementById('balance-amount').textContent = 'Error';
    }
  } catch (error) {
    document.getElementById('balance-amount').textContent = 'Error';
  }
}

document.getElementById('import-wallet-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const privateKey = document.getElementById('private-key-input').value.trim();
  
  if (!privateKey) {
    showMessage('Please enter a private key', 'error');
    return;
  }
  
  try {
    const result = await electronAPI.wallet.import(privateKey);
    if (result.success) {
      showMessage('Wallet imported successfully!', 'success');
      document.getElementById('private-key-input').value = '';
      checkWalletStatus();
    } else {
      showMessage(result.error, 'error');
    }
  } catch (error) {
    showMessage(error.message, 'error');
  }
});

async function handleWalletRemove() {
  if (!confirm('Are you sure you want to remove your wallet? This will delete the private key.')) {
    return;
  }
  
  try {
    const result = await electronAPI.wallet.remove();
    if (result.success) {
      showMessage('Wallet removed successfully', 'success');
      checkWalletStatus();
    } else {
      showMessage(result.error, 'error');
    }
  } catch (error) {
    showMessage(error.message, 'error');
  }
}

// Bind remove wallet buttons (both header and inline in balance card)
const walletRemoveBtn = document.getElementById('wallet-remove');
if (walletRemoveBtn) walletRemoveBtn.addEventListener('click', handleWalletRemove);
const walletRemoveInlineBtn = document.getElementById('wallet-remove-inline');
if (walletRemoveInlineBtn) walletRemoveInlineBtn.addEventListener('click', handleWalletRemove);

document.getElementById('refresh-balance').addEventListener('click', loadWalletBalance);

// Copy wallet address
const copyBtn = document.getElementById('copy-wallet-address');

if (copyBtn) {
  copyBtn.addEventListener('click', async () => {
    const addr = document.getElementById('wallet-address').textContent.trim();
    try {
      await navigator.clipboard.writeText(addr);
      showMessage('Wallet address copied to clipboard', 'success');
    } catch (e) {
      showMessage('Failed to copy address', 'error');
    }
  });
}

async function openQr(address) {
  if (!qrModal) return;
  // Show modal immediately with loading state
  qrContainer.innerHTML = '<div class="loading">Generating QR...</div>';
  qrAddress.textContent = '';
  qrModal.classList.remove('hidden');
  
  try {
    const size = 256;
    const dataUrl = await (electronAPI.qr?.generateDataUrl?.(address, size));
    qrContainer.innerHTML = '';
    if (!dataUrl) {
      throw new Error('QR generator unavailable');
    }
    const img = document.createElement('img');
    img.alt = 'QR Code';
    img.width = size;
    img.height = size;
    img.src = dataUrl;
    qrContainer.appendChild(img);
    qrAddress.textContent = address;
  } catch (err) {
    qrContainer.innerHTML = 'Failed to render QR code';
  }
}


document.getElementById('send-funds-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const address = document.getElementById('send-address').value.trim();
  const amount = parseFloat(document.getElementById('send-amount').value);
  
  if (!address || isNaN(amount) || amount <= 0) {
    showMessage('Please enter a valid address and amount', 'error');
    return;
  }
  
  try {
    const result = await electronAPI.wallet.send(address, amount);
    if (result.success) {
      showMessage(`Transaction sent! TX: ${result.result.txId}`, 'success');
      document.getElementById('send-funds-form').reset();
      setTimeout(loadWalletBalance, 2000); // Refresh balance after 2 seconds
    } else {
      showMessage(result.error, 'error');
    }
  } catch (error) {
    showMessage(error.message, 'error');
  }
});

// Node Status Management
let nodeStatusData = null;

function updateNodeStatusIndicator(status) {
  const indicator = document.getElementById('node-status-indicator');
  const dot = indicator.querySelector('.status-dot');
  const text = document.getElementById('node-status-text');
  
  if (!status) {
    dot.className = 'status-dot';
    text.textContent = 'Checking...';
    return;
  }
  
  if (status.status === 'connected') {
    dot.className = 'status-dot connected';
    text.textContent = `Connected${status.synced ? ' & Synced' : ' (Syncing...)'} - ${status.peerCount || 0} peers`;
  } else if (status.status === 'disconnected') {
    dot.className = 'status-dot disconnected';
    text.textContent = 'Disconnected';
  } else if (status.status === 'starting') {
    dot.className = 'status-dot starting';
    text.textContent = 'Starting node...';
  } else if (status.status === 'error') {
    dot.className = 'status-dot disconnected';
    text.textContent = 'Error';
  } else {
    dot.className = 'status-dot';
    text.textContent = status.message || 'Unknown';
  }
  
  nodeStatusData = status;
}

// Listen for node status updates
electronAPI.node.onStatusUpdate((status) => {
  updateNodeStatusIndicator(status);
});

document.getElementById('node-status-btn').addEventListener('click', async () => {
  try {
    // Refresh status first
    const result = await electronAPI.node.status();
    
    let statusText = 'Node Status:\n\n';
    if (result.success) {
      const s = result.status;
      statusText += `Connected: ${s.connected ? 'Yes' : 'No'}\n`;
      statusText += `Synced: ${s.synced ? 'Yes' : 'No'}\n`;
      statusText += `Peers: ${s.peerCount || 0}\n`;
      statusText += `Network: ${s.networkId || 'Unknown'}\n`;
      statusText += `Healthy: ${s.healthy ? 'Yes' : 'No'}\n\n`;
      
      if (!s.connected) {
        statusText += 'Click "Start Node" to auto-start kaspad.exe';
      }
    } else {
      statusText += `Error: ${result.error}\n\n`;
      statusText += 'You can try to start the node manually using the button below.';
    }
    
    const startNode = !result.success || !result.status.connected;
    const userChoice = startNode 
      ? confirm(statusText + '\n\nClick OK to try starting the Kaspa node automatically.')
      : alert(statusText);
    
    if (startNode && userChoice) {
      showMessage('Attempting to start Kaspa node...', 'info');
      const startResult = await electronAPI.node.start();
      if (startResult.success) {
        showMessage('Kaspa node is starting. Please wait...', 'info');
        // Status will update automatically via listener
      } else {
        showMessage(`Failed to start node: ${startResult.error}`, 'error');
      }
    }
  } catch (error) {
    showMessage(error.message, 'error');
  }
});

// Initial load
loadSessions();

// Initial node status check
electronAPI.node.status().then(result => {
  if (result.success) {
    updateNodeStatusIndicator({
      status: result.status.connected ? 'connected' : 'disconnected',
      ...result.status
    });
  }
});

// Mining Pool controls
async function refreshPoolStatus() {
  try {
    const res = await electronAPI.pool.status();
    if (res.success && res.status) {
      const s = res.status;
      const statusEl = document.getElementById('pool-status-text');
      if (s.running) {
        statusEl.textContent = `Running (PID ${s.pid}) on :${s.port}`;
      } else if (s.exited) {
        statusEl.textContent = `Stopped (exit code ${s.exitCode ?? 'N/A'})`;
      } else {
        statusEl.textContent = 'Stopped';
      }
      document.getElementById('pool-output').textContent = s.output || '';
      // Fetch live API stats with quick retry to handle startup races
      try {
        let j = null;
        for (let i = 0; i < 5; i++) {
          try {
            const r = await fetch('http://127.0.0.1:8080/status', { cache: 'no-store' });
            if (r.ok) { j = await r.json(); break; }
          } catch (_) {}
          await new Promise(res => setTimeout(res, 400));
        }
        if (j) {
          const miners = Number(j.miners || 0);
          const workers = Number(j.workers || 0);
          document.getElementById('pool-miners').textContent = String(miners);
          document.getElementById('pool-workers').textContent = String(workers);
          document.getElementById('pool-network').textContent = j.networkId || '-';
        }
      } catch (_) {}

      // Update connection help endpoints
      try {
        const port = Number(s.port || document.getElementById('pool-port')?.value || 7777);
        const localEl = document.getElementById('pool-connect-local');
        const lanEl = document.getElementById('pool-connect-lan');
        if (localEl) localEl.textContent = `stratum+tcp://127.0.0.1:${port}`;
        if (lanEl) lanEl.textContent = `stratum+tcp://YOUR_PC_IP:${port}`;
      } catch (_) {}
    }
  } catch (_) {}
}

const poolStartBtn = document.getElementById('pool-start');
const poolStopBtn = document.getElementById('pool-stop');
const poolPortInput = document.getElementById('pool-port');
const poolDiffInput = document.getElementById('pool-difficulty');
const poolThreshKasInput = document.getElementById('pool-threshold-kas');
const poolTreasuryKeyInput = document.getElementById('pool-treasury-key');
const poolSaveKeyBtn = document.getElementById('pool-save-key');
const poolKeyStatus = document.getElementById('pool-key-status');

async function loadPoolConfig() {
  const res = await electronAPI.pool.config.get();
  if (res.success && res.config) {
    const cfg = res.config;
    if (cfg.stratum?.port) poolPortInput.value = cfg.stratum.port;
    if (cfg.stratum?.difficulty) poolDiffInput.value = cfg.stratum.difficulty;
    if (cfg.treasury?.rewarding?.paymentThreshold) {
      const sompi = Number(cfg.treasury.rewarding.paymentThreshold);
      if (!Number.isNaN(sompi)) poolThreshKasInput.value = (sompi / 1e8).toFixed(8);
    }
    if (cfg.treasury?.privateKey && poolKeyStatus) {
      poolKeyStatus.textContent = '(configured)';
      poolKeyStatus.style.color = '#0f5132';
    }
  }
}

if (poolStartBtn) {
  poolStartBtn.addEventListener('click', async () => {
    const port = Number(poolPortInput.value || 7777);
    const difficulty = String(poolDiffInput.value || '1');
    const kas = Number(poolThreshKasInput.value || 0);
    const paymentThresholdSompi = Math.max(0, Math.round(kas * 1e8));
    await electronAPI.pool.config.update({ port, difficulty, paymentThresholdSompi });
    const res = await electronAPI.pool.start({ port, difficulty, paymentThresholdSompi });
    if (res.success && res.started) {
      showMessage(`Pool started on :${res.port}`, 'success');
    } else {
      showMessage(res.error || res.message || 'Failed to start pool', 'error');
    }
    setTimeout(refreshPoolStatus, 500);
    // start periodic polling
    if (!window.__poolPoll) {
      window.__poolPoll = setInterval(() => {
        if (document.getElementById('pool-tab').classList.contains('active')) {
          refreshPoolStatus();
        }
      }, 2000);
    }
  });
}

if (poolStopBtn) {
  poolStopBtn.addEventListener('click', async () => {
    const res = await electronAPI.pool.stop();
    if (res.success && res.stopped) {
      showMessage('Pool stopped', 'success');
    } else {
      showMessage(res.error || res.message || 'Failed to stop pool', 'error');
    }
    setTimeout(refreshPoolStatus, 500);
  });
}

if (poolSaveKeyBtn) {
  poolSaveKeyBtn.addEventListener('click', async () => {
    const key = String(poolTreasuryKeyInput.value || '').trim();
    if (!key) {
      showMessage('Please paste a private key', 'error');
      return;
    }
    const res = await electronAPI.pool.config.update({ treasuryPrivateKey: key });
    if (res.success) {
      poolTreasuryKeyInput.value = '';
      if (poolKeyStatus) {
        poolKeyStatus.textContent = '(configured)';
        poolKeyStatus.style.color = '#0f5132';
      }
      showMessage('Treasury key saved to config', 'success');
    } else {
      showMessage(res.error || 'Failed to save key', 'error');
    }
  });
}

// Load config on tab open
document.addEventListener('DOMContentLoaded', () => {
  loadPoolConfig().catch(() => {});
});

