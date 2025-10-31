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
    // Also refresh workers dashboard when switching to pool tab
    setTimeout(refreshWorkersDashboard, 300);
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

// Session state management
let allSessionsData = [];
let currentFilter = 'all';
let currentSort = 'newest';
let currentSearch = '';

// Helper: Render timeline for a session
function renderTimeline(session) {
  const steps = [
    { id: 'waiting', label: 'Waiting', icon: '⏳' },
    { id: 'deposit_received', label: 'Deposit', icon: '💰' },
    { id: 'sent_to_intermediate', label: 'Intermediate', icon: '🔄' },
    { id: 'intermediate_confirmed', label: 'Confirmed', icon: '✅' },
    { id: 'confirmed', label: 'Completed', icon: '🎉' }
  ];
  
  const statusIndex = steps.findIndex(s => s.id === session.status);
  const errorStatus = session.status === 'error';
  
  return `
    <div class="session-timeline">
      <div class="timeline-steps">
        ${steps.map((step, idx) => {
          let stepClass = '';
          if (errorStatus && step.id === 'waiting') {
            stepClass = 'completed';
          } else if (idx < statusIndex) {
            stepClass = 'completed';
          } else if (idx === statusIndex && !errorStatus) {
            stepClass = 'active';
          }
          
          return `
            <div class="timeline-step ${stepClass}">
              <div class="timeline-step-icon">${step.icon}</div>
              <div class="timeline-step-label">${step.label}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// Helper: Filter and sort sessions
function filterAndSortSessions(sessions) {
  let filtered = [...sessions];
  
  // Apply search filter
  if (currentSearch.trim()) {
    const searchLower = currentSearch.toLowerCase();
    filtered = filtered.filter(({ sessionId, session }) => {
      return sessionId.toLowerCase().includes(searchLower) ||
             session.depositAddress?.toLowerCase().includes(searchLower) ||
             session.intermediateAddress?.toLowerCase().includes(searchLower) ||
             session.payoutTxIds?.some(tx => tx.toLowerCase().includes(searchLower)) ||
             session.intermediateTxId?.toLowerCase().includes(searchLower);
    });
  }
  
  // Apply status filter
  if (currentFilter !== 'all') {
    filtered = filtered.filter(({ session }) => {
      if (currentFilter === 'deposit_received') {
        return session.status === 'deposit_received' || session.status === 'sent_to_intermediate';
      }
      return session.status === currentFilter;
    });
  }
  
  // Apply sorting
  filtered.sort((a, b) => {
    const sessionA = a.session;
    const sessionB = b.session;
    
    switch (currentSort) {
      case 'newest':
        return (sessionB.updatedAt || sessionB.createdAt || 0) - (sessionA.updatedAt || sessionA.createdAt || 0);
      case 'oldest':
        return (sessionA.updatedAt || sessionA.createdAt || 0) - (sessionB.updatedAt || sessionB.createdAt || 0);
      case 'amount-high':
        return (sessionB.amount || 0) - (sessionA.amount || 0);
      case 'amount-low':
        return (sessionA.amount || 0) - (sessionB.amount || 0);
      case 'status':
        return (sessionA.status || '').localeCompare(sessionB.status || '');
      default:
        return 0;
    }
  });
  
  return filtered;
}

// Helper: Render session card
function renderSessionCard({ sessionId, session }) {
  return `
    <div class="session-card" data-session-id="${sessionId}" data-status="${session.status}">
      <div class="session-header">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <input type="checkbox" class="session-checkbox" data-id="${sessionId}" />
          <div>
            <div class="session-id">${sessionId.substring(0, 16)}...</div>
            <span class="status-badge status-${session.status}">${session.status.replace(/_/g, ' ')}</span>
          </div>
        </div>
      </div>
      ${renderTimeline(session)}
      <div class="collapsible-section" style="margin-top: 0.75rem;">
        <div class="collapsible-header" data-target="session-details-${sessionId}">
          <span style="font-weight: 600; font-size: 0.9rem; color: var(--text-secondary);">Session Details</span>
          <span class="collapse-icon">▼</span>
        </div>
        <div class="session-details collapsible-content" id="session-details-${sessionId}">
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
      </div>
      <div class="session-actions">
        <button type="button" class="btn btn-secondary" data-action="view" data-id="${sessionId}">View</button>
        <button type="button" class="btn btn-secondary" data-action="export-keys" data-id="${sessionId}">Export Keys</button>
        <button type="button" class="btn btn-danger" data-action="delete" data-id="${sessionId}">Delete</button>
      </div>
    </div>
  `;
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
      allSessionsData = [];
      updateBatchActions();
      return;
    }
    
    // Store all sessions data
    allSessionsData = result.sessions;
    
    // Clear existing ETA timers before re-rendering
    if (window.__etaTimers) {
      Object.values(window.__etaTimers).forEach((t) => { try { clearInterval(t); } catch {} });
    }
    window.__etaTimers = {};

    // Apply filters and sorting, then render
    const filtered = filterAndSortSessions(result.sessions);
    
    if (filtered.length === 0) {
      list.innerHTML = '<div class="loading">No sessions match your search/filter criteria.</div>';
    } else {
      list.innerHTML = filtered.map(renderSessionCard).join('');
      // Restore collapsed states after rendering
      if (window.restoreCollapsedStates) {
        window.restoreCollapsedStates();
      }
    }
    
    console.log('[GUI] Sessions rendered:', filtered.length, 'of', result.sessions.length);
    
    // Update batch actions visibility
    updateBatchActions();

    // Start/update countdown timers for intermediate-confirmed sessions
    const filteredSessions = filterAndSortSessions(result.sessions);
    filteredSessions.forEach(({ sessionId, session }) => {
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

// Update batch actions visibility and count
function updateBatchActions() {
  const batchActions = document.getElementById('batch-actions');
  const selectedCount = document.querySelectorAll('.session-checkbox:checked').length;
  const selectedCountEl = document.getElementById('selected-count');
  
  if (batchActions && selectedCountEl) {
    selectedCountEl.textContent = `${selectedCount} selected`;
    if (selectedCount > 0) {
      batchActions.classList.remove('hidden');
    } else {
      batchActions.classList.add('hidden');
    }
  }
}

// Event handlers for session management
const sessionSearch = document.getElementById('session-search');
const sessionSort = document.getElementById('session-sort');
const sessionFilters = document.querySelectorAll('.session-filter');

if (sessionSearch) {
  sessionSearch.addEventListener('input', (e) => {
    currentSearch = e.target.value;
    loadSessions();
  });
}

if (sessionSort) {
  sessionSort.addEventListener('change', (e) => {
    currentSort = e.target.value;
    loadSessions();
  });
}

sessionFilters.forEach(filter => {
  filter.addEventListener('click', () => {
    sessionFilters.forEach(f => f.classList.remove('active'));
    filter.classList.add('active');
    currentFilter = filter.dataset.filter;
    loadSessions();
  });
});

// Checkbox change handler (event delegation)
document.addEventListener('change', (e) => {
  if (e.target.classList.contains('session-checkbox')) {
    updateBatchActions();
  }
});

// Batch operations
const batchExportBtn = document.getElementById('batch-export');
const batchDeleteBtn = document.getElementById('batch-delete');

if (batchExportBtn) {
  batchExportBtn.addEventListener('click', async () => {
    const selected = Array.from(document.querySelectorAll('.session-checkbox:checked'))
      .map(cb => cb.dataset.id);
    
    if (selected.length === 0) {
      showMessage('No sessions selected', 'error');
      return;
    }
    
    let exported = 0;
    for (const sessionId of selected) {
      try {
        const result = await electronAPI.session.exportKeys(sessionId);
        if (result.success && result.keys) {
          const keys = result.keys;
          const text = `Private Keys for Session ${sessionId}:\n\n` +
            `Deposit Private Key: ${keys.depositPrivateKey || 'N/A'}\n` +
            `Deposit Address: ${keys.depositAddress}\n\n` +
            `Intermediate Private Key: ${keys.intermediatePrivateKey || 'N/A'}\n` +
            `Intermediate Address: ${keys.intermediateAddress || 'N/A'}\n\n` +
            `⚠ WARNING: Keep these keys secure!`;
          console.log(`[Batch Export] Session ${sessionId}:\n${text}`);
          exported++;
        }
      } catch (err) {
        console.error(`[Batch Export] Error for ${sessionId}:`, err);
      }
    }
    
    showMessage(`Exported keys for ${exported} of ${selected.length} session(s). Check console for details.`, exported === selected.length ? 'success' : 'error');
    
    // Uncheck all after export
    document.querySelectorAll('.session-checkbox').forEach(cb => cb.checked = false);
    updateBatchActions();
  });
}

if (batchDeleteBtn) {
  batchDeleteBtn.addEventListener('click', async () => {
    const selected = Array.from(document.querySelectorAll('.session-checkbox:checked'))
      .map(cb => cb.dataset.id);
    
    if (selected.length === 0) {
      showMessage('No sessions selected', 'error');
      return;
    }
    
    if (!confirm(`Are you sure you want to delete ${selected.length} session(s)? This action cannot be undone.`)) {
      return;
    }
    
    let deleted = 0;
    for (const sessionId of selected) {
      try {
        const result = await electronAPI.session.delete(sessionId);
        if (result.success) {
          deleted++;
        }
      } catch (err) {
        console.error(`[Batch Delete] Error for ${sessionId}:`, err);
      }
    }
    
    showMessage(`Deleted ${deleted} of ${selected.length} session(s)`, deleted === selected.length ? 'success' : 'error');
    
    // Reload sessions
    loadSessions();
  });
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

// Listen for node status updates (handled below after modal setup)

// Format bytes to human readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// Format time duration
function formatDuration(ms) {
  if (!ms) return 'N/A';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// Format large numbers
function formatNumber(num) {
  if (num === null || num === undefined) return 'N/A';
  if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toString();
}

// Format numbers with thousand separators (for displaying full numbers)
function formatNumberWithSeparators(num) {
  if (num === null || num === undefined) return 'N/A';
  return Number(num).toLocaleString('en-US');
}

// Format numbers with more precision (for showing small changes)
function formatNumberPrecise(num, precision = 3) {
  if (num === null || num === undefined) return 'N/A';
  if (num >= 1e12) return (num / 1e12).toFixed(precision) + 'T';
  if (num >= 1e9) return (num / 1e9).toFixed(precision) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(precision) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(precision) + 'K';
  return num.toString();
}

function renderNodeStatusModal(status) {
  const content = document.getElementById('node-status-content');
  
  if (!status || !status.connected) {
    content.innerHTML = `
      <div class="node-status-error">
        <p><strong>Node Status:</strong> Disconnected</p>
        ${status?.error ? `<p class="error-text">Error: ${status.error}</p>` : ''}
        <button class="btn btn-primary" id="start-node-btn" style="margin-top: 1rem;">Start Node</button>
      </div>
    `;
    document.getElementById('start-node-btn')?.addEventListener('click', async () => {
      showMessage('Attempting to start Kaspa node...', 'info');
      const startResult = await electronAPI.node.start();
      if (startResult.success) {
        showMessage('Kaspa node is starting. Please wait...', 'info');
        setTimeout(() => document.getElementById('node-status-btn').click(), 2000);
      } else {
        showMessage(`Failed to start node: ${startResult.error}`, 'error');
      }
    });
    return;
  }
  
  const s = status;
  const mempool = s.mempool || {};
  // Safely convert difficulty to BigInt if present, otherwise null
  let difficulty = null;
  if (s.difficulty) {
    try {
      if (typeof s.difficulty === 'bigint') {
        difficulty = s.difficulty;
      } else if (typeof s.difficulty === 'string') {
        difficulty = BigInt(s.difficulty);
      } else if (typeof s.difficulty === 'number') {
        difficulty = BigInt(Math.floor(s.difficulty));
      }
    } catch (err) {
      difficulty = null;
    }
  }
  
  content.innerHTML = `
    <div class="node-status-grid">
      <!-- Connection Status -->
      <div class="status-section">
        <h3>Connection Status</h3>
        <div class="status-item">
          <span class="status-label">Connected:</span>
          <span class="status-value ${s.connected ? 'success' : 'error'}">${s.connected ? 'Yes' : 'No'}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Synced:</span>
          <span class="status-value ${s.synced ? 'success' : 'warning'}">${s.synced ? 'Yes' : 'No'}</span>
        </div>
        ${s.syncProgress !== null ? `
        <div class="status-item">
          <span class="status-label">Sync Progress:</span>
          <span class="status-value">${s.syncProgress.toFixed(1)}%</span>
        </div>
        ` : ''}
        <div class="status-item">
          <span class="status-label">Healthy:</span>
          <span class="status-value ${s.healthy ? 'success' : 'error'}">${s.healthy ? 'Yes' : 'No'}</span>
        </div>
      </div>
      
      <!-- Network Info -->
      <div class="status-section">
        <h3>Network Information</h3>
        <div class="status-item">
          <span class="status-label">Network:</span>
          <span class="status-value">${s.networkId || 'Unknown'}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Server Version:</span>
          <span class="status-value">${s.serverVersion || 'Unknown'}</span>
        </div>
        <div class="status-item">
          <span class="status-label">UTXO Indexed:</span>
          <span class="status-value ${s.isUtxoIndexed ? 'success' : 'warning'}">${s.isUtxoIndexed ? 'Yes' : 'No'}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Connected Peers:</span>
          <span class="status-value">${s.peerCount || 0}</span>
        </div>
      </div>
      
      <!-- BlockDag Stats -->
      <div class="status-section">
        <h3>BlockDAG Statistics</h3>
        <div class="status-item">
          <span class="status-label">Block Height:</span>
          <span class="status-value">${formatNumberWithSeparators(s.blockCount || 0)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Headers:</span>
          <span class="status-value">${formatNumberWithSeparators(s.headerCount || 0)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">DAA Score:</span>
          <span class="status-value">${formatNumberWithSeparators(s.virtualDaaScore || 0)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Difficulty:</span>
          <span class="status-value">${difficulty ? (Number(difficulty) / 1e12).toFixed(2) + ' TH' : 'N/A'}</span>
        </div>
      </div>
      
      <!-- Mempool Stats -->
      <div class="status-section">
        <h3>Mempool Information</h3>
        <div class="status-item">
          <span class="status-label">Transactions:</span>
          <span class="status-value">${formatNumber(mempool.transactionCount || 0)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Total Size:</span>
          <span class="status-value">${formatBytes(mempool.totalSize || 0)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Oldest TX Age:</span>
          <span class="status-value">${formatDuration(mempool.oldestTxAge)}</span>
        </div>
        ${mempool.averageFeeRate > 0 ? `
        <div class="status-item">
          <span class="status-label">Avg Fee Rate:</span>
          <span class="status-value">${(mempool.averageFeeRate / 1e8).toFixed(8)} KAS</span>
        </div>
        ` : ''}
      </div>
      
      <!-- Fee Estimates -->
      ${mempool.feeRates && (mempool.feeRates.high || mempool.feeRates.normal || mempool.feeRates.low) ? `
      <div class="status-section">
        <h3>Fee Estimates</h3>
        ${mempool.feeRates.high ? `
        <div class="status-item">
          <span class="status-label">High Priority:</span>
          <span class="status-value">${mempool.feeRates.high} sompi/byte</span>
        </div>
        ` : ''}
        ${mempool.feeRates.normal ? `
        <div class="status-item">
          <span class="status-label">Normal:</span>
          <span class="status-value">${mempool.feeRates.normal} sompi/byte</span>
        </div>
        ` : ''}
        ${mempool.feeRates.low ? `
        <div class="status-item">
          <span class="status-label">Low Priority:</span>
          <span class="status-value">${mempool.feeRates.low} sompi/byte</span>
        </div>
        ` : ''}
      </div>
      ` : ''}
    </div>
  `;
}

// Node Status Modal Management
const nodeStatusModal = document.getElementById('node-status-modal');
const closeNodeModal = document.getElementById('close-node-modal');
let nodeStatusRefreshInterval = null;

// Refresh the node status modal content
async function refreshNodeStatusModal() {
  try {
    const result = await electronAPI.node.status();
    if (result.success) {
      renderNodeStatusModal(result.status);
    } else {
      renderNodeStatusModal({ connected: false, error: result.error });
    }
  } catch (error) {
    renderNodeStatusModal({ connected: false, error: error.message });
  }
}

function openNodeStatusModal() {
  nodeStatusModal.classList.remove('hidden');
  
  // Start auto-refresh when modal opens (every 5 seconds)
  if (nodeStatusRefreshInterval) {
    clearInterval(nodeStatusRefreshInterval);
  }
  nodeStatusRefreshInterval = setInterval(() => {
    // Only refresh if modal is still open
    if (!nodeStatusModal.classList.contains('hidden')) {
      refreshNodeStatusModal();
    } else {
      clearInterval(nodeStatusRefreshInterval);
      nodeStatusRefreshInterval = null;
    }
  }, 5000); // Update every 5 seconds
}

function closeNodeStatusModal() {
  nodeStatusModal.classList.add('hidden');
  
  // Stop auto-refresh when modal closes
  if (nodeStatusRefreshInterval) {
    clearInterval(nodeStatusRefreshInterval);
    nodeStatusRefreshInterval = null;
  }
}

closeNodeModal.addEventListener('click', closeNodeStatusModal);
nodeStatusModal.addEventListener('click', (e) => {
  if (e.target === nodeStatusModal) {
    closeNodeStatusModal();
  }
});

document.getElementById('node-status-btn').addEventListener('click', async () => {
  try {
    openNodeStatusModal();
    
    // Show loading
    document.getElementById('node-status-content').innerHTML = '<div class="loading">Loading node status...</div>';
    
    // Initial load
    await refreshNodeStatusModal();
  } catch (error) {
    renderNodeStatusModal({ connected: false, error: error.message });
  }
});

// Also update modal if it's open when background status updates arrive
electronAPI.node.onStatusUpdate((status) => {
  updateNodeStatusIndicator(status);
  
  // If modal is open, refresh it with full details
  if (!nodeStatusModal.classList.contains('hidden')) {
    refreshNodeStatusModal();
  }
});

// Dark Mode Toggle
function initDarkMode() {
  const themeToggle = document.getElementById('theme-toggle');
  const html = document.documentElement;
  
  // Load saved theme preference or default to light
  const savedTheme = localStorage.getItem('theme') || 'light';
  html.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme === 'dark');
  
  // Toggle theme on button click
  themeToggle.addEventListener('click', () => {
    const currentTheme = html.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcon(newTheme === 'dark');
  });
  
  function updateThemeIcon(isDark) {
    themeToggle.textContent = isDark ? '☀️' : '🌙';
    themeToggle.title = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
  }
}

// Initialize dark mode on page load
initDarkMode();

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
      const outputEl = document.getElementById('pool-output');
      if (outputEl) {
        const output = s.output || '';
        outputEl.textContent = output;
        // Auto-scroll to bottom to show latest logs/errors
        outputEl.scrollTop = outputEl.scrollHeight;
      }
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
          document.getElementById('pool-connections').textContent = String(miners);
          
          // Refresh workers dashboard if pool is running
          if (s.running && miners > 0) {
            refreshWorkersDashboard();
          } else {
            const workersList = document.getElementById('workers-list');
            if (workersList) {
              workersList.innerHTML = '<div class="loading">No active workers. Start mining to see workers here.</div>';
            }
          }
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

// ASIC Difficulty Quick Select
// Use event delegation since chips might be added dynamically or after page load
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.asic-chip');
  if (!chip) return;
  
  const difficulty = parseInt(chip.getAttribute('data-difficulty'));
  const model = chip.getAttribute('data-model');
  
  if (poolDiffInput && difficulty) {
    poolDiffInput.value = difficulty;
    
    // Show visual feedback
    const allChips = document.querySelectorAll('.asic-chip');
    allChips.forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    
    // Show message
    showMessage(`Difficulty set to ${difficulty} for ${model}`, 'success');
    
    // Remove active state after 2 seconds
    setTimeout(() => {
      chip.classList.remove('active');
    }, 2000);
  }
});
const poolTreasuryKeyInput = document.getElementById('pool-treasury-key');
const poolSaveKeyBtn = document.getElementById('pool-save-key');
const poolGenerateKeyBtn = document.getElementById('pool-generate-key');
const poolKeyStatus = document.getElementById('pool-key-status');
const poolGeneratedKeyInfo = document.getElementById('pool-generated-key-info');
const poolGeneratedAddress = document.getElementById('pool-generated-address');
const poolGeneratedKey = document.getElementById('pool-generated-key');
const poolCopyAddressBtn = document.getElementById('pool-copy-address');
const poolCopyKeyBtn = document.getElementById('pool-copy-key');
const poolUseKeyBtn = document.getElementById('pool-use-key');

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
      
      // Show current key display section
      const currentKeyDisplay = document.getElementById('pool-current-key-display');
      const currentKeyValue = document.getElementById('pool-current-key-value');
      const toggleKeyBtn = document.getElementById('pool-toggle-key-visibility');
      const toggleKeyText = document.getElementById('pool-key-toggle-text');
      
      if (currentKeyDisplay && currentKeyValue && toggleKeyBtn && toggleKeyText) {
        currentKeyDisplay.style.display = 'block';
        
        // Store the actual key (will be revealed on click)
        currentKeyValue.dataset.actualKey = cfg.treasury.privateKey;
        currentKeyValue.textContent = '••••••••••••••••';
        currentKeyValue.dataset.revealed = 'false';
        
        // Reset toggle button state
        toggleKeyText.textContent = 'Show';
      }
    } else {
      // Hide current key display if no key configured
      const currentKeyDisplay = document.getElementById('pool-current-key-display');
      if (currentKeyDisplay) {
        currentKeyDisplay.style.display = 'none';
      }
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
    
    // Force immediate refresh of workers dashboard when pool starts
    setTimeout(refreshWorkersDashboard, 500);
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

// Generate new keypair
if (poolGenerateKeyBtn) {
  poolGenerateKeyBtn.addEventListener('click', async () => {
    try {
      poolGenerateKeyBtn.disabled = true;
      poolGenerateKeyBtn.textContent = 'Generating...';
      
      const result = await electronAPI.pool.generateKeypair();
      
      if (result.success) {
        // Show the generated key info
        poolGeneratedAddress.textContent = result.address;
        poolGeneratedKey.textContent = result.privateKey;
        poolGeneratedKeyInfo.style.display = 'block';
        
        showMessage('New keypair generated successfully', 'success');
      } else {
        showMessage(result.error || 'Failed to generate keypair', 'error');
      }
    } catch (error) {
      showMessage(error.message || 'Failed to generate keypair', 'error');
    } finally {
      poolGenerateKeyBtn.disabled = false;
      poolGenerateKeyBtn.textContent = 'Generate';
    }
  });
}

// Copy address to clipboard
if (poolCopyAddressBtn) {
  poolCopyAddressBtn.addEventListener('click', async () => {
    const address = poolGeneratedAddress.textContent;
    if (address) {
      try {
        await navigator.clipboard.writeText(address);
        showMessage('Address copied to clipboard', 'success');
      } catch (err) {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = address;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showMessage('Address copied to clipboard', 'success');
      }
    }
  });
}

// Copy private key to clipboard
if (poolCopyKeyBtn) {
  poolCopyKeyBtn.addEventListener('click', async () => {
    const key = poolGeneratedKey.textContent;
    if (key) {
      try {
        await navigator.clipboard.writeText(key);
        showMessage('Private key copied to clipboard', 'success');
      } catch (err) {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = key;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showMessage('Private key copied to clipboard', 'success');
      }
    }
  });
}

// Toggle current key visibility
const poolToggleKeyVisibilityBtn = document.getElementById('pool-toggle-key-visibility');
if (poolToggleKeyVisibilityBtn) {
  poolToggleKeyVisibilityBtn.addEventListener('click', () => {
    const currentKeyValue = document.getElementById('pool-current-key-value');
    const toggleKeyText = document.getElementById('pool-key-toggle-text');
    
    if (currentKeyValue && toggleKeyText) {
      const isRevealed = currentKeyValue.dataset.revealed === 'true';
      const actualKey = currentKeyValue.dataset.actualKey;
      
      if (isRevealed) {
        // Hide the key
        currentKeyValue.textContent = '••••••••••••••••';
        currentKeyValue.style.color = 'var(--text-secondary)';
        toggleKeyText.textContent = 'Show';
        currentKeyValue.dataset.revealed = 'false';
      } else {
        // Show the key
        if (actualKey) {
          currentKeyValue.textContent = actualKey;
          currentKeyValue.style.color = 'var(--text-primary)';
          toggleKeyText.textContent = 'Hide';
          currentKeyValue.dataset.revealed = 'true';
        }
      }
    }
  });
}

// Copy current key to clipboard
const poolCopyCurrentKeyBtn = document.getElementById('pool-copy-current-key');
if (poolCopyCurrentKeyBtn) {
  poolCopyCurrentKeyBtn.addEventListener('click', async () => {
    const currentKeyValue = document.getElementById('pool-current-key-value');
    if (currentKeyValue) {
      const actualKey = currentKeyValue.dataset.actualKey;
      if (actualKey) {
        try {
          await navigator.clipboard.writeText(actualKey);
          showMessage('Private key copied to clipboard', 'success');
        } catch (err) {
          // Fallback for older browsers
          const textArea = document.createElement('textarea');
          textArea.value = actualKey;
          textArea.style.position = 'fixed';
          textArea.style.opacity = '0';
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand('copy');
          document.body.removeChild(textArea);
          showMessage('Private key copied to clipboard', 'success');
        }
      }
    }
  });
}

// Use generated key (fill input and save)
if (poolUseKeyBtn) {
  poolUseKeyBtn.addEventListener('click', async () => {
    const key = poolGeneratedKey.textContent;
    if (!key) {
      showMessage('No generated key available', 'error');
      return;
    }
    
    // Fill the input field
    poolTreasuryKeyInput.value = key;
    poolTreasuryKeyInput.type = 'text'; // Show the key temporarily
    poolTreasuryKeyInput.select(); // Select the text
    
    // Save automatically
    const res = await electronAPI.pool.config.update({ treasuryPrivateKey: key });
    if (res.success) {
      poolTreasuryKeyInput.type = 'password'; // Hide again
      poolTreasuryKeyInput.value = '';
      if (poolKeyStatus) {
        poolKeyStatus.textContent = '(configured)';
        poolKeyStatus.style.color = '#0f5132';
      }
      
      // Update current key display with the generated key
      const currentKeyDisplay = document.getElementById('pool-current-key-display');
      const currentKeyValue = document.getElementById('pool-current-key-value');
      const toggleKeyText = document.getElementById('pool-key-toggle-text');
      
      if (currentKeyDisplay && currentKeyValue && toggleKeyText) {
        currentKeyDisplay.style.display = 'block';
        currentKeyValue.dataset.actualKey = key;
        currentKeyValue.textContent = '••••••••••••••••';
        currentKeyValue.style.color = 'var(--text-secondary)';
        currentKeyValue.dataset.revealed = 'false';
        toggleKeyText.textContent = 'Show';
      }
      
      // Hide generated key info after use
      poolGeneratedKeyInfo.style.display = 'none';
      showMessage('Treasury key saved to config', 'success');
    } else {
      showMessage(res.error || 'Failed to save key', 'error');
    }
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
      
      // Update current key display with new key
      const currentKeyDisplay = document.getElementById('pool-current-key-display');
      const currentKeyValue = document.getElementById('pool-current-key-value');
      const toggleKeyText = document.getElementById('pool-key-toggle-text');
      
      if (currentKeyDisplay && currentKeyValue && toggleKeyText) {
        currentKeyDisplay.style.display = 'block';
        currentKeyValue.dataset.actualKey = key;
        currentKeyValue.textContent = '••••••••••••••••';
        currentKeyValue.style.color = 'var(--text-secondary)';
        currentKeyValue.dataset.revealed = 'false';
        toggleKeyText.textContent = 'Show';
      }
      
      showMessage('Treasury key saved to config', 'success');
    } else {
      showMessage(res.error || 'Failed to save key', 'error');
    }
  });
}

// Workers Dashboard
async function refreshWorkersDashboard() {
  const workersList = document.getElementById('workers-list');
  if (!workersList) return;
  
  try {
    // Fetch all miners with their worker details
    const minersRes = await fetch('http://127.0.0.1:8080/miners', { cache: 'no-store' });
    if (!minersRes.ok) {
      // Fallback to status endpoint if /miners not available
      const statusRes = await fetch('http://127.0.0.1:8080/status', { cache: 'no-store' });
      if (!statusRes.ok) {
        workersList.innerHTML = '<div class="loading">Unable to fetch worker data. Ensure pool is running.</div>';
        return;
      }
      
      const status = await statusRes.json();
      const miners = Number(status.miners || 0);
      const workers = Number(status.workers || 0);
      
      if (miners === 0 || workers === 0) {
        workersList.innerHTML = '<div class="loading">No active workers. Connect miners to see worker statistics here.</div>';
        return;
      }
      
      workersList.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 1rem; text-align: center; color: var(--text-secondary);">
          <p><strong>${workers} worker(s)</strong> connected from <strong>${miners} miner(s)</strong></p>
          <p style="font-size: 0.85rem; margin-top: 0.5rem;">Worker details require pool API update.</p>
        </div>
      `;
      return;
    }
    
    const data = await minersRes.json();
    const miners = data.miners || [];
    
    if (miners.length === 0) {
      workersList.innerHTML = '<div class="loading">No active workers. Connect miners to see worker statistics here.</div>';
      return;
    }
    
    // Render worker cards for each miner
    workersList.innerHTML = miners.map((miner, idx) => {
      const balance = (BigInt(miner.balance || 0) / 100000000n).toLocaleString();
      const workersCount = miner.workers || 0;
      const workersDetail = miner.workersDetail || [];
      
      // Escape address for safe HTML
      const addressEscaped = miner.address.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      
      return `
        <div class="worker-card active" data-miner-address="${addressEscaped}" style="cursor: pointer;">
          <div class="worker-header">
            <div class="worker-name" style="font-size: 0.9rem; word-break: break-all;">${miner.address.substring(0, 16)}...</div>
            <span class="worker-status active">Active</span>
          </div>
          <div class="worker-details">
            <div class="worker-detail">
              <span class="worker-detail-label">Balance:</span>
              <span class="worker-detail-value">${balance} KAS</span>
            </div>
            <div class="worker-detail">
              <span class="worker-detail-label">Workers:</span>
              <span class="worker-detail-value">${workersCount}</span>
            </div>
            <div class="worker-detail">
              <span class="worker-detail-label">Connections:</span>
              <span class="worker-detail-value">${miner.connections || 0}</span>
            </div>
            ${workersDetail.length > 0 ? `
              <div style="margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border-color);">
                <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.25rem;">Workers:</div>
                ${workersDetail.slice(0, 3).map(w => {
                  const wName = (w.name || 'Unnamed').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  const wAgent = (w.agent || 'Unknown').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  return `
                    <div style="font-size: 0.75rem; color: var(--text-primary); margin: 0.15rem 0;">
                      ${wName} (${wAgent}) - Diff: ${w.difficulty || 0}
                    </div>
                  `;
                }).join('')}
                ${workersDetail.length > 3 ? `<div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.25rem;">+${workersDetail.length - 3} more</div>` : ''}
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
    
    // Add click handlers for worker cards using event delegation
    workersList.querySelectorAll('.worker-card').forEach(card => {
      card.addEventListener('click', (e) => {
        const address = card.dataset.minerAddress;
        if (address) {
          showMinerModal(address);
        }
      });
    });
  } catch (err) {
    workersList.innerHTML = '<div class="loading">Error loading workers: ' + err.message + '</div>';
    console.error('[Workers Dashboard] Error:', err);
  }
}

// Show miner detail modal
async function showMinerModal(minerAddress) {
  const modal = document.getElementById('miner-modal');
  const content = document.getElementById('miner-content');
  
  if (!modal || !content) return;
  
  modal.classList.remove('hidden');
  content.innerHTML = '<div class="loading">Loading miner details...</div>';
  
  try {
    const res = await fetch(`http://127.0.0.1:8080/miner?address=${encodeURIComponent(minerAddress)}`, { cache: 'no-store' });
    if (!res.ok) {
      content.innerHTML = `<div class="error">Failed to load miner details: ${res.statusText}</div>`;
      return;
    }
    
    const data = await res.json();
    
    content.innerHTML = `
      <div class="status-section">
        <h3>Miner Information</h3>
        <div class="status-item status-item-address">
          <span class="status-label">Address:</span>
          <span class="status-value address-display">${minerAddress}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Balance:</span>
          <span class="status-value">${(BigInt(data.balance || 0) / 100000000n).toLocaleString()} KAS</span>
        </div>
        <div class="status-item">
          <span class="status-label">Active Connections:</span>
          <span class="status-value">${data.connections || 0}</span>
        </div>
      </div>
      ${data.workers && data.workers.length > 0 ? `
        <div class="status-section" style="margin-top: 1rem;">
          <h3>Workers (${data.workers.length})</h3>
          ${data.workers.map(w => `
            <div class="status-item">
              <div>
                <div style="font-weight: 600; color: var(--text-primary);">${w.name || 'Unnamed'}</div>
                <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.25rem;">
                  Agent: ${w.agent || 'Unknown'} | Difficulty: ${w.difficulty || 0}
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      ` : '<div class="status-section" style="margin-top: 1rem;"><p style="color: var(--text-secondary);">No workers active</p></div>'}
    `;
  } catch (err) {
    content.innerHTML = `<div class="error">Error: ${err.message}</div>`;
  }
}

// Miner modal close handler
const minerModal = document.getElementById('miner-modal');
const closeMinerModal = document.getElementById('close-miner-modal');
if (minerModal && closeMinerModal) {
  closeMinerModal.addEventListener('click', () => {
    minerModal.classList.add('hidden');
  });
  minerModal.addEventListener('click', (e) => {
    if (e.target === minerModal) {
      minerModal.classList.add('hidden');
    }
  });
}

// Refresh workers button
const refreshWorkersBtn = document.getElementById('refresh-workers');
if (refreshWorkersBtn) {
  refreshWorkersBtn.addEventListener('click', refreshWorkersDashboard);
}

// Load config on tab open
document.addEventListener('DOMContentLoaded', () => {
  loadPoolConfig().catch(() => {});
});

// Collapsible Sections Handler
document.addEventListener('DOMContentLoaded', () => {
  // Get unique identifier for a section
  function getSectionId(section) {
    // Try to get ID from the target panel
    const header = section.querySelector('.collapsible-header');
    if (header) {
      const targetId = header.getAttribute('data-target');
      if (targetId) {
        // Use target ID as identifier (e.g., "pool-settings-panel" -> "pool-settings")
        return targetId.replace('-panel', '').replace('-content', '');
      }
    }
    // Fallback to section ID or generate from content
    return section.id || `section-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  // Function to restore collapsed states from localStorage
  window.restoreCollapsedStates = function() {
    document.querySelectorAll('.collapsible-section').forEach(section => {
      const sectionId = getSectionId(section);
      const savedState = localStorage.getItem(`collapse-${sectionId}`);
      if (savedState === 'true') {
        section.classList.add('collapsed');
      }
    });
  };
  
  // Handle collapsible sections
  document.addEventListener('click', (e) => {
    // Don't toggle if clicking on buttons or interactive elements inside header
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) {
      return;
    }
    
    const header = e.target.closest('.collapsible-header');
    if (!header) return;
    
    const targetId = header.getAttribute('data-target');
    if (!targetId) return;
    
    const section = header.closest('.collapsible-section');
    if (!section) return;
    
    const content = document.getElementById(targetId);
    if (!content) return;
    
    // Toggle collapsed state
    section.classList.toggle('collapsed');
    
    // Save state to localStorage
    const sectionId = getSectionId(section);
    const isCollapsed = section.classList.contains('collapsed');
    localStorage.setItem(`collapse-${sectionId}`, isCollapsed);
  });
  
  // Restore collapsed states on initial page load
  restoreCollapsedStates();
});

