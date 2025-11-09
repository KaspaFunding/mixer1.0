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
    } else if (tabName === 'coinjoin') {
      loadCoinjoinSessions();
      refreshCoinjoinStats();
    } else if (tabName === 'wallet') {
      checkWalletStatus();
  } else if (tabName === 'pool') {
    refreshPoolStatus();
    // Also refresh workers dashboard when switching to pool tab
    setTimeout(refreshWorkersDashboard, 300);
    }
  });
});

// Status message helper (from utils/dom-helpers.js)
function showMessage(text, type = 'info', duration = 5000) {
  const msg = document.getElementById('status-message');
  if (!msg) return;
  
  if (text.includes('<') && text.includes('>')) {
    msg.innerHTML = text;
  } else {
    msg.textContent = text;
  }
  msg.className = `status-message ${type}`;
  msg.classList.remove('hidden');
  setTimeout(() => {
    msg.classList.add('hidden');
  }, duration);
}

// HTML escape helper (from utils/dom-helpers.js)
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Session state management (from services/session-ui.js)
let allSessionsData = [];
let currentFilter = 'all';
let currentSort = 'newest';
let currentSearch = '';

const ZERO_TRUST_REQUIRED_PARTICIPANTS = 10;

// Helper: Render timeline for a session (from services/session-ui.js)
function renderTimeline(session) {
  // Check if this is a coinjoin session
  const isCoinjoin = session.type === 'coinjoin';
  
  // Different timeline steps for coinjoin vs regular mixing
  const steps = isCoinjoin ? [
    { id: 'committed', label: 'Committed', icon: '🔒' },
    { id: 'revealed', label: 'Revealed', icon: '🔓' },
    { id: 'entered', label: 'Entered', icon: '💰' },
    { id: 'building', label: 'Building', icon: '🔨' },
    { id: 'completed', label: 'Completed', icon: '🎉' }
  ] : [
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
          if (errorStatus && idx === 0) {
            stepClass = 'completed';
          } else if (statusIndex >= 0 && idx < statusIndex) {
            stepClass = 'completed';
          } else if (statusIndex >= 0 && idx === statusIndex && !errorStatus) {
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

// Helper: Apply search filter (from services/session-ui.js)
function applySearchFilter(sessions, searchTerm) {
  if (!searchTerm.trim()) {
    return sessions;
  }
  
  const searchLower = searchTerm.toLowerCase();
  return sessions.filter(({ sessionId, session }) => {
    return sessionId.toLowerCase().includes(searchLower) ||
           session.depositAddress?.toLowerCase().includes(searchLower) ||
           session.intermediateAddress?.toLowerCase().includes(searchLower) ||
           session.payoutTxIds?.some(tx => tx.toLowerCase().includes(searchLower)) ||
           session.intermediateTxId?.toLowerCase().includes(searchLower);
  });
}

// Helper: Apply status filter (from services/session-ui.js)
function applyStatusFilter(sessions, filter) {
  if (filter === 'all') {
    return sessions;
  }
  
  return sessions.filter(({ session }) => {
    if (filter === 'deposit_received') {
      return session.status === 'deposit_received' || session.status === 'sent_to_intermediate';
    }
    return session.status === filter;
  });
}

// Helper: Sort sessions (from services/session-ui.js)
function sortSessions(sessions, sortBy) {
  const sorted = [...sessions];
  
  sorted.sort((a, b) => {
    const sessionA = a.session;
    const sessionB = b.session;
    
    switch (sortBy) {
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
  
  return sorted;
}

// Helper: Filter and sort sessions (from services/session-ui.js)
function filterAndSortSessions(sessions) {
  let filtered = applySearchFilter(sessions, currentSearch);
  filtered = applyStatusFilter(filtered, currentFilter);
  return sortSessions(filtered, currentSort);
}

// Helper: Render session card (from services/session-ui.js)
function renderSessionCard({ sessionId, session }) {
  // Check if this is a coinjoin session
  const isCoinjoin = session.type === 'coinjoin' || sessionId.startsWith('coinjoin_');
  
  return `
    <div class="session-card" data-session-id="${sessionId}" data-status="${session.status}">
      <div class="session-header">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <input type="checkbox" class="session-checkbox" data-id="${sessionId}" />
          <div>
            <div class="session-id">${sessionId.substring(0, 16)}...</div>
            <span class="status-badge status-${session.status}">${session.status.replace(/_/g, ' ')}</span>
            ${isCoinjoin ? `<span class="status-badge" style="background: var(--accent-secondary); margin-left: 0.25rem;">${session.zeroTrustMode ? 'Zero-Trust' : 'Trusted'} Coinjoin</span>` : ''}
          </div>
        </div>
      </div>
      ${renderTimeline({ ...session, type: isCoinjoin ? 'coinjoin' : session.type })}
      <div class="collapsible-section" style="margin-top: 0.75rem;">
        <div class="collapsible-header" data-target="session-details-${sessionId}">
          <span style="font-weight: 600; font-size: 0.9rem; color: var(--text-secondary);">Session Details</span>
          <span class="collapse-icon">▼</span>
        </div>
        <div class="session-details collapsible-content" id="session-details-${sessionId}">
          ${isCoinjoin ? `
            <!-- Coinjoin session details -->
            ${session.depositAddress ? `
              <div class="detail-row">
                <span class="detail-label">Deposit Address:</span>
                <span class="address-display">${session.depositAddress}</span>
              </div>
            ` : ''}
            ${session.amount ? `
              <div class="detail-row">
                <span class="detail-label">Amount:</span>
                <span>${(Number(session.amount) / 1e8).toFixed(8)} KAS</span>
              </div>
            ` : ''}
            ${session.destinationAddress ? `
              <div class="detail-row">
                <span class="detail-label">Destination:</span>
                <span class="address-display">${session.destinationAddress}</span>
              </div>
            ` : ''}
            ${session.utxoCommitments && session.utxoCommitments.length > 0 ? `
              <div class="detail-row">
                <span class="detail-label">UTXO Commitments:</span>
                <span>${session.utxoCommitments.length}</span>
              </div>
            ` : ''}
            ${session.destinationHash ? `
              <div class="detail-row">
                <span class="detail-label">Destination Hash:</span>
                <span class="address-display" style="font-size: 0.8rem;">${session.destinationHash.substring(0, 32)}...</span>
              </div>
            ` : ''}
          ` : `
            <!-- Regular mixing session details -->
            ${session.depositAddress ? `
              <div class="detail-row">
                <span class="detail-label">Deposit Address:</span>
                <span class="address-display">${session.depositAddress}</span>
              </div>
            ` : ''}
            ${session.amount ? `
              <div class="detail-row">
                <span class="detail-label">Amount:</span>
                <span>${(Number(session.amount) / 1e8).toFixed(8)} KAS</span>
              </div>
            ` : ''}
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
          `}
          ${session.error ? `
            <div class="detail-row" style="color: var(--error);">
              <span class="detail-label">Error:</span>
              <span>${escapeHtml(session.error)}</span>
            </div>
          ` : ''}
        </div>
      </div>
      <div class="session-actions">
        <button type="button" class="btn btn-secondary" data-action="view" data-id="${sessionId}">View</button>
        ${!isCoinjoin ? `
          <button type="button" class="btn btn-secondary" data-action="export-keys" data-id="${sessionId}">Export Keys</button>
        ` : ''}
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

async function exportKeys(sessionId) {
  const result = await electronAPI.session.exportKeys(sessionId);
  if (result.success && result.keys) {
    const keys = result.keys;
    const text = `Private Keys for Session ${sessionId}:\n\n` +
      `Deposit Private Key: ${keys.depositPrivateKey || 'N/A'}\n` +
      `Deposit Address: ${keys.depositAddress}\n\n` +
      `Intermediate Private Key: ${keys.intermediatePrivateKey || 'N/A'}\n` +
      `Intermediate Address: ${keys.intermediateAddress || 'N/A'}\n\n` +
      `⚠ WARNING: Keep these keys secure!`;
    
    // Show keys in modal
    showExportKeysModal(sessionId, text);
  } else {
    showMessage(result.error || 'Failed to export keys', 'error');
  }
}

function showExportKeysModal(sessionId, keysText) {
  const modal = document.getElementById('export-keys-modal');
  const sessionIdEl = document.getElementById('export-keys-session-id');
  const contentEl = document.getElementById('export-keys-content');
  
  if (!modal || !sessionIdEl || !contentEl) return;
  
  sessionIdEl.textContent = sessionId;
  contentEl.value = keysText;
  modal.classList.remove('hidden');
}

function closeExportKeysModal() {
  const modal = document.getElementById('export-keys-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

// Export keys modal event listeners
document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('close-export-keys-modal');
  const closeModalBtn = document.getElementById('export-keys-close-btn');
  const copyBtn = document.getElementById('export-keys-copy-btn');
  
  if (closeBtn) {
    closeBtn.addEventListener('click', closeExportKeysModal);
  }
  
  if (closeModalBtn) {
    closeModalBtn.addEventListener('click', closeExportKeysModal);
  }
  
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const contentEl = document.getElementById('export-keys-content');
      if (contentEl) {
        try {
          await navigator.clipboard.writeText(contentEl.value);
          showMessage('Keys copied to clipboard!', 'success');
        } catch (err) {
          // Fallback: select text
          contentEl.select();
          contentEl.setSelectionRange(0, 99999); // For mobile devices
          try {
            document.execCommand('copy');
            showMessage('Keys copied to clipboard!', 'success');
          } catch (e) {
            showMessage('Failed to copy. Please manually select and copy the text.', 'error');
          }
        }
      }
    });
  }
  
  // Close modal on outside click
  const modal = document.getElementById('export-keys-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target.id === 'export-keys-modal') {
        closeExportKeysModal();
      }
    });
  }
});

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

// Delete All Sessions button
const deleteAllSessionsBtn = document.getElementById('delete-all-sessions');
if (deleteAllSessionsBtn) {
  deleteAllSessionsBtn.addEventListener('click', async () => {
    // Get all sessions first
    const result = await electronAPI.session.list();
    if (!result || !result.success || !result.sessions || result.sessions.length === 0) {
      showMessage('No sessions to delete', 'info');
      return;
    }
    
    const sessionCount = result.sessions.length;
    
    // Show confirmation dialog with session count breakdown
    const coinjoinSessions = result.sessions.filter(s => s.session && s.session.type === 'coinjoin').length;
    const regularSessions = result.sessions.length - coinjoinSessions;
    
    let confirmMessage = `Are you sure you want to delete ALL ${sessionCount} session(s)?\n\n`;
    if (coinjoinSessions > 0 && regularSessions > 0) {
      confirmMessage += `This includes:\n- ${coinjoinSessions} coinjoin session(s)\n- ${regularSessions} regular session(s)\n\n`;
    } else if (coinjoinSessions > 0) {
      confirmMessage += `This includes ${coinjoinSessions} coinjoin session(s).\n\n`;
    }
    confirmMessage += `⚠️ WARNING: This action cannot be undone and will permanently delete all session data.\n\nDo you want to proceed?`;
    
    // Show confirmation dialog
    if (!confirm(confirmMessage)) {
      return;
    }
    
    // Double confirmation for safety
    if (!confirm(`Final confirmation: Delete ALL ${sessionCount} session(s)?\n\nThis action cannot be undone.`)) {
      return;
    }
    
    showMessage(`Deleting ${sessionCount} session(s)...`, 'info');
    
    let deleted = 0;
    let failed = 0;
    
    // Delete all sessions
    for (const { sessionId } of result.sessions) {
      try {
        const deleteResult = await electronAPI.session.delete(sessionId);
        if (deleteResult.success) {
          deleted++;
        } else {
          failed++;
          console.error(`[Delete All] Failed to delete ${sessionId}:`, deleteResult.error);
        }
      } catch (err) {
        failed++;
        console.error(`[Delete All] Error deleting ${sessionId}:`, err);
      }
    }
    
    if (deleted > 0) {
      showMessage(`Successfully deleted ${deleted} of ${sessionCount} session(s)${failed > 0 ? ` (${failed} failed)` : ''}`, deleted === sessionCount ? 'success' : 'warning');
    } else {
      showMessage(`Failed to delete any sessions. ${failed} error(s) occurred.`, 'error');
    }
    
    // Reload sessions to show updated list
    loadSessions();
  });
}

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
      exportKeys(sessionId);
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
// Generate QR code for wallet address
async function generateWalletQRCode(address) {
  const qrCanvas = document.getElementById('wallet-address-qrcode');
  if (!qrCanvas || !address) return;
  
  // Determine QR code size based on screen width
  const isMobile = window.innerWidth <= 768;
  const qrSize = isMobile ? 150 : 200;
  
  // Set canvas size
  qrCanvas.width = qrSize;
  qrCanvas.height = qrSize;
  
  try {
    // Generate QR code via main process (using local qrcode package)
    const result = await electronAPI.qrcode.toDataURL(address, {
      width: qrSize,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      errorCorrectionLevel: 'M'
    });
    
    if (result.success && result.dataURL) {
      // Draw the QR code data URL onto the canvas
      const img = new Image();
      img.onload = function() {
        const ctx = qrCanvas.getContext('2d');
        ctx.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
        ctx.drawImage(img, 0, 0, qrSize, qrSize);
      };
      img.onerror = function() {
        console.error('Error loading QR code image');
        qrCanvas.style.display = 'none';
      };
      img.src = result.dataURL;
    } else {
      console.error('Failed to generate QR code:', result.error);
      qrCanvas.style.display = 'none';
    }
  } catch (error) {
    console.error('Error generating QR code:', error);
    qrCanvas.style.display = 'none';
  }
}

async function checkWalletStatus() {
  const result = await electronAPI.wallet.info();
  if (result.success && result.wallet) {
    document.getElementById('wallet-not-imported').classList.add('hidden');
    document.getElementById('wallet-imported').classList.remove('hidden');
    const address = result.wallet.address;
    document.getElementById('wallet-address').textContent = address;
    
    // Generate QR code for the address
    generateWalletQRCode(address);
    
    // Show KPUB if available
    const kpubCard = document.getElementById('wallet-kpub-card');
    const kpubDisplay = document.getElementById('wallet-kpub');
    const kpubNote = document.getElementById('wallet-kpub-note');
    const copyKpubBtn = document.getElementById('copy-wallet-kpub');
    
    if (result.wallet.hasKPUB && result.wallet.kpub) {
      // Show KPUB card
      kpubCard.style.display = 'block';
      kpubDisplay.textContent = result.wallet.kpub;
      copyKpubBtn.style.display = 'inline-block';
      
      if (result.wallet.derivationPath) {
        kpubNote.innerHTML = `<div style="margin-bottom:0.25rem;">Derivation path: <code style="font-size:0.85em;">${result.wallet.derivationPath}</code></div><div style="color:var(--warning-color, #ffc107); font-weight:500;">⚠️ Contains chain code - use with caution. While this KPUB cannot spend funds directly, it should not be shared publicly as it reveals key derivation structure.</div>`;
      } else {
        kpubNote.innerHTML = `<div style="color:var(--warning-color, #ffc107); font-weight:500;">⚠️ Contains chain code - use with caution. While this KPUB cannot spend funds directly, it should not be shared publicly as it reveals key derivation structure.</div>`;
      }
      kpubNote.style.display = 'block';
    } else {
      // Show note that KPUB is not available
      kpubCard.style.display = 'block';
      kpubDisplay.textContent = 'Not available';
      kpubDisplay.style.color = 'var(--text-secondary)';
      copyKpubBtn.style.display = 'none';
      kpubNote.textContent = result.wallet.kpubNote || 'KPUB only available for wallets imported via mnemonic';
      kpubNote.style.display = 'block';
    }
    
    loadWalletBalance();
    loadTransactionHistory(true);
    loadAddressBook(); // Load address book
    
    // Start auto-refresh for balance (every 10 seconds for faster updates)
    if (window.balanceRefreshInterval) {
      clearInterval(window.balanceRefreshInterval);
    }
    window.balanceRefreshInterval = setInterval(() => {
      loadWalletBalance();
      loadTransactionHistory(true); // Refresh transaction history too
    }, 10000); // 10 seconds for faster status updates
    
    // Also check pending transactions more frequently (every 5 seconds)
    if (window.pendingTxCheckInterval) {
      clearInterval(window.pendingTxCheckInterval);
    }
    window.pendingTxCheckInterval = setInterval(() => {
      // Only refresh if we have pending transactions (check first without full reload)
      const hasPending = Array.from(document.querySelectorAll('.transaction-status.pending')).length > 0;
      if (hasPending) {
        loadTransactionHistory(true);
      }
    }, 5000); // Check every 5 seconds for pending transaction updates
  } else {
    document.getElementById('wallet-not-imported').classList.remove('hidden');
    document.getElementById('wallet-imported').classList.add('hidden');
    
    // Stop auto-refresh
    if (window.balanceRefreshInterval) {
      clearInterval(window.balanceRefreshInterval);
      window.balanceRefreshInterval = null;
    }
    if (window.pendingTxCheckInterval) {
      clearInterval(window.pendingTxCheckInterval);
      window.pendingTxCheckInterval = null;
    }
  }
}

async function loadWalletBalance() {
  try {
    const result = await electronAPI.wallet.balance();
    if (result.success) {
      const balance = result.balance;
      document.getElementById('balance-amount').textContent = `${balance.total.toFixed(8)} KAS`;
      
      // Show breakdown
      const breakdown = document.getElementById('balance-breakdown');
      document.getElementById('balance-confirmed').textContent = `${balance.confirmed.toFixed(8)} KAS`;
      document.getElementById('balance-pending').textContent = `${balance.unconfirmed.toFixed(8)} KAS`;
      document.getElementById('balance-mature').textContent = `${(balance.mature || 0).toFixed(8)} KAS`;
      
      // Show last updated time
      if (balance.lastUpdated) {
        const lastUpdated = new Date(balance.lastUpdated);
        const timeAgo = Math.floor((Date.now() - balance.lastUpdated) / 1000);
        let timeStr = '';
        if (timeAgo < 60) {
          timeStr = `${timeAgo}s ago`;
        } else if (timeAgo < 3600) {
          timeStr = `${Math.floor(timeAgo / 60)}m ago`;
        } else {
          timeStr = `${Math.floor(timeAgo / 3600)}h ago`;
        }
        document.getElementById('balance-last-updated').textContent = `Updated ${timeStr}`;
      }
      
      breakdown.style.display = 'block';
    } else {
      document.getElementById('balance-amount').textContent = 'Error';
      document.getElementById('balance-breakdown').style.display = 'none';
    }
  } catch (error) {
    document.getElementById('balance-amount').textContent = 'Error';
    document.getElementById('balance-breakdown').style.display = 'none';
  }
}

// Load transaction history
let transactionHistoryOffset = 0;
let transactionHistoryLimit = 20;
let allLoadedTransactions = [];

async function loadTransactionHistory(reset = false) {
  try {
    const listEl = document.getElementById('transaction-history-list');
    if (reset) {
      transactionHistoryOffset = 0;
      allLoadedTransactions = [];
      listEl.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-secondary);">Loading transactions...</div>';
    }
    
    const result = await electronAPI.wallet.transactionHistory(transactionHistoryLimit, transactionHistoryOffset);
    if (result.success && result.transactions) {
      if (reset) {
        allLoadedTransactions = result.transactions;
      } else {
        allLoadedTransactions = allLoadedTransactions.concat(result.transactions);
      }
      
      if (allLoadedTransactions.length === 0) {
        listEl.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-secondary);">No transactions found</div>';
        document.getElementById('transaction-history-pagination').style.display = 'none';
        return;
      }
      
      // Render transactions
      listEl.innerHTML = allLoadedTransactions.map(tx => {
        const date = new Date(tx.timestamp);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
        const amountStr = Math.abs(tx.amount).toFixed(8);
        const feeStr = tx.fee ? tx.fee.toFixed(8) : '0';
        const statusClass = tx.status === 'confirmed' ? 'confirmed' : 'pending';
        const txIdShort = tx.txId ? tx.txId.substring(0, 16) + '...' : 'N/A';
        
        return `
          <div class="transaction-item ${tx.type} transaction-item-copyable" data-tx-id="${escapeHtml(tx.txId || '')}">
            <div class="transaction-item-header">
              <span class="transaction-type ${tx.type}">${tx.type === 'received' ? 'Received' : 'Sent'}</span>
              <span class="transaction-amount ${tx.type}">${tx.type === 'received' ? '+' : '-'}${amountStr} KAS</span>
            </div>
            <div class="transaction-details">
              <div><strong>Date:</strong> ${dateStr}</div>
              <div><strong>Fee:</strong> ${feeStr} KAS</div>
              ${tx.confirmations !== undefined ? `<div><strong>Confirmations:</strong> ${tx.confirmations}</div>` : ''}
              <div><strong>Status:</strong> <span class="transaction-status ${statusClass}">${tx.status}</span></div>
            </div>
            <div class="transaction-txid" title="Click to copy TX ID">TX: ${txIdShort}</div>
          </div>
        `;
      }).join('');
      
      // Attach event listeners to transaction items for copy functionality
      listEl.querySelectorAll('.transaction-item-copyable').forEach(item => {
        item.addEventListener('click', () => {
          const txId = item.getAttribute('data-tx-id');
          if (txId) {
            copyToClipboard(txId);
          }
        });
      });
      
      // Update pagination
      const paginationEl = document.getElementById('transaction-history-pagination');
      const infoEl = document.getElementById('transaction-history-info');
      if (result.total > allLoadedTransactions.length) {
        paginationEl.style.display = 'block';
        infoEl.textContent = `Showing ${allLoadedTransactions.length} of ${result.total} transactions`;
        transactionHistoryOffset += transactionHistoryLimit;
      } else {
        paginationEl.style.display = 'none';
        if (result.total > 0) {
          infoEl.textContent = `Showing all ${result.total} transactions`;
        }
      }
    } else {
      listEl.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-secondary);">Error loading transactions</div>';
    }
  } catch (error) {
    document.getElementById('transaction-history-list').innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-secondary);">Error: ' + error.message + '</div>';
  }
}

// Helper function to copy to clipboard
async function copyToClipboard(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showMessage('Transaction ID copied to clipboard', 'success');
  } catch (e) {
    showMessage('Failed to copy', 'error');
  }
};

// Fee estimation on amount/address change
let feeEstimateTimeout = null;
async function estimateFeeForSend() {
  const address = document.getElementById('send-address').value.trim();
  const amount = parseFloat(document.getElementById('send-amount').value);
  const feeEstimationEl = document.getElementById('fee-estimation');
  const feeWarningEl = document.getElementById('fee-warning');
  
  if (!address || !amount || amount <= 0) {
    feeEstimationEl.style.display = 'none';
    return;
  }
  
  // Basic address validation
  if (!address.startsWith('kaspa:')) {
    feeEstimationEl.style.display = 'none';
    return;
  }
  
  // Debounce fee estimation
  clearTimeout(feeEstimateTimeout);
  feeEstimateTimeout = setTimeout(async () => {
    try {
      const result = await electronAPI.wallet.estimateFee(address, amount);
      if (result.success && result.estimate) {
        const est = result.estimate;
        document.getElementById('estimated-fee-amount').textContent = `${est.estimatedFee.toFixed(8)} KAS`;
        document.getElementById('total-cost-amount').textContent = `${est.totalCost.toFixed(8)} KAS`;
        
        feeEstimationEl.style.display = 'block';
        
        // Show warning if can't send
        if (!est.canSend) {
          feeWarningEl.style.display = 'block';
          feeWarningEl.textContent = `⚠️ Insufficient balance. Available: ${est.availableBalance.toFixed(8)} KAS, Required: ${est.totalCost.toFixed(8)} KAS`;
        } else {
          feeWarningEl.style.display = 'none';
        }
      } else {
        feeEstimationEl.style.display = 'none';
      }
    } catch (error) {
      feeEstimationEl.style.display = 'none';
    }
  }, 500);
}

// Wallet import method tabs
document.querySelectorAll('.wallet-import-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const method = btn.dataset.method;
    
    // Update tab buttons
    document.querySelectorAll('.wallet-import-tab-btn').forEach(b => {
      b.classList.remove('active');
      b.style.borderBottomColor = 'transparent';
      b.style.color = 'var(--text-secondary)';
    });
    btn.classList.add('active');
    btn.style.borderBottomColor = 'var(--primary)';
    btn.style.color = 'var(--text-primary)';
    
    // Update method panels
    document.querySelectorAll('.wallet-import-method').forEach(panel => {
      panel.style.display = 'none';
      panel.classList.remove('active');
    });
    const targetPanel = document.getElementById(`import-method-${method}`);
    if (targetPanel) {
      targetPanel.style.display = 'block';
      targetPanel.classList.add('active');
    }
  });
});

// Private Key Import
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

// Mnemonic Import
document.getElementById('import-mnemonic-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mnemonic = document.getElementById('mnemonic-input').value.trim();
  const passphrase = document.getElementById('mnemonic-passphrase-input').value.trim();
  
  if (!mnemonic) {
    showMessage('Please enter a mnemonic phrase', 'error');
    return;
  }
  
  try {
    const result = await electronAPI.wallet.importMnemonic(mnemonic, passphrase);
    if (result.success) {
      showMessage('Wallet imported from mnemonic successfully!', 'success');
      document.getElementById('mnemonic-input').value = '';
      document.getElementById('mnemonic-passphrase-input').value = '';
      checkWalletStatus();
    } else {
      showMessage(result.error || 'Failed to import wallet from mnemonic', 'error');
    }
  } catch (error) {
    showMessage(error.message || 'Failed to import wallet from mnemonic', 'error');
  }
});

// Clear KPUB results function
function clearKpubResults() {
  const addressesResult = document.getElementById('kpub-addresses-result');
  const addressesList = document.getElementById('kpub-addresses-list');
  const clearBtn = document.getElementById('clear-kpub-results');
  const clearBtnInline = document.getElementById('clear-kpub-results-inline');
  
  addressesList.innerHTML = '';
  addressesResult.style.display = 'none';
  if (clearBtn) clearBtn.style.display = 'none';
}

// Clear button handlers
const clearKpubBtn = document.getElementById('clear-kpub-results');
const clearKpubBtnInline = document.getElementById('clear-kpub-results-inline');

if (clearKpubBtn) {
  clearKpubBtn.addEventListener('click', () => {
    clearKpubResults();
  });
}

if (clearKpubBtnInline) {
  clearKpubBtnInline.addEventListener('click', () => {
    clearKpubResults();
  });
}

// KPUB/XPUB Address Generation
document.getElementById('import-kpub-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kpub = document.getElementById('kpub-input').value.trim();
  const startIndex = parseInt(document.getElementById('kpub-start-index').value) || 0;
  const count = parseInt(document.getElementById('kpub-count').value) || 10;
  
  if (!kpub) {
    showMessage('Please enter a KPUB/XPUB', 'error');
    return;
  }
  
  if (count < 1 || count > 100) {
    showMessage('Count must be between 1 and 100', 'error');
    return;
  }
  
  try {
    // Detect format first to provide better feedback
    const formatResult = await electronAPI.wallet.detectKPUBFormat(kpub);
    if (formatResult.success) {
      const formatInfo = formatResult.formatInfo;
      console.log(`[Wallet] Detected format: ${formatInfo.format} (${formatInfo.description})`);
      
      // Show format info to user
      if (formatInfo.format !== 'unknown') {
        showMessage(`Detected ${formatInfo.description}`, 'success');
      }
    }
    
    const result = await electronAPI.wallet.generateAddressesKpub(kpub, startIndex, count);
    if (result.success && result.result) {
      const addressesResult = document.getElementById('kpub-addresses-result');
      const addressesList = document.getElementById('kpub-addresses-list');
      const clearBtn = document.getElementById('clear-kpub-results');
      
      addressesList.innerHTML = '';
      
      // Show clear button next to Generate Addresses button
      if (clearBtn) clearBtn.style.display = 'inline-block';
      
      result.result.addresses.forEach(addr => {
        const addrDiv = document.createElement('div');
        addrDiv.style.cssText = 'padding:0.5rem; margin-bottom:0.5rem; background:rgba(0,0,0,0.3); border-radius:6px; border:1px solid rgba(112,199,186,0.2);';
        
        // Show wallet type and format if available
        const walletTypeLabel = addr.walletType ? ` (${addr.walletType})` : '';
        const formatLabel = addr.format ? ` [${addr.format.toUpperCase()}]` : '';
        
        addrDiv.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div style="flex:1;">
              <div style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:0.25rem;">
                Index ${addr.index}${formatLabel}${walletTypeLabel}
              </div>
              <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:0.25rem; font-family:ui-monospace,Menlo,Consolas,\'Courier New\',monospace;">
                ${addr.path}
              </div>
              <div style="font-family:ui-monospace,Menlo,Consolas,\'Courier New\',monospace; font-size:0.9rem; word-break:break-all;">${addr.address}</div>
            </div>
            <button class="btn btn-secondary btn-sm copy-kpub-address" data-address="${addr.address}" style="padding:4px 12px; font-size:0.85rem; margin-left:0.5rem;">
              Copy
            </button>
          </div>
        `;
        addressesList.appendChild(addrDiv);
      });
      
      // Show format and wallet info if available
      if (result.result.formatInfo || result.result.walletInfo) {
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = 'padding:0.5rem; margin-bottom:0.5rem; background:rgba(112,199,186,0.1); border-radius:6px; border:1px solid rgba(112,199,186,0.3); font-size:0.85rem;';
        let infoText = '';
        if (result.result.formatInfo) {
          infoText += `Format: ${result.result.formatInfo.description}`;
        }
        if (result.result.walletInfo) {
          infoText += infoText ? ` | Wallet: ${result.result.walletInfo.wallet}` : `Wallet: ${result.result.walletInfo.wallet}`;
        }
        infoDiv.textContent = infoText;
        addressesList.insertBefore(infoDiv, addressesList.firstChild);
      }
      
      // Add copy button handlers
      addressesList.querySelectorAll('.copy-kpub-address').forEach(btn => {
        btn.addEventListener('click', async () => {
          const address = btn.dataset.address;
          try {
            await navigator.clipboard.writeText(address);
            showMessage('Address copied to clipboard', 'success');
          } catch (err) {
            // Fallback
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
        });
      });
      
      addressesResult.style.display = 'block';
      showMessage(`Generated ${result.result.count} address(es) from KPUB/XPUB`, 'success');
    } else {
      showMessage(result.error || 'Failed to generate addresses from KPUB/XPUB', 'error');
    }
  } catch (error) {
    showMessage(error.message || 'Failed to generate addresses from KPUB/XPUB', 'error');
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

// Copy KPUB button
const copyKpubBtn = document.getElementById('copy-wallet-kpub');

if (copyKpubBtn) {
  copyKpubBtn.addEventListener('click', async () => {
    const kpub = document.getElementById('wallet-kpub').textContent.trim();
    if (kpub && kpub !== 'Not available') {
      try {
        await navigator.clipboard.writeText(kpub);
        showMessage('KPUB copied to clipboard', 'success');
      } catch (e) {
        // Fallback
        const textArea = document.createElement('textarea');
        textArea.value = kpub;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showMessage('KPUB copied to clipboard', 'success');
      }
    } else {
      showMessage('No KPUB available to copy', 'error');
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


// Fee estimation listeners
document.getElementById('send-address').addEventListener('input', estimateFeeForSend);
document.getElementById('send-amount').addEventListener('input', estimateFeeForSend);

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
      document.getElementById('fee-estimation').style.display = 'none';
      
      // Immediately refresh to show the new transaction
      loadWalletBalance();
      loadTransactionHistory(true);
      
      // Also refresh again after 5 seconds to catch early confirmations
      setTimeout(() => {
        loadTransactionHistory(true);
      }, 5000);
    } else {
      showMessage(result.error, 'error');
    }
  } catch (error) {
    showMessage(error.message, 'error');
  }
});

// Transaction history refresh button
document.getElementById('refresh-transactions').addEventListener('click', () => {
  loadTransactionHistory(true);
});

// Load more transactions button
document.getElementById('load-more-transactions').addEventListener('click', () => {
  loadTransactionHistory(false);
});

// ==================== Address Book Functions ====================

// Load and display address book
async function loadAddressBook() {
  try {
    const result = await electronAPI.wallet.addressBook.list();
    if (result.success) {
      renderAddressBook(result.addresses);
      updateAddressBookDropdown(result.addresses);
    } else {
      showMessage(`Failed to load address book: ${result.error}`, 'error');
    }
  } catch (error) {
    showMessage(`Error loading address book: ${error.message}`, 'error');
  }
}

// Render address book list
function renderAddressBook(addresses) {
  const listEl = document.getElementById('addressbook-list');
  
  if (!addresses || addresses.length === 0) {
    listEl.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-secondary);">No addresses saved. Add your first address above.</div>';
    return;
  }
  
  // Group by category
  const byCategory = {};
  addresses.forEach(addr => {
    const cat = addr.category || 'General';
    if (!byCategory[cat]) {
      byCategory[cat] = [];
    }
    byCategory[cat].push(addr);
  });
  
  // Sort categories
  const categories = Object.keys(byCategory).sort();
  
  let html = '';
  categories.forEach(category => {
    html += `<div style="margin-bottom:1.5rem;">`;
    html += `<h4 style="font-size:0.9rem; font-weight:600; color:var(--kaspa-primary); margin-bottom:0.75rem; padding-bottom:0.5rem; border-bottom:1px solid rgba(112,199,186,0.2);">${category}</h4>`;
    
    byCategory[category].forEach(entry => {
      html += `
        <div class="addressbook-entry" style="padding:0.75rem; margin-bottom:0.5rem; background:rgba(255,255,255,0.05); border-radius:8px; border:1px solid rgba(112,199,186,0.1); display:flex; justify-content:space-between; align-items:center;">
          <div style="flex:1; min-width:0;">
            <div style="font-weight:600; color:var(--text-primary); margin-bottom:0.25rem; font-size:0.9rem;">${escapeHtml(entry.label)}</div>
            <div style="font-family:ui-monospace, Menlo, Consolas, 'Courier New', monospace; font-size:0.8rem; color:var(--text-secondary); word-break:break-all;">${escapeHtml(entry.address)}</div>
          </div>
          <div style="display:flex; gap:0.5rem; margin-left:1rem; flex-shrink:0;">
            <button class="btn btn-secondary btn-sm addressbook-use-btn" data-address="${escapeHtml(entry.address)}" title="Use in Send Funds">Use</button>
            <button class="btn btn-secondary btn-sm addressbook-edit-btn" data-id="${entry.id}" title="Edit">Edit</button>
            <button class="btn btn-danger btn-sm addressbook-delete-btn" data-id="${entry.id}" title="Delete">Delete</button>
          </div>
        </div>
      `;
    });
    
    html += `</div>`;
  });
  
  listEl.innerHTML = html;
  
  // Attach event listeners
  document.querySelectorAll('.addressbook-use-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const address = e.target.getAttribute('data-address');
      document.getElementById('send-address').value = address;
      document.getElementById('send-address').dispatchEvent(new Event('input')); // Trigger fee estimation
      // Scroll to send funds section
      document.getElementById('wallet-send-content').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      showMessage(`Address copied to send form`, 'success');
    });
  });
  
  document.querySelectorAll('.addressbook-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.getAttribute('data-id');
      if (confirm('Are you sure you want to delete this address?')) {
        try {
          const result = await electronAPI.wallet.addressBook.remove(id);
          if (result.success) {
            showMessage('Address removed from address book', 'success');
            loadAddressBook();
          } else {
            showMessage(result.error, 'error');
          }
        } catch (error) {
          showMessage(`Failed to remove address: ${error.message}`, 'error');
        }
      }
    });
  });
  
  document.querySelectorAll('.addressbook-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.target.getAttribute('data-id');
      const entry = addresses.find(a => a.id === id);
      if (entry) {
        // Populate form for editing
        document.getElementById('addressbook-address').value = entry.address;
        document.getElementById('addressbook-label').value = entry.label;
        document.getElementById('addressbook-category').value = entry.category || 'General';
        
        // Change submit button to "Update"
        const form = document.getElementById('addressbook-add-form');
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.textContent = 'Update Address';
        submitBtn.dataset.editId = id;
        
        // Scroll to form
        form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  });
}

// Update address book dropdown in Send Funds form
function updateAddressBookDropdown(addresses) {
  const selectEl = document.getElementById('send-address-select');
  if (!selectEl) return;
  
  // Clear existing options (except the first one)
  selectEl.innerHTML = '<option value="">From Address Book</option>';
  
  if (!addresses || addresses.length === 0) {
    selectEl.innerHTML = '<option value="">No saved addresses</option>';
    return;
  }
  
  // Group by category
  const byCategory = {};
  addresses.forEach(addr => {
    const cat = addr.category || 'General';
    if (!byCategory[cat]) {
      byCategory[cat] = [];
    }
    byCategory[cat].push(addr);
  });
  
  // Add options grouped by category
  Object.keys(byCategory).sort().forEach(category => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = category;
    
    byCategory[category].forEach(entry => {
      const option = document.createElement('option');
      option.value = entry.address;
      option.textContent = `${entry.label} - ${entry.address.substring(0, 20)}...`;
      optgroup.appendChild(option);
    });
    
    selectEl.appendChild(optgroup);
  });
}

// Address book form submit
document.getElementById('addressbook-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const address = document.getElementById('addressbook-address').value.trim();
  const label = document.getElementById('addressbook-label').value.trim();
  const category = document.getElementById('addressbook-category').value;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const editId = submitBtn.dataset.editId;
  
  try {
    if (editId) {
      // Update existing address
      const result = await electronAPI.wallet.addressBook.update(editId, {
        address,
        label,
        category
      });
      
      if (result.success) {
        showMessage('Address updated successfully', 'success');
        e.target.reset();
        submitBtn.textContent = 'Add Address';
        delete submitBtn.dataset.editId;
        loadAddressBook();
      } else {
        showMessage(result.error, 'error');
      }
    } else {
      // Add new address
      const result = await electronAPI.wallet.addressBook.add(address, label, category);
      
      if (result.success) {
        showMessage('Address added to address book', 'success');
        e.target.reset();
        loadAddressBook();
      } else {
        showMessage(result.error, 'error');
      }
    }
  } catch (error) {
    showMessage(`Failed to save address: ${error.message}`, 'error');
  }
});

// Address book dropdown selection
document.getElementById('send-address-select').addEventListener('change', (e) => {
  const selectedAddress = e.target.value;
  if (selectedAddress) {
    document.getElementById('send-address').value = selectedAddress;
    document.getElementById('send-address').dispatchEvent(new Event('input')); // Trigger fee estimation
    e.target.value = ''; // Reset dropdown
  }
});

// Refresh address book button
document.getElementById('refresh-addressbook').addEventListener('click', loadAddressBook);


// Node Status Management
let nodeStatusData = null;

async function updateNodeStatusIndicator(status) {
  const indicator = document.getElementById('node-status-indicator');
  const dot = indicator.querySelector('.status-dot');
  const text = document.getElementById('node-status-text');
  const portBadgesContainer = document.getElementById('port-badges');
  
  if (!status) {
    dot.className = 'status-dot';
    text.textContent = 'Checking...';
    if (portBadgesContainer) {
      portBadgesContainer.innerHTML = '';
    }
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
  
  // Update port badges
  try {
    const portInfo = await electronAPI.node.getPortInfo();
    if (portInfo && portInfo.success) {
      updatePortBadges(portInfo, status.status === 'connected');
    }
  } catch (err) {
    console.error('Failed to get port info:', err);
    if (portBadgesContainer) {
      portBadgesContainer.innerHTML = '';
    }
  }
  
  // Store status data
  nodeStatusData = status;
}

// Helper function to get current node mode
async function getCurrentNodeMode() {
  try {
    const result = await electronAPI.node.getMode();
    return result.success ? result.mode : 'private';
  } catch {
    return 'private';
  }
}

function updatePortBadges(portInfo, nodeConnected) {
  const portBadgesContainer = document.getElementById('port-badges');
  if (!portBadgesContainer) return;
  
  portBadgesContainer.innerHTML = '';
  
  if (!portInfo) return;
  
  // GRPC/HTTP RPC Port (Node) - Standard port 16110
  if (portInfo.grpcPort) {
    const isListening = portInfo.grpcListening !== undefined ? portInfo.grpcListening : nodeConnected;
    const grpcBadge = createPortBadge('GRPC', portInfo.grpcPort, isListening, `HTTP/GRPC RPC server (${isListening ? 'Listening' : 'Not listening'})`);
    portBadgesContainer.appendChild(grpcBadge);
  }
  
  // P2P Port (Node) - Standard port 16111
  if (portInfo.p2pPort) {
    const isListening = portInfo.p2pListening !== undefined ? portInfo.p2pListening : nodeConnected;
    const p2pBadge = createPortBadge('P2P', portInfo.p2pPort, isListening, `P2P network server (${isListening ? 'Listening' : 'Not listening'})`);
    portBadgesContainer.appendChild(p2pBadge);
  }
  
  // WRPC/WebSocket Port (Node) - Standard port 17110 (or from config)
  if (portInfo.wrpcPort) {
    const isListening = portInfo.wrpcListening !== undefined ? portInfo.wrpcListening : nodeConnected;
    const wrpcBadge = createPortBadge('WRPC', portInfo.wrpcPort, isListening, `WebSocket RPC (Borsh) (${isListening ? 'Connected' : 'Disconnected'})`);
    portBadgesContainer.appendChild(wrpcBadge);
  }
  
  // Mining Pool Port - Only show if pool is running
  if (portInfo.poolPort && portInfo.poolRunning) {
    const poolBadge = createPortBadge('Pool', portInfo.poolPort, true, 'Stratum mining pool (Active)');
    portBadgesContainer.appendChild(poolBadge);
  }
  
  // API Port - Only show if pool is running
  if (portInfo.apiPort && portInfo.poolRunning) {
    const apiBadge = createPortBadge('API', portInfo.apiPort, true, 'Mining pool API (Active)');
    portBadgesContainer.appendChild(apiBadge);
  }
}

function createPortBadge(label, port, active, tooltip) {
  const badge = document.createElement('div');
  badge.className = `port-badge ${active ? 'port-active' : 'port-inactive'}`;
  badge.title = tooltip || `${label} Port ${port}`;
  
  badge.innerHTML = `
    <span class="port-label">${label}</span>
    <span class="port-number">${port}</span>
  `;
  
  return badge;
}

// Listen for node status updates (handled below after modal setup)

// Formatting utilities (from utils/formatting.js)
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function formatDuration(ms) {
  if (!ms) return 'N/A';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatNumber(num) {
  if (num === null || num === undefined) return 'N/A';
  if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toString();
}

function formatNumberWithSeparators(num) {
  if (num === null || num === undefined) return 'N/A';
  return Number(num).toLocaleString('en-US');
}

function formatNumberPrecise(num, precision = 3) {
  if (num === null || num === undefined) return 'N/A';
  if (num >= 1e12) return (num / 1e12).toFixed(precision) + 'T';
  if (num >= 1e9) return (num / 1e9).toFixed(precision) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(precision) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(precision) + 'K';
  return num.toString();
}

// ============================================
// Coinjoin UI Functions
// ============================================

// Coinjoin UI Functions
document.addEventListener('DOMContentLoaded', () => {
  // Create zero-trust coinjoin button
  document.getElementById('create-zerotrust-coinjoin')?.addEventListener('click', () => {
    openCoinjoinCreateModal('zero-trust');
  });
  
  // Coinjoin create modal functions
  function openCoinjoinCreateModal(mode) {
    const modal = document.getElementById('coinjoin-create-modal');
    const title = document.getElementById('coinjoin-modal-title');
    const form = document.getElementById('coinjoin-create-form');
    
    if (!modal || !title || !form) return;
    
    // Reset form
    form.reset();
    
    const zeroTrustFields = document.getElementById('coinjoin-zerotrust-fields');
    const amountField = document.getElementById('coinjoin-amount');
    
    const amountHelp = document.getElementById('coinjoin-amount-help');
    const amountZeroTrustNote = document.getElementById('coinjoin-amount-zerotrust-note');
    
    // Make amount field easier to edit - select all text on focus
    if (amountField) {
      // Select all text on focus for easy editing
      amountField.addEventListener('focus', function() {
        this.select();
      });
      
      // Also allow click to select all
      amountField.addEventListener('click', function() {
        this.select();
      });
    }
    
    // Always use zero-trust mode
    title.textContent = 'Create Zero-Trust Coinjoin Session';
    if (zeroTrustFields) zeroTrustFields.style.display = 'block';
    if (amountField) amountField.required = false;
    document.getElementById('coinjoin-utxos').required = true;
    if (amountHelp) amountHelp.style.display = 'none';
    if (amountZeroTrustNote) amountZeroTrustNote.style.display = 'block';
    
    // Initialize zero-trust helpers
    initializeZeroTrustHelpers();
    
    modal.classList.remove('hidden');
  }
  
  // UTXO selection algorithm: selects UTXOs that total approximately the target amount
  // Expose globally so it can be used in form submission
  window.selectUtxosForAmount = (utxos, targetAmountSompi) => {
    if (!targetAmountSompi || targetAmountSompi <= 0n) {
      // No target amount specified, return all UTXOs
      return utxos;
    }
    
    // Sort UTXOs by amount (smallest first) for better selection
    const sortedUtxos = [...utxos].sort((a, b) => {
      const aAmount = BigInt(String(a.amount || '0'));
      const bAmount = BigInt(String(b.amount || '0'));
      return aAmount < bAmount ? -1 : (aAmount > bAmount ? 1 : 0);
    });
    
    // CRITICAL: No tolerance - must match EXACTLY for CoinJoin fairness
    // CoinJoin requires exact input amounts, so we only accept exact matches
    const minAmount = targetAmountSompi;
    const maxAmount = targetAmountSompi;
    
    // Try to find a combination that matches the target amount
    // First, try to find a single UTXO that matches
    for (const utxo of sortedUtxos) {
      const amount = BigInt(String(utxo.amount || '0'));
      if (amount >= minAmount && amount <= maxAmount) {
        return [utxo];
      }
    }
    
    // If no single UTXO matches, use greedy algorithm to select smallest UTXOs until we reach target
    const selected = [];
    let total = 0n;
    
    for (const utxo of sortedUtxos) {
      const amount = BigInt(String(utxo.amount || '0'));
      if (total + amount <= maxAmount) {
        selected.push(utxo);
        total += amount;
        if (total >= minAmount) {
          // We've reached the target range
          break;
        }
      }
    }
    
    // If we couldn't reach the minimum, try to get as close as possible
    if (total < minAmount && sortedUtxos.length > 0) {
      // Add the smallest UTXO that gets us closest to target
      for (const utxo of sortedUtxos) {
        if (!selected.find(s => s.transactionId === utxo.transactionId && s.index === utxo.index)) {
          const amount = BigInt(String(utxo.amount || '0'));
          if (total + amount <= targetAmountSompi) {
            selected.push(utxo);
            total += amount;
            break;
          }
        }
      }
    }
    
    // If still no UTXOs selected or total is too low, return empty array
    // This ensures we don't accidentally use all UTXOs when they don't match the target
    // The calling code should handle this by creating a new matching UTXO
    if (selected.length === 0 || total < minAmount) {
      console.warn(`[Coinjoin] Could not select UTXOs for target ${(Number(targetAmountSompi) / 1e8).toFixed(8)} KAS. Available: ${utxos.length} UTXOs. Returning empty selection - UTXO creation should be triggered.`);
      return []; // Return empty - don't use all UTXOs
    }
    
    return selected;
  };
  
  // Initialize zero-trust helper functions
  function initializeZeroTrustHelpers() {
    // Manual section toggle
    const manualToggle = document.getElementById('zerotrust-manual-toggle');
    const manualSection = document.getElementById('zerotrust-manual-section');
    if (manualToggle && manualSection) {
      manualToggle.addEventListener('click', () => {
        const isVisible = manualSection.style.display !== 'none';
        manualSection.style.display = isVisible ? 'none' : 'block';
        manualToggle.textContent = isVisible ? '📝 Or enter UTXOs manually' : '✖️ Hide manual entry';
      });
    }
    
    // Help toggle (legacy - may not exist anymore)
    const helpToggle = document.getElementById('zerotrust-help-toggle');
    const helpContent = document.getElementById('zerotrust-help-content');
    if (helpToggle && helpContent) {
      helpToggle.addEventListener('click', () => {
        const isVisible = helpContent.style.display !== 'none';
        helpContent.style.display = isVisible ? 'none' : 'block';
        helpToggle.textContent = isVisible ? 'Show Guide' : 'Hide Guide';
      });
    }
    
    // Example template loader
    const loadExampleBtn = document.getElementById('zerotrust-load-example');
    const utxosTextarea = document.getElementById('coinjoin-utxos');
    const amountInput = document.getElementById('coinjoin-amount');
    
    // Function to calculate and update amount from UTXOs
    // Expose it globally so it can be called from async handlers
    // If skipIfTargetSet is true, it won't update if amount field already has a user-specified value
    const updateAmountFromUtxos = (skipIfTargetSet = false) => {
      if (!utxosTextarea || !amountInput) return;
      
      // If skipIfTargetSet is true and amount field has a value, don't override it
      if (skipIfTargetSet && amountInput.value.trim() && !amountInput.hasAttribute('data-auto-calculated')) {
        return; // User has set a target amount, don't override it
      }
      
      const utxosText = utxosTextarea.value.trim();
      if (!utxosText) {
        // Reset to default if UTXOs are cleared
        if (amountInput.hasAttribute('data-auto-calculated')) {
          amountInput.value = '1';
          amountInput.removeAttribute('data-auto-calculated');
          amountInput.style.backgroundColor = '';
        }
        return;
      }
      
      try {
        const utxos = JSON.parse(utxosText);
        if (!Array.isArray(utxos) || utxos.length === 0) {
          return;
        }
        
        // Calculate total from UTXOs
        let totalSompi = 0n;
        for (const utxo of utxos) {
          if (utxo.amount) {
            try {
              const amount = BigInt(String(utxo.amount));
              totalSompi += amount;
            } catch (e) {
              // Skip invalid amounts
            }
          }
        }
        
        if (totalSompi > 0n) {
          // Convert to KAS and update amount field
          const totalKAS = Number(totalSompi) / 1e8;
          amountInput.value = totalKAS.toFixed(8);
          amountInput.setAttribute('data-auto-calculated', 'true');
          amountInput.style.backgroundColor = '#e8f5e9'; // Light green to indicate auto-calculated
        }
      } catch (err) {
        // Invalid JSON or parsing error - ignore
      }
    };
    
    // Expose function globally for use in async handlers
    window.updateAmountFromUtxos = updateAmountFromUtxos;
    
    // Listen for changes in UTXOs textarea
    if (utxosTextarea) {
      // Use both 'input' and 'paste' events to catch all changes
      // Only auto-calculate if amount field doesn't have a user-specified value
      utxosTextarea.addEventListener('input', () => {
        // Check if amount field has a user-specified value (not auto-calculated)
        if (amountInput && amountInput.value.trim() && !amountInput.hasAttribute('data-auto-calculated')) {
          // User has specified an amount, don't override it
          return;
        }
        updateAmountFromUtxos();
      });
      utxosTextarea.addEventListener('paste', () => {
        // Delay to allow paste to complete
        setTimeout(() => {
          // Check if amount field has a user-specified value (not auto-calculated)
          if (amountInput && amountInput.value.trim() && !amountInput.hasAttribute('data-auto-calculated')) {
            // User has specified an amount, don't override it
            return;
          }
          updateAmountFromUtxos();
        }, 10);
      });
    }
    
    // Mark amount field as user-specified when user manually enters a value
    if (amountInput) {
      amountInput.addEventListener('input', () => {
        // When user types in amount field, mark it as user-specified
        if (amountInput.value.trim()) {
          amountInput.removeAttribute('data-auto-calculated');
          amountInput.style.backgroundColor = ''; // Remove green background
        }
      });
      amountInput.addEventListener('change', () => {
        // When amount field loses focus, mark it as user-specified if it has a value
        if (amountInput.value.trim()) {
          amountInput.removeAttribute('data-auto-calculated');
          amountInput.style.backgroundColor = ''; // Remove green background
        }
      });
    }
    
    if (loadExampleBtn && utxosTextarea) {
      loadExampleBtn.addEventListener('click', () => {
        const example = `[
  {
    "transactionId": "abc123def456...",
    "index": 0,
    "amount": "100000000"
  },
  {
    "transactionId": "def456ghi789...",
    "index": 1,
    "amount": "200000000"
  }
]`;
        utxosTextarea.value = example;
        updateAmountFromUtxos(); // Calculate amount from example
        showMessage('Example template loaded! Replace with your actual UTXO data.', 'info');
      });
    }
    
    // Fetch UTXOs from address
    const fetchBtn = document.getElementById('zerotrust-fetch-utxos-btn');
    const fetchSection = document.getElementById('zerotrust-fetch-section');
    const fetchAddressInput = document.getElementById('zerotrust-fetch-address');
    const fetchExecuteBtn = document.getElementById('zerotrust-fetch-btn');
    const fetchCancelBtn = document.getElementById('zerotrust-fetch-cancel');
    
    if (fetchBtn && fetchSection) {
      fetchBtn.addEventListener('click', () => {
        fetchSection.style.display = fetchSection.style.display === 'none' ? 'block' : 'none';
      });
    }
    
    if (fetchCancelBtn && fetchSection) {
      fetchCancelBtn.addEventListener('click', () => {
        fetchSection.style.display = 'none';
        if (fetchAddressInput) fetchAddressInput.value = '';
      });
    }
    
    // "Use My Wallet" button for destination address only
    const destinationUseWalletBtn = document.getElementById('coinjoin-destination-use-wallet');
    if (destinationUseWalletBtn) {
      destinationUseWalletBtn.addEventListener('click', async () => {
        try {
          // Check if wallet is imported
          const walletInfo = await electronAPI.wallet.info();
          if (!walletInfo || !walletInfo.wallet || !walletInfo.wallet.address) {
            showMessage('Please import your wallet first in the Wallet tab', 'warning');
            return;
          }
          
          const walletAddress = walletInfo.wallet.address;
          const destinationInput = document.getElementById('coinjoin-destination');
          if (destinationInput) {
            destinationInput.value = walletAddress;
            showMessage('Destination address filled with your wallet address', 'success');
          }
        } catch (err) {
          showMessage(`Error: ${err.message}`, 'error');
          console.error('Error getting wallet address:', err);
        }
      });
    }
    
    // "Use My Wallet" button for UTXOs - auto-fetch UTXOs and optionally fill destination from imported wallet
    const useWalletBtn = document.getElementById('zerotrust-fetch-wallet-btn');
    if (useWalletBtn && utxosTextarea) {
      useWalletBtn.addEventListener('click', async () => {
        try {
          // Check if wallet is imported
          const walletInfo = await electronAPI.wallet.info();
          if (!walletInfo) {
            showMessage('Please import your wallet first in the Wallet tab', 'warning');
            return;
          }
          
          // Handle different wallet info structures
          let walletAddress = null;
          if (walletInfo.wallet && walletInfo.wallet.address) {
            walletAddress = walletInfo.wallet.address;
          } else if (walletInfo.address) {
            walletAddress = walletInfo.address;
          } else {
            showMessage('Wallet address not found. Please re-import your wallet.', 'error');
            console.error('[Coinjoin] Wallet info structure:', walletInfo);
            return;
          }
          
          if (!walletAddress || typeof walletAddress !== 'string' || walletAddress.trim() === '') {
            showMessage('Invalid wallet address. Please re-import your wallet.', 'error');
            console.error('[Coinjoin] Invalid wallet address:', walletAddress);
            return;
          }
          
          // Get all existing coinjoin sessions to exclude their UTXOs
          // This ensures each session gets a fresh UTXO even if using the same address
          // CRITICAL: Always exclude UTXOs from ALL previous sessions (including completed ones)
          // This ensures we never reuse UTXOs, even from old sessions
          let excludeUtxos = [];
          try {
            const allSessions = await electronAPI.coinjoin.list();
            for (const { session } of allSessions) {
              if (session.zeroTrustMode) {
                // Get UTXOs from all sources (revealed, original, committed)
                // Include completed sessions to prevent reuse
                const sessionUtxos = session.revealedUtxos || session.originalUtxos || [];
                excludeUtxos.push(...sessionUtxos);
              }
            }
            console.log(`[Coinjoin] Excluding ${excludeUtxos.length} UTXO(s) from all previous sessions (including completed)`);
          } catch (err) {
            console.warn('[Coinjoin] Could not get existing sessions for exclusion:', err);
          }
          
          // Get target amount from amount field if specified
          // CRITICAL: Parse with exact precision (same as form submission)
          const amountInput = document.getElementById('coinjoin-amount');
          let targetAmountSompi = null;
          if (amountInput && amountInput.value.trim()) {
            const amountKAS = amountInput.value.trim();
            
            // Validate format: must be a valid decimal number
            if (!/^\d+(\.\d+)?$/.test(amountKAS)) {
              showMessage('Amount must be a valid number (e.g., 1.5 or 1.50000000)', 'error');
              return;
            }
            
            // Split into integer and decimal parts
            const parts = amountKAS.split('.');
            const integerPart = parts[0] || '0';
            const decimalPart = parts[1] || '';
            
            // Validate decimal precision (max 8 digits for sompi)
            if (decimalPart.length > 8) {
              showMessage(`Amount precision too high. Maximum 8 decimal places (e.g., 1.12345678 KAS). Got ${decimalPart.length} decimal places.`, 'error');
              return;
            }
            
            // Convert to sompi with exact precision (same as test script)
            const integerSompi = BigInt(integerPart) * 100000000n;
            const decimalSompi = BigInt((decimalPart.padEnd(8, '0').substring(0, 8)));
            targetAmountSompi = integerSompi + decimalSompi;
            
            // Validate minimum amount (1 KAS = 100000000 sompi)
            if (targetAmountSompi < 100000000n) {
              showMessage('Amount must be at least 1 KAS', 'error');
              return;
            }
            
            const amountKASNum = Number(targetAmountSompi) / 1e8;
            
            // CRITICAL: Follow test script procedure exactly
            // 1. Check if matching UTXO exists (excluding already used ones)
            showMessage(`Checking for matching UTXO (${amountKASNum.toFixed(8)} KAS)...`, 'info');
            const hasMatch = await electronAPI.wallet.hasMatchingUtxo(targetAmountSompi.toString(), 0, excludeUtxos); // 0 tolerance for exact match
            
            if (!hasMatch.success) {
              showMessage(`Error checking UTXOs: ${hasMatch.error}`, 'error');
              return;
            }
            
            let createResult = null;
            
            if (hasMatch.hasMatch) {
              // A matching UTXO exists, but we want to create a fresh one (same as test script)
              // Force creation by calling sendFromWallet directly
              showMessage(`Matching UTXO exists, but creating fresh UTXO to avoid reuse...`, 'info');
              
              // CRITICAL: Re-verify walletAddress before using it (may have been lost in scope)
              let sendWalletAddress = walletAddress;
              if (!sendWalletAddress || typeof sendWalletAddress !== 'string' || sendWalletAddress.trim() === '') {
                // Re-fetch wallet address if lost
                try {
                  const walletInfoRetry = await electronAPI.wallet.info();
                  if (walletInfoRetry && walletInfoRetry.wallet && walletInfoRetry.wallet.address) {
                    sendWalletAddress = walletInfoRetry.wallet.address;
                  } else if (walletInfoRetry && walletInfoRetry.address) {
                    sendWalletAddress = walletInfoRetry.address;
                  } else {
                    showMessage('Invalid wallet address. Cannot create UTXO. Please re-import your wallet.', 'error');
                    console.error('[Coinjoin] walletAddress is invalid and could not be retrieved:', walletAddress);
                    return;
                  }
                } catch (err) {
                  showMessage(`Failed to get wallet address: ${err.message}`, 'error');
                  console.error('[Coinjoin] Error retrieving wallet address:', err);
                  return;
                }
              }
              
              try {
                showMessage(`Sending ${amountKASNum.toFixed(8)} KAS to ${sendWalletAddress} to create fresh UTXO...`, 'info');
                
                // Call wallet.send - preload.js wraps two arguments into { address, amountKAS } object
                const sendResult = await electronAPI.wallet.send(sendWalletAddress, amountKASNum);
                
                if (!sendResult.success || !sendResult.result) {
                  const errorMsg = sendResult.error || 'Unknown error';
                  showMessage(`Failed to create fresh UTXO: ${errorMsg}. Please ensure you have sufficient balance (need ${amountKASNum.toFixed(8)} KAS + fees).`, 'error');
                  console.error('[Coinjoin] Send result:', sendResult);
                  return;
                }
                
                createResult = {
                  success: true,
                  created: true,
                  txId: sendResult.result.txId,
                  alreadyInMempool: false,
                  message: `Forced creation of fresh UTXO via transaction ${sendResult.result.txId}`
                };
                
                showMessage(`✅ Fresh UTXO creation transaction submitted: ${sendResult.result.txId}`, 'success');
              } catch (err) {
                showMessage(`Error forcing UTXO creation: ${err.message}. Please ensure you have sufficient balance (need ${amountKASNum.toFixed(8)} KAS + fees).`, 'error');
                return;
              }
            } else {
              // No matching UTXO exists, use createMatchingUtxo normally
              showMessage(`No matching UTXO found. Creating one by sending ${amountKASNum.toFixed(8)} KAS to yourself...`, 'info');
              
              createResult = await electronAPI.wallet.createMatchingUtxo(targetAmountSompi.toString(), excludeUtxos);
              if (!createResult.success) {
                showMessage(`Failed to create matching UTXO: ${createResult.error}. Please ensure you have sufficient balance (need ${amountKASNum.toFixed(8)} KAS + fees).`, 'error');
                return;
              }
            }
            
            // Wait for UTXO confirmation (same as test script)
            if (createResult && createResult.created) {
              const message = createResult.alreadyInMempool 
                ? `Transaction ${createResult.txId} is already in mempool. Waiting for confirmation...`
                : `Transaction created: ${createResult.txId}. Waiting for confirmation...`;
              showMessage(message, 'info');
              
              // Wait for UTXO to be confirmed (with longer timeout for larger amounts, same as test script)
              const timeoutMs = amountKASNum >= 1.5 ? 180000 : 60000; // 3 minutes for 1.5+ KAS, 1 minute otherwise
              const waitResult = await electronAPI.wallet.waitForUtxo(
                targetAmountSompi.toString(), 
                timeoutMs, 
                3000, // Check every 3 seconds (same as test script)
                createResult.txId,
                excludeUtxos
              );
              
              if (!waitResult.success || !waitResult.confirmed) {
                showMessage(`UTXO creation transaction submitted but not yet confirmed. Transaction ID: ${createResult.txId}. You can try again in a moment.`, 'warning');
                return;
              }
              
              // CRITICAL: Verify exact amount (same as test script)
              if (waitResult.utxo) {
                console.log('[Coinjoin] waitResult.utxo:', waitResult.utxo);
                console.log('[Coinjoin] waitResult.utxo.amount:', waitResult.utxo.amount, 'type:', typeof waitResult.utxo.amount);
                
                // Try multiple ways to extract the amount
                let utxoAmount = 0n;
                try {
                  const amountStr = String(waitResult.utxo.amount || '0');
                  console.log('[Coinjoin] Amount as string:', amountStr);
                  utxoAmount = BigInt(amountStr);
                  console.log('[Coinjoin] Amount as BigInt:', utxoAmount.toString());
                } catch (err) {
                  console.error('[Coinjoin] Error parsing UTXO amount:', err);
                  console.error('[Coinjoin] Full waitResult:', JSON.stringify(waitResult, null, 2));
                  showMessage(
                    `ERROR: Could not parse UTXO amount. Received: ${JSON.stringify(waitResult.utxo.amount)}. ` +
                    `Please check the console for details.`,
                    'error'
                  );
                  return;
                }
                
                const expectedAmount = targetAmountSompi;
                console.log('[Coinjoin] Expected amount:', expectedAmount.toString(), 'Received:', utxoAmount.toString());
                
                if (utxoAmount !== expectedAmount) {
                  const diff = utxoAmount > expectedAmount 
                    ? (Number(utxoAmount - expectedAmount) / 1e8).toFixed(8)
                    : (Number(expectedAmount - utxoAmount) / 1e8).toFixed(8);
                  console.error(`[Coinjoin] Amount mismatch! Expected: ${expectedAmount.toString()}, Got: ${utxoAmount.toString()}`);
                  showMessage(
                    `ERROR: UTXO amount ${(Number(utxoAmount) / 1e8).toFixed(8)} KAS does NOT match expected ${(Number(expectedAmount) / 1e8).toFixed(8)} KAS (difference: ${diff} KAS). ` +
                    `This will fail CoinJoin validation which requires exact matching. ` +
                    `Check console for details.`,
                    'error'
                  );
                  return;
                } else {
                  showMessage(`✅ UTXO amount verified: Exactly ${(Number(utxoAmount) / 1e8).toFixed(8)} KAS as expected`, 'success');
                }
              } else {
                console.warn('[Coinjoin] waitResult.utxo is missing:', waitResult);
                showMessage(`Warning: UTXO confirmed but amount could not be verified. Proceeding anyway...`, 'warning');
              }
              
              showMessage(`✅ Matching UTXO confirmed! Now fetching and populating UTXOs...`, 'success');
              
              // Small delay to ensure UTXO is fully available in the network
              await new Promise(resolve => setTimeout(resolve, 2000));
            } else if (createResult && !createResult.created) {
              // createMatchingUtxo returned created: false - shouldn't happen in this flow
              showMessage(`Matching UTXO already exists. Will use existing UTXO when fetching.`, 'info');
            }
          } else {
            showMessage('Fetching UTXOs from your wallet...', 'info');
          }
          
          // CRITICAL: Ensure walletAddress is still accessible (may have been lost during async operations)
          // Re-fetch if needed before using it
          if (!walletAddress || typeof walletAddress !== 'string' || walletAddress.trim() === '') {
            try {
              const walletInfoRetry = await electronAPI.wallet.info();
              if (walletInfoRetry && walletInfoRetry.wallet && walletInfoRetry.wallet.address) {
                walletAddress = walletInfoRetry.wallet.address;
              } else if (walletInfoRetry && walletInfoRetry.address) {
                walletAddress = walletInfoRetry.address;
              } else {
                showMessage('Failed to get wallet address. Please re-import your wallet.', 'error');
                console.error('[Coinjoin] Could not retrieve wallet address after UTXO creation');
                return;
              }
            } catch (err) {
              showMessage(`Failed to get wallet address: ${err.message}`, 'error');
              console.error('[Coinjoin] Error retrieving wallet address:', err);
              return;
            }
          }
          
          // Auto-fill destination address with wallet address if not already filled
          // (where you want to receive mixed coins)
          const destinationInput = document.getElementById('coinjoin-destination');
          if (destinationInput && !destinationInput.value.trim()) {
            destinationInput.value = walletAddress;
          }
          
          // If we just created a UTXO, wait a moment and re-check to ensure it's available
          // Also re-fetch excludeUtxos in case new sessions were created
          if (targetAmountSompi && targetAmountSompi > 0n) {
            // Re-check excludeUtxos after potential UTXO creation
            try {
              const allSessions = await electronAPI.coinjoin.list();
              excludeUtxos = [];
              for (const { session } of allSessions) {
                // Include ALL zero-trust sessions (including completed) to prevent UTXO reuse
                if (session.zeroTrustMode) {
                  const sessionUtxos = session.revealedUtxos || session.originalUtxos || [];
                  excludeUtxos.push(...sessionUtxos);
                }
              }
              console.log(`[Coinjoin] Updated exclusion list: ${excludeUtxos.length} UTXO(s) from all sessions (including completed)`);
            } catch (err) {
              console.warn('[Coinjoin] Could not refresh existing sessions for exclusion:', err);
            }
          }
          
          // Fetch UTXOs (this happens after UTXO creation/confirmation)
          // CRITICAL: This MUST execute after UTXO confirmation to populate the form
          showMessage(`Fetching UTXOs from ${walletAddress}...`, 'info');
          
          // Preload.js expects address as argument, wraps it as { address }
          const utxos = await electronAPI.wallet.getUtxos(walletAddress);
          
          console.log('[Coinjoin] Raw UTXOs received from wallet:', utxos);
          console.log('[Coinjoin] UTXOs type:', typeof utxos);
          console.log('[Coinjoin] UTXOs is array:', Array.isArray(utxos));
          
          // Handle different response formats - IPC handler returns array directly
          let utxosArray = null;
          if (Array.isArray(utxos)) {
            utxosArray = utxos;
          } else if (utxos && utxos.entries && Array.isArray(utxos.entries)) {
            utxosArray = utxos.entries;
          } else if (utxos && utxos.success && utxos.entries) {
            utxosArray = utxos.entries;
          } else if (utxos && utxos.success && Array.isArray(utxos.utxos)) {
            utxosArray = utxos.utxos;
          } else {
            console.error('[Coinjoin] Unexpected UTXO response format:', utxos);
            showMessage('Unexpected response format from wallet. Please try again.', 'error');
            return;
          }
          
          if (!utxosArray || utxosArray.length === 0) {
            showMessage('No UTXOs found in your wallet. Make sure your wallet has received funds and the UTXO is confirmed. You may need to wait a moment for the newly created UTXO to appear.', 'warning');
            console.error('[Coinjoin] No UTXOs found. Raw response:', utxos);
            return;
          }
          
          console.log(`[Coinjoin] Processing ${utxosArray.length} UTXO(s)`);
          
          // Format UTXOs for coinjoin (same formatting logic)
          const formattedUtxos = utxosArray.map((utxo, idx) => {
            const txId = utxo.outpoint?.transactionId || 
                        utxo.entry?.outpoint?.transactionId ||
                        utxo.transactionId || 
                        utxo.txId || '';
            
            const index = utxo.outpoint?.index !== undefined 
                        ? utxo.outpoint.index 
                        : (utxo.entry?.outpoint?.index !== undefined
                            ? utxo.entry.outpoint.index
                            : (utxo.index !== undefined 
                                ? utxo.index 
                                : (utxo.outputIndex !== undefined 
                                    ? utxo.outputIndex 
                                    : 0)));
            
            let amount = '0';
            if (utxo.amount !== undefined && utxo.amount !== null) {
              amount = typeof utxo.amount === 'bigint' ? utxo.amount.toString() : String(utxo.amount);
            } else if (utxo.entry && utxo.entry.amount !== undefined && utxo.entry.amount !== null) {
              amount = typeof utxo.entry.amount === 'bigint' ? utxo.entry.amount.toString() : String(utxo.entry.amount);
            } else if (utxo.value !== undefined && utxo.value !== null) {
              amount = typeof utxo.value === 'bigint' ? utxo.value.toString() : String(utxo.value);
            }
            
            return {
              transactionId: txId,
              index: index,
              amount: amount
            };
          }).filter(utxo => {
            const hasTxId = utxo.transactionId && utxo.transactionId.length > 0;
            const hasAmount = utxo.amount && utxo.amount !== '0' && utxo.amount !== '0n';
            let amountBigInt = 0n;
            try {
              amountBigInt = BigInt(utxo.amount || '0');
            } catch (e) {
              return false;
            }
            return hasTxId && hasAmount && amountBigInt > 0n;
          });
          
          if (formattedUtxos.length === 0) {
            showMessage('No valid UTXOs found in your wallet. UTXOs must have a transaction ID and non-zero amount.', 'warning');
            return;
          }
          
          // Capture original target amount before any potential changes
          const originalTargetAmountSompi = targetAmountSompi;
          const originalTargetKAS = originalTargetAmountSompi ? Number(originalTargetAmountSompi) / 1e8 : null;
          
          // Filter out UTXOs that are already used in other sessions
          // This ensures each session gets a unique UTXO even if using the same address
          let availableUtxos = formattedUtxos;
          if (excludeUtxos && excludeUtxos.length > 0) {
            const excludedKeys = new Set();
            for (const excludedUtxo of excludeUtxos) {
              const txId = excludedUtxo.transactionId || excludedUtxo.txId || '';
              const index = excludedUtxo.index !== undefined ? excludedUtxo.index : 
                            (excludedUtxo.outputIndex !== undefined ? excludedUtxo.outputIndex : 0);
              excludedKeys.add(`${txId}:${index}`);
            }
            
            availableUtxos = formattedUtxos.filter(utxo => {
              const key = `${utxo.transactionId}:${utxo.index}`;
              return !excludedKeys.has(key);
            });
            
            if (availableUtxos.length < formattedUtxos.length) {
              console.log(`[Coinjoin] Filtered out ${formattedUtxos.length - availableUtxos.length} UTXO(s) already used in other sessions`);
            }
          }
          
          // Select UTXOs based on target amount if specified
          // IMPORTANT: When target amount is specified, we MUST only use UTXOs that match the target
          // This ensures each session commits to the correct amount
          let selectedUtxos = availableUtxos;
          if (targetAmountSompi && targetAmountSompi > 0n) {
            selectedUtxos = window.selectUtxosForAmount(availableUtxos, targetAmountSompi);
            
            const selectedTotal = selectedUtxos.reduce((sum, utxo) => sum + BigInt(String(utxo.amount || '0')), 0n);
            const selectedKAS = Number(selectedTotal) / 1e8;
            const targetKAS = originalTargetKAS || (Number(targetAmountSompi) / 1e8);
            
            // CRITICAL: Validate that selected UTXOs match EXACTLY - no tolerance
            // CoinJoin requires exact input amounts for fairness and security
            if (selectedTotal !== targetAmountSompi) {
              const difference = selectedTotal > targetAmountSompi 
                ? selectedTotal - targetAmountSompi 
                : targetAmountSompi - selectedTotal;
              const diffKAS = (Number(difference) / 1e8).toFixed(8);
              
              showMessage(
                `ERROR: Selected UTXOs (${selectedKAS.toFixed(8)} KAS) don't match target (${targetKAS.toFixed(8)} KAS) exactly. ` +
                `Difference: ${diffKAS} KAS. ` +
                `CoinJoin requires EXACT amount matching. Please try again or create a new UTXO with the exact amount.`,
                'error'
              );
              return;
            }
            
            if (selectedUtxos.length === 0) {
              // No matching UTXOs found after filtering
              // This can happen if:
              // 1. The matching UTXO was just created and not yet confirmed
              // 2. The matching UTXO is locked by a pending transaction
              // 3. All matching UTXOs are already committed to other sessions
              showMessage(`No available UTXOs matching ${targetKAS.toFixed(8)} KAS. Attempting to create a new UTXO...`, 'warning');
              
              // Try creating a matching UTXO
              // Note: createMatchingUtxo handles retries for locked UTXOs automatically
              const createResult = await electronAPI.wallet.createMatchingUtxo(targetAmountSompi.toString(), excludeUtxos);
              if (!createResult.success) {
                // Check if error is due to locked UTXO - if so, wait and retry
                if (createResult.error && (createResult.error.includes('locked') || createResult.error.includes('mempool'))) {
                  showMessage(`UTXO is locked by pending transaction. Waiting for confirmation... Please try again in a moment.`, 'warning');
                  return;
                }
                // Check if the error is "already exists" - in this case, we should use the existing UTXO
                if (createResult.error && createResult.error.includes('already exists')) {
                  showMessage(`Matching UTXO already exists. Will use existing UTXO when fetching.`, 'info');
                  // Continue to fetch UTXOs below - the matching one will be selected
                } else {
                  showMessage(`Failed to create matching UTXO: ${createResult.error}. Please try again in a moment.`, 'error');
                  return;
                }
              } else if (createResult.created || createResult.alreadyInMempool) {
                // UTXO creation transaction submitted (or already in mempool)
                // Wait for it to be confirmed before proceeding
                showMessage(`UTXO creation transaction submitted. Waiting for confirmation...`, 'info');
                
                // Wait for the specific UTXO from the transaction we just created
                const waitResult = await electronAPI.wallet.waitForUtxo(
                  targetAmountSompi.toString(), 
                  60000, 
                  2000,
                  createResult.txId, // Pass transaction ID to track the specific UTXO
                  excludeUtxos       // Pass excludeUtxos to avoid matching old UTXOs
                );
                if (!waitResult.success || !waitResult.confirmed) {
                  showMessage(`UTXO creation in progress. Please wait a moment and click "Use My Wallet" again.`, 'info');
                  return;
                }
                
                // UTXO confirmed, now we need to refetch UTXOs and try selection again
                // Update excludeUtxos to include the newly created UTXO's transaction (if it's from a different tx)
                try {
                  const allSessions = await electronAPI.coinjoin.list();
                  excludeUtxos = [];
                  for (const { session } of allSessions) {
                    // Include ALL zero-trust sessions (including completed) to prevent UTXO reuse
                    if (session.zeroTrustMode) {
                      const sessionUtxos = session.revealedUtxos || session.originalUtxos || [];
                      excludeUtxos.push(...sessionUtxos);
                    }
                  }
                  console.log(`[Coinjoin] Updated exclusion list after UTXO creation: ${excludeUtxos.length} UTXO(s) from all sessions (including completed)`);
                } catch (err) {
                  console.warn('[Coinjoin] Could not refresh exclusion list:', err);
                }
                
                // Refetch UTXOs now that new one is confirmed and re-run selection
                showMessage(`New UTXO confirmed! Refetching UTXOs...`, 'success');
                
                // Refetch UTXOs
                const refreshedUtxos = await electronAPI.wallet.getUtxos(walletAddress);
                if (!refreshedUtxos || refreshedUtxos.length === 0) {
                  showMessage('No UTXOs found after refresh. Please try again.', 'error');
                  return;
                }
                
                // Format refreshed UTXOs
                const refreshedFormattedUtxos = refreshedUtxos.map((utxo, idx) => {
                  const txId = utxo.outpoint?.transactionId || 
                              utxo.entry?.outpoint?.transactionId ||
                              utxo.transactionId || 
                              utxo.txId || '';
                  
                  const index = utxo.outpoint?.index !== undefined 
                              ? utxo.outpoint.index 
                              : (utxo.entry?.outpoint?.index !== undefined
                                  ? utxo.entry.outpoint.index
                                  : (utxo.index !== undefined 
                                      ? utxo.index 
                                      : (utxo.outputIndex !== undefined 
                                          ? utxo.outputIndex 
                                          : 0)));
                  
                  let amount = '0';
                  if (utxo.amount !== undefined && utxo.amount !== null) {
                    amount = typeof utxo.amount === 'bigint' ? utxo.amount.toString() : String(utxo.amount);
                  } else if (utxo.entry && utxo.entry.amount !== undefined && utxo.entry.amount !== null) {
                    amount = typeof utxo.entry.amount === 'bigint' ? utxo.entry.amount.toString() : String(utxo.entry.amount);
                  } else if (utxo.value !== undefined && utxo.value !== null) {
                    amount = typeof utxo.value === 'bigint' ? utxo.value.toString() : String(utxo.value);
                  }
                  
                  return {
                    transactionId: txId,
                    index: index,
                    amount: amount
                  };
                }).filter(utxo => {
                  const hasTxId = utxo.transactionId && utxo.transactionId.length > 0;
                  const hasAmount = utxo.amount && utxo.amount !== '0' && utxo.amount !== '0n';
                  let amountBigInt = 0n;
                  try {
                    amountBigInt = BigInt(utxo.amount || '0');
                  } catch (e) {
                    return false;
                  }
                  return hasTxId && hasAmount && amountBigInt > 0n;
                });
                
                // Filter out excluded UTXOs
                let refreshedAvailableUtxos = refreshedFormattedUtxos;
                if (excludeUtxos && excludeUtxos.length > 0) {
                  const excludedKeys = new Set();
                  for (const excludedUtxo of excludeUtxos) {
                    const txId = excludedUtxo.transactionId || excludedUtxo.txId || '';
                    const index = excludedUtxo.index !== undefined ? excludedUtxo.index : 
                                (excludedUtxo.outputIndex !== undefined ? excludedUtxo.outputIndex : 0);
                    excludedKeys.add(`${txId}:${index}`);
                  }
                  
                  refreshedAvailableUtxos = refreshedFormattedUtxos.filter(utxo => {
                    const key = `${utxo.transactionId}:${utxo.index}`;
                    return !excludedKeys.has(key);
                  });
                }
                
                // Re-run selection on refreshed UTXOs
                selectedUtxos = window.selectUtxosForAmount(refreshedAvailableUtxos, targetAmountSompi);
                
                if (selectedUtxos.length === 0) {
                  showMessage(`UTXO was created but not yet available. Please wait a moment and try again.`, 'warning');
                  return;
                }
                
                // Update selectedTotal and selectedKAS for the refreshed selection
                const refreshedSelectedTotal = selectedUtxos.reduce((sum, utxo) => sum + BigInt(String(utxo.amount || '0')), 0n);
                const refreshedSelectedKAS = Number(refreshedSelectedTotal) / 1e8;
                showMessage(`Selected ${selectedUtxos.length} UTXO(s) totaling ${refreshedSelectedKAS.toFixed(8)} KAS (target: ${targetKAS.toFixed(8)} KAS)`, 'success');
                
                // Continue to populate form below
              } else {
                showMessage(`Could not find or create matching UTXO. Please try again.`, 'error');
                return;
              }
            }
            
            // If we still don't have selected UTXOs at this point, something went wrong
            if (selectedUtxos.length === 0) {
              showMessage(`Could not select UTXOs for ${targetKAS.toFixed(8)} KAS. Please try again or manually select UTXOs.`, 'error');
              return;
            }
            
            if (selectedUtxos.length < availableUtxos.length) {
              console.log(`[Coinjoin] Selected ${selectedUtxos.length} UTXO(s) totaling ${selectedKAS.toFixed(8)} KAS for target ${targetKAS.toFixed(8)} KAS`);
              showMessage(`Selected ${selectedUtxos.length} UTXO(s) totaling ${selectedKAS.toFixed(8)} KAS (target: ${targetKAS.toFixed(8)} KAS)`, 'success');
            } else if (selectedUtxos.length === availableUtxos.length && availableUtxos.length > 1) {
              // If we're using all available UTXOs but there are multiple, warn
              showMessage(`Warning: Using all ${selectedUtxos.length} available UTXO(s) totaling ${selectedKAS.toFixed(8)} KAS. This may not match the target amount for other participants.`, 'warning');
            }
          } else {
            // No target amount - but still warn if using all UTXOs
            const totalKAS = selectedUtxos.reduce((sum, utxo) => sum + BigInt(String(utxo.amount || '0')), 0n);
            console.log(`[Coinjoin] No target amount specified, using all ${selectedUtxos.length} UTXO(s) totaling ${(Number(totalKAS) / 1e8).toFixed(8)} KAS`);
          }
          
          // CRITICAL: Populate the form with selected UTXOs (same as test script flow)
          console.log(`[Coinjoin] Populating form with ${selectedUtxos.length} UTXO(s)`);
          utxosTextarea.value = JSON.stringify(selectedUtxos, null, 2);
          
          // Only update amount from UTXOs if no target amount was specified
          // If target amount was specified, keep it (don't override with actual UTXO total)
          // Also temporarily mark the amount field to prevent auto-calculation from textarea input event
          if (window.updateAmountFromUtxos) {
            if (originalTargetAmountSompi && originalTargetAmountSompi > 0n) {
              // Don't update amount - keep the user's target amount
              // Ensure amount field shows the target (not the actual UTXO total)
              if (amountInput) {
                amountInput.value = originalTargetKAS.toFixed(8);
                amountInput.removeAttribute('data-auto-calculated');
                amountInput.style.backgroundColor = '';
              }
            } else {
              // No target amount specified, calculate from UTXOs
              window.updateAmountFromUtxos();
            }
          }
          
          // Final success message
          if (targetAmountSompi && targetAmountSompi > 0n) {
            const selectedTotal = selectedUtxos.reduce((sum, utxo) => sum + BigInt(String(utxo.amount || '0')), 0n);
            const selectedKAS = Number(selectedTotal) / 1e8;
            showMessage(
              `✅ Successfully prepared ${selectedUtxos.length} UTXO(s) totaling ${selectedKAS.toFixed(8)} KAS. ` +
              `You can now create your CoinJoin session.`,
              'success'
            );
          } else {
            showMessage(`✅ Found ${selectedUtxos.length} UTXO(s) from your wallet! Form populated and ready.`, 'success');
          }
        } catch (err) {
          showMessage(`Error fetching UTXOs from wallet: ${err.message}`, 'error');
          console.error('Error fetching UTXOs from wallet:', err);
        }
      });
    }
    
    // Fetch UTXOs from address (manual entry)
    if (fetchExecuteBtn && fetchAddressInput && utxosTextarea) {
      fetchExecuteBtn.addEventListener('click', async () => {
        const address = fetchAddressInput.value.trim();
        if (!address) {
          showMessage('Please enter an address', 'error');
          return;
        }
        
        // Validate address format
        if (!address.startsWith('kaspa:')) {
          showMessage('Address must start with "kaspa:"', 'error');
          return;
        }
        
        try {
          showMessage('Fetching UTXOs from address...', 'info');
          const utxos = await electronAPI.wallet.getUtxos(address);
          
          console.log('[Coinjoin] Raw UTXOs received:', utxos);
          console.log('[Coinjoin] UTXOs count:', utxos ? utxos.length : 0);
          
          if (!utxos || utxos.length === 0) {
            showMessage('No UTXOs found at this address. Make sure the address has received funds.', 'warning');
            return;
          }
          
          // Format UTXOs for coinjoin (same formatting logic as wallet fetch)
          const formattedUtxos = utxos.map((utxo, idx) => {
            const txId = utxo.outpoint?.transactionId || 
                        utxo.entry?.outpoint?.transactionId ||
                        utxo.transactionId || 
                        utxo.txId || '';
            
            const index = utxo.outpoint?.index !== undefined 
                        ? utxo.outpoint.index 
                        : (utxo.entry?.outpoint?.index !== undefined
                            ? utxo.entry.outpoint.index
                            : (utxo.index !== undefined 
                                ? utxo.index 
                                : (utxo.outputIndex !== undefined 
                                    ? utxo.outputIndex 
                                    : 0)));
            
            let amount = '0';
            if (utxo.amount !== undefined && utxo.amount !== null) {
              amount = typeof utxo.amount === 'bigint' ? utxo.amount.toString() : String(utxo.amount);
            } else if (utxo.entry && utxo.entry.amount !== undefined && utxo.entry.amount !== null) {
              amount = typeof utxo.entry.amount === 'bigint' ? utxo.entry.amount.toString() : String(utxo.entry.amount);
            } else if (utxo.value !== undefined && utxo.value !== null) {
              amount = typeof utxo.value === 'bigint' ? utxo.value.toString() : String(utxo.value);
            }
            
            return {
              transactionId: txId,
              index: index,
              amount: amount
            };
          }).filter(utxo => {
            const hasTxId = utxo.transactionId && utxo.transactionId.length > 0;
            const hasAmount = utxo.amount && utxo.amount !== '0' && utxo.amount !== '0n';
            let amountBigInt = 0n;
            try {
              amountBigInt = BigInt(utxo.amount || '0');
            } catch (e) {
              return false;
            }
            return hasTxId && hasAmount && amountBigInt > 0n;
          });
          
          if (formattedUtxos.length === 0) {
            showMessage('No valid UTXOs found at this address. UTXOs must have a transaction ID and non-zero amount.', 'warning');
            return;
          }
          
          utxosTextarea.value = JSON.stringify(formattedUtxos, null, 2);
          // Calculate and update amount from fetched UTXOs
          if (window.updateAmountFromUtxos) {
            window.updateAmountFromUtxos();
          }
          fetchSection.style.display = 'none';
          showMessage(`Found ${formattedUtxos.length} UTXO(s) and loaded into form!`, 'success');
        } catch (err) {
          console.error('Error fetching UTXOs:', err);
          const errorMsg = err.message || err.toString() || 'Unknown error';
          showMessage(`Error fetching UTXOs: ${errorMsg}`, 'error');
        }
      });
    }
  }
  
  function closeCoinjoinModal() {
    const modal = document.getElementById('coinjoin-create-modal');
    if (modal) {
      modal.classList.add('hidden');
      document.getElementById('coinjoin-create-form').reset();
    }
  }
  
  // Close modal buttons
  document.getElementById('close-coinjoin-modal')?.addEventListener('click', closeCoinjoinModal);
  document.getElementById('coinjoin-modal-cancel')?.addEventListener('click', closeCoinjoinModal);
  
  // Handle form submission
  document.getElementById('coinjoin-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    
  const destinationInput = document.getElementById('coinjoin-destination');
  const amountField = document.getElementById('coinjoin-amount');
  const poolAddressField = document.getElementById('coinjoin-pool-address');
  const poolKeyField = document.getElementById('coinjoin-pool-key');
  const utxosField = document.getElementById('coinjoin-utxos');

  const destination = destinationInput ? destinationInput.value.trim() : '';
  const amountInput = amountField ? amountField.value.trim() : '';
  const poolAddress = poolAddressField ? poolAddressField.value.trim() : '';
  const poolKey = poolKeyField ? poolKeyField.value.trim() : '';
  const utxosInput = utxosField ? utxosField.value.trim() : '';
    
    if (!destination) {
      showMessage('Destination address is required', 'error');
      return;
    }
    
    // Check if trusted fields are visible (trusted mode)
    const trustedFields = document.getElementById('coinjoin-trusted-fields');
    const zeroTrustFields = document.getElementById('coinjoin-zerotrust-fields');

    const isZeroTrustMode = trustedFields
      ? trustedFields.style.display === 'none'
      : zeroTrustFields
        ? zeroTrustFields.style.display !== 'none'
        : false;
    
    let amountSompi = null;
    let userUtxos = null;
    
    if (isZeroTrustMode) {
      // Zero-trust mode: require UTXOs and amount
      if (!utxosInput) {
        showMessage('UTXOs are required for zero-trust mode', 'error');
        return;
      }
      
      // Validate amount is specified
      if (!amountInput) {
        showMessage('Amount is required for zero-trust mode', 'error');
        return;
      }
      
      // CRITICAL: Parse amount with exact precision - no rounding
      // Convert KAS string to sompi (smallest unit) with exact precision
      // Example: "1.5" KAS = 150000000 sompi (exact, no rounding)
      const amountKAS = amountInput.trim();
      
      // Validate format: must be a valid decimal number
      if (!/^\d+(\.\d+)?$/.test(amountKAS)) {
        showMessage('Amount must be a valid number (e.g., 1.5 or 1.50000000)', 'error');
        return;
      }
      
      // Split into integer and decimal parts
      const parts = amountKAS.split('.');
      const integerPart = parts[0] || '0';
      const decimalPart = parts[1] || '';
      
      // Validate decimal precision (max 8 digits for sompi)
      if (decimalPart.length > 8) {
        showMessage(`Amount precision too high. Maximum 8 decimal places (e.g., 1.12345678 KAS). Got ${decimalPart.length} decimal places.`, 'error');
        return;
      }
      
      // Convert to sompi with exact precision
      // Integer part: * 1e8
      // Decimal part: pad to 8 digits, then convert to integer
      const integerSompi = BigInt(integerPart) * 100000000n;
      const decimalSompi = BigInt((decimalPart.padEnd(8, '0').substring(0, 8)));
      amountSompi = integerSompi + decimalSompi;
      
      // Validate minimum amount (1 KAS = 100000000 sompi)
      if (amountSompi < 100000000n) {
        showMessage('Amount must be at least 1 KAS', 'error');
        return;
      }
      
      try {
        userUtxos = JSON.parse(utxosInput);
        if (!Array.isArray(userUtxos) || userUtxos.length === 0) {
          showMessage('UTXOs must be a non-empty array', 'error');
          return;
        }
        
        // Validate UTXO structure
        for (const utxo of userUtxos) {
          if (!utxo.transactionId && !utxo.txId) {
            showMessage('Each UTXO must have a transactionId or txId', 'error');
            return;
          }
          if (utxo.index === undefined && utxo.outputIndex === undefined) {
            showMessage('Each UTXO must have an index or outputIndex', 'error');
            return;
          }
          if (!utxo.amount) {
            showMessage('Each UTXO must have an amount', 'error');
            return;
          }
          
          // Validate amount format
          try {
            BigInt(String(utxo.amount));
          } catch (e) {
            showMessage(`Invalid amount in UTXO: ${utxo.amount}`, 'error');
            return;
          }
        }
        
        // Select UTXOs that match the specified amount (using same algorithm as "Use My Wallet")
        const selectedUtxos = window.selectUtxosForAmount(userUtxos, amountSompi);
        
        // Calculate total from selected UTXOs
        let selectedTotalSompi = 0n;
        for (const utxo of selectedUtxos) {
          selectedTotalSompi += BigInt(String(utxo.amount || '0'));
        }
        
        const selectedTotalKAS = Number(selectedTotalSompi) / 1e8;
        const targetKAS = Number(amountSompi) / 1e8;
        
        // CRITICAL: Enforce EXACT matching - no tolerance allowed
        // CoinJoin requires exact input amounts for fairness and security
        if (selectedTotalSompi !== amountSompi) {
          const difference = selectedTotalSompi > amountSompi 
            ? selectedTotalSompi - amountSompi 
            : amountSompi - selectedTotalSompi;
          const diffKAS = (Number(difference) / 1e8).toFixed(8);
          
          showMessage(
            `ERROR: Selected UTXOs total ${selectedTotalKAS.toFixed(8)} KAS, but target is ${targetKAS.toFixed(8)} KAS. ` +
            `Difference: ${diffKAS} KAS. ` +
            `CoinJoin requires EXACT amount matching for fairness and security. ` +
            `Please select UTXOs that total exactly ${targetKAS.toFixed(8)} KAS.`,
            'error'
          );
          return; // Stop - don't proceed with mismatched amounts
        }
        
        // Store original count for logging
        const originalUtxoCount = userUtxos.length;
        
        // Use selected UTXOs instead of all provided UTXOs
        userUtxos = selectedUtxos;
        
        // Update amount to match selected UTXOs (for accurate session creation)
        amountSompi = selectedTotalSompi;
        
        console.log(`[Coinjoin] Zero-trust mode: Selected ${selectedUtxos.length} UTXO(s) totaling ${selectedTotalKAS.toFixed(8)} KAS for target ${targetKAS.toFixed(8)} KAS`);
        
        if (selectedUtxos.length < originalUtxoCount) {
          console.log(`[Coinjoin] Filtered ${originalUtxoCount - selectedUtxos.length} UTXO(s) that didn't match the target amount`);
        }
      } catch (err) {
        showMessage('Invalid JSON format for UTXOs: ' + err.message, 'error');
        return;
      }
    } else {
      // Trusted mode: require pool info and amount
      if (!poolAddress) {
        showMessage('Pool wallet address is required', 'error');
        return;
      }
      if (!poolKey || poolKey.length !== 64) {
        showMessage('Pool private key must be 64 hex characters', 'error');
        return;
      }
      
      // Validate amount
      const amount = parseFloat(amountInput);
      if (isNaN(amount) || amount < 1) {
        showMessage('Amount must be at least 1 KAS', 'error');
        return;
      }
      amountSompi = BigInt(Math.floor(amount * 100000000));
    }
    
    try {
      showMessage('Creating coinjoin session...', 'info');
      const session = await electronAPI.coinjoin.create(destination, {
        zeroTrustMode: isZeroTrustMode,
        amount: amountSompi ? amountSompi.toString() : null,
        userUtxos: userUtxos,
        poolWalletAddress: poolAddress || null,
        poolPrivateKey: poolKey || null
      });
      
      if (isZeroTrustMode) {
        showMessage(`Zero-trust coinjoin session created! Session ID: ${session.id}`, 'success');
      } else {
        showMessage(`Coinjoin session created! Deposit ${amountInput} KAS to: ${session.depositAddress}`, 'success');
      }
      closeCoinjoinModal();
      loadCoinjoinSessions();
      refreshCoinjoinStats();
    } catch (err) {
      showMessage(`Error: ${err.message}`, 'error');
    }
  });
  
  // Close modal on outside click
  document.getElementById('coinjoin-create-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'coinjoin-create-modal') {
      closeCoinjoinModal();
    }
  });
  
  // Refresh coinjoin button
  document.getElementById('refresh-coinjoin')?.addEventListener('click', () => {
    loadCoinjoinSessions();
    refreshCoinjoinStats();
  });
  
  // Coinjoin reveal modal handlers
  document.getElementById('close-coinjoin-reveal-modal')?.addEventListener('click', closeRevealModal);
  document.getElementById('coinjoin-reveal-modal-cancel')?.addEventListener('click', closeRevealModal);
  
  // One-click reveal button in modal
  document.getElementById('coinjoin-reveal-oneclick-btn')?.addEventListener('click', async () => {
    const form = document.getElementById('coinjoin-reveal-form');
    const sessionId = form?.dataset.sessionId;
    if (sessionId) {
      await oneClickReveal(sessionId);
    }
  });
  
  // Close reveal modal on outside click
  document.getElementById('coinjoin-reveal-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'coinjoin-reveal-modal') {
      closeRevealModal();
    }
  });
  
  // Handle reveal form submission
  document.getElementById('coinjoin-reveal-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const form = e.target;
    const sessionId = form.dataset.sessionId;
    const destination = document.getElementById('coinjoin-reveal-destination').value.trim();
    const utxosInput = document.getElementById('coinjoin-reveal-utxos').value.trim();
    
    if (!sessionId) {
      showMessage('Session ID not found', 'error');
      return;
    }
    
    if (!destination) {
      showMessage('Destination address is required', 'error');
      return;
    }
    
    if (!utxosInput) {
      showMessage('UTXOs are required', 'error');
      return;
    }
    
    let revealedUtxos;
    try {
      revealedUtxos = JSON.parse(utxosInput);
      if (!Array.isArray(revealedUtxos) || revealedUtxos.length === 0) {
        showMessage('UTXOs must be a non-empty array', 'error');
        return;
      }
      
      // Validate UTXO structure
      for (const utxo of revealedUtxos) {
        if (!utxo.transactionId && !utxo.txId) {
          showMessage('Each UTXO must have a transactionId or txId', 'error');
          return;
        }
        if (utxo.index === undefined && utxo.outputIndex === undefined) {
          showMessage('Each UTXO must have an index or outputIndex', 'error');
          return;
        }
        if (!utxo.amount) {
          showMessage('Each UTXO must have an amount', 'error');
          return;
        }
      }
    } catch (err) {
      showMessage('Invalid JSON format for UTXOs: ' + err.message, 'error');
      return;
    }
    
    try {
      showMessage('Revealing UTXOs...', 'info');
      const result = await electronAPI.coinjoin.reveal(sessionId, revealedUtxos, destination);
      
      if (result.success) {
        showMessage(result.message || 'UTXOs revealed successfully! Waiting for other participants.', 'success');
        closeRevealModal();
        loadCoinjoinSessions();
        refreshCoinjoinStats();
      } else {
        showMessage(result.error || 'Failed to reveal UTXOs', 'error');
      }
    } catch (err) {
      showMessage(`Error: ${err.message}`, 'error');
    }
  });
});

// Load coinjoin sessions
async function loadCoinjoinSessions() {
  try {
    const sessions = await electronAPI.coinjoin.list();
    
    // Only show zero-trust sessions
    const zeroTrust = sessions.filter(s => s.session.zeroTrustMode);
    
    await renderCoinjoinSessions(zeroTrust, 'coinjoin-zerotrust-list');
  } catch (err) {
    showMessage(`Error loading coinjoin sessions: ${err.message}`, 'error');
    console.error('Error loading coinjoin sessions:', err);
  }
}

// Render coinjoin sessions
async function renderCoinjoinSessions(sessions, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  if (sessions.length === 0) {
    container.innerHTML = '<div class="empty-state">No coinjoin sessions found.</div>';
    return;
  }
  
  // Get all revealed zero-trust sessions for participant count
  let revealedCount = 0;
  try {
    const allSessions = await electronAPI.coinjoin.list();
    revealedCount = allSessions.filter(({ session }) => 
      session.zeroTrustMode && session.status === 'revealed'
    ).length;
  } catch (e) {
    console.error('Error getting participant count:', e);
  }
  
  container.innerHTML = sessions.map(({ sessionId, session }) => {
    // Show reveal button for committed zero-trust sessions
    const showRevealButton = session.zeroTrustMode && session.status === 'committed';
    // Check if we have stored data for one-click reveal
    const hasStoredData = session.originalUtxos && session.originalUtxos.length > 0 && session.originalDestination;
    
    // Use the same structure as regular session cards
    return `
      <div class="session-card" data-session-id="${sessionId}" data-status="${session.status}">
        <div class="session-header">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <div>
              <div class="session-id">${sessionId.substring(0, 16)}...</div>
              <span class="status-badge status-${session.status}">${session.status.replace(/_/g, ' ')}</span>
              <span class="status-badge" style="background: var(--accent-secondary); margin-left: 0.25rem;">${session.zeroTrustMode ? 'Zero-Trust' : 'Trusted'} Coinjoin</span>
            </div>
          </div>
        </div>
        ${renderTimeline({ ...session, type: 'coinjoin' })}
        <div class="collapsible-section" style="margin-top: 0.75rem;">
          <div class="collapsible-header" data-target="session-details-${sessionId}">
            <span style="font-weight: 600; font-size: 0.9rem; color: var(--text-secondary);">Session Details</span>
            <span class="collapse-icon">▼</span>
          </div>
          <div class="session-details collapsible-content" id="session-details-${sessionId}">
            ${session.depositAddress ? `
              <div class="detail-row">
                <span class="detail-label">Deposit Address:</span>
                <span class="address-display">${session.depositAddress}</span>
              </div>
            ` : ''}
            ${session.amount ? `
              <div class="detail-row">
                <span class="detail-label">Amount:</span>
                <span>${(Number(session.amount) / 1e8).toFixed(8)} KAS</span>
              </div>
            ` : ''}
            ${session.destinationAddress ? `
              <div class="detail-row">
                <span class="detail-label">Destination:</span>
                <span class="address-display">${session.destinationAddress}</span>
              </div>
            ` : ''}
            ${session.utxoCommitments && session.utxoCommitments.length > 0 ? `
              <div class="detail-row">
                <span class="detail-label">UTXO Commitments:</span>
                <span>${session.utxoCommitments.length}</span>
              </div>
            ` : ''}
            ${session.destinationHash ? `
              <div class="detail-row">
                <span class="detail-label">Destination Hash:</span>
                <span class="address-display" style="font-size: 0.8rem;">${session.destinationHash.substring(0, 32)}...</span>
              </div>
            ` : ''}
            ${session.zeroTrustMode && session.status === 'revealed' ? (() => {
              const canBuild = revealedCount >= ZERO_TRUST_REQUIRED_PARTICIPANTS;
              return `
              <div class="detail-row" style="background: ${canBuild ? 'rgba(112, 199, 186, 0.15)' : 'rgba(73, 234, 203, 0.1)'}; padding: 0.75rem; border-radius: 4px; margin-top: 0.5rem; border-left: 3px solid ${canBuild ? 'var(--kaspa-primary)' : 'var(--kaspa-accent)'};">
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;">
                  <div>
                    <span class="detail-label" style="color: ${canBuild ? 'var(--kaspa-primary)' : 'var(--kaspa-accent)'}; font-weight: 600; font-size: 0.9rem;">Participants:</span>
                    <span style="color: ${canBuild ? 'var(--kaspa-primary)' : 'var(--kaspa-accent)'}; font-weight: 600; margin-left: 0.25rem;">${revealedCount} of ${ZERO_TRUST_REQUIRED_PARTICIPANTS}</span>
                  </div>
                  ${canBuild ? `
                  <span style="color: var(--kaspa-primary); font-weight: 600; font-size: 0.85rem;">✓ Ready to Build!</span>
                  ` : `
                  <span style="color: var(--kaspa-accent); font-size: 0.85rem;">Need ${Math.max(ZERO_TRUST_REQUIRED_PARTICIPANTS - revealedCount, 0)} more</span>
                  `}
                </div>
              </div>
            `;
            })() : ''}
            ${session.error ? `
              <div class="detail-row" style="color: var(--error);">
                <span class="detail-label">Error:</span>
                <span>${escapeHtml(session.error)}</span>
              </div>
            ` : ''}
          </div>
        </div>
        <div class="session-actions">
          ${showRevealButton ? `
          ${hasStoredData ? `
          <button type="button" class="btn btn-secondary coinjoin-reveal-oneclick-btn" data-session-id="${escapeHtml(sessionId)}" title="One-click reveal using stored data">✨ One-Click Reveal</button>
          ` : ''}
          <button type="button" class="btn btn-primary coinjoin-reveal-btn" data-session-id="${escapeHtml(sessionId)}" title="${hasStoredData ? 'Manual reveal (or edit stored data)' : 'Reveal UTXOs'}">${hasStoredData ? 'Edit & Reveal' : 'Reveal UTXOs'}</button>
          ` : ''}
          ${session.zeroTrustMode && session.status === 'revealed' ? `
          <button type="button" class="btn btn-primary coinjoin-build-btn" data-session-id="${escapeHtml(sessionId)}" title="Build coinjoin transaction with other revealed participants">🔨 Build Transaction</button>
          ` : ''}
          <button type="button" class="btn btn-secondary coinjoin-view-btn" data-session-id="${escapeHtml(sessionId)}">View</button>
          <button type="button" class="btn btn-danger coinjoin-delete-btn" data-session-id="${escapeHtml(sessionId)}">Delete</button>
        </div>
      </div>
    `;
  }).join('');
  
  // Attach event listeners using event delegation (same pattern as regular sessions)
  container.addEventListener('click', async (ev) => {
    const target = ev.target;
    if (!target || !target.classList) return;
    
    const sessionId = target.getAttribute('data-session-id');
    if (!sessionId) return;
    
    // View button
    if (target.classList.contains('coinjoin-view-btn')) {
      viewCoinjoinSession(sessionId);
      return;
    }
    
    // Delete button
    if (target.classList.contains('coinjoin-delete-btn')) {
      if (!confirm('Are you sure you want to delete this coinjoin session?')) {
        return;
      }
      try {
        const result = await electronAPI.session.delete(sessionId);
        if (result.success) {
          showMessage('Coinjoin session deleted successfully', 'success');
          loadCoinjoinSessions();
        } else {
          showMessage(result.error || 'Failed to delete session', 'error');
        }
      } catch (err) {
        showMessage(`Error deleting session: ${err.message}`, 'error');
      }
      return;
    }
    
    // Reveal button
    if (target.classList.contains('coinjoin-reveal-btn')) {
      openRevealModal(sessionId);
      return;
    }
    
    // One-click reveal button
    if (target.classList.contains('coinjoin-reveal-oneclick-btn')) {
      await oneClickReveal(sessionId);
      return;
    }
    
    // Build transaction button
    if (target.classList.contains('coinjoin-build-btn')) {
      await buildCoinjoinTransaction(sessionId);
      return;
    }
  });
}

// Refresh coinjoin stats
async function refreshCoinjoinStats() {
  try {
    const stats = await electronAPI.coinjoin.stats();
    const statsEl = document.getElementById('coinjoin-stats');
    const progressEl = document.getElementById('coinjoin-progress');
    if (!statsEl) return;
    
    const totalZeroTrust = stats.zeroTrust?.total || 0;
    const committed = stats.zeroTrust?.committed || 0;
    const revealed = stats.zeroTrust?.revealed || 0;
    const completed = stats.zeroTrust?.completed || 0;
    const trustedTotal = stats.trusted?.total || 0;
    
    statsEl.innerHTML = `
      <div class="coinjoin-card-title">
        <h3>Round Metrics</h3>
        <p>Live snapshot of zero-trust and coordinator-led activity.</p>
      </div>
      <div class="metric-grid">
        <div class="metric-card">
          <span class="metric-label">Zero-Trust Sessions</span>
          <span class="metric-value">${totalZeroTrust}</span>
          <span class="metric-subtext">Active and historical</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">Committed</span>
          <span class="metric-value">${committed}</span>
          <span class="metric-subtext">Waiting to reveal</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">Revealed</span>
          <span class="metric-value">${revealed}</span>
          <span class="metric-subtext">Eligible for builds</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">Completed</span>
          <span class="metric-value">${completed}</span>
          <span class="metric-subtext">Zero-trust rounds finalized</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">Coordinator Sessions</span>
          <span class="metric-value">${trustedTotal}</span>
          <span class="metric-subtext">Traditional mixes in flight</span>
        </div>
      </div>
    `;
    
    if (progressEl) {
      const required = typeof ZERO_TRUST_REQUIRED_PARTICIPANTS !== 'undefined' ? ZERO_TRUST_REQUIRED_PARTICIPANTS : 10;
      const progressPercent = Math.min(100, Math.round((revealed / required) * 100));
      const participantsNeeded = Math.max(required - revealed, 0);
      const waitingToReveal = Math.max(committed - revealed, 0);
      const statusText = participantsNeeded === 0 ? 'Crew ready — launch when you are.' : `${participantsNeeded} more participant${participantsNeeded === 1 ? '' : 's'} needed to reach 10.`;
      const statusBadge = participantsNeeded === 0 ? 'Ready to build' : 'Awaiting reveals';
      
      progressEl.innerHTML = `
        <div class="coinjoin-card-title">
          <h3>Participant Readiness</h3>
          <p>${statusText}</p>
        </div>
        <div class="progress-meter">
          <div class="progress-status">
            <span>${revealed} of ${required} participants revealed</span>
            <strong>${statusBadge}</strong>
          </div>
          <div class="progress-bar">
            <div class="progress-bar-fill" style="width: ${progressPercent}%;"></div>
          </div>
          <div class="metric-subtext">Queued to reveal: ${waitingToReveal} • Completed rounds: ${completed}</div>
        </div>
      `;
    }
  } catch (err) {
    console.error('Error loading coinjoin stats:', err);
  }
}

// Open reveal modal for zero-trust coinjoin
async function openRevealModal(sessionId) {
  try {
    const session = await electronAPI.coinjoin.get(sessionId);
    if (!session) {
      showMessage('Session not found', 'error');
      return;
    }
    
    if (!session.zeroTrustMode) {
      showMessage('This is not a zero-trust coinjoin session', 'error');
      return;
    }
    
    if (session.status !== 'committed') {
      showMessage(`Session status is ${session.status}, cannot reveal UTXOs`, 'error');
      return;
    }
    
    const modal = document.getElementById('coinjoin-reveal-modal');
    const form = document.getElementById('coinjoin-reveal-form');
    const destinationInput = document.getElementById('coinjoin-reveal-destination');
    const utxosInput = document.getElementById('coinjoin-reveal-utxos');
    const oneClickRevealBtn = document.getElementById('coinjoin-reveal-oneclick-btn');
    
    if (!modal || !form) return;
    
    // Store session ID for form submission
    form.dataset.sessionId = sessionId;
    
    // Auto-fill with stored data if available
    if (session.originalUtxos && session.originalUtxos.length > 0) {
      destinationInput.value = session.originalDestination || '';
      utxosInput.value = JSON.stringify(session.originalUtxos, null, 2);
      
      // Show one-click reveal button if we have stored data
      if (oneClickRevealBtn) {
        oneClickRevealBtn.style.display = 'block';
      }
    } else {
      // No stored data - user needs to enter manually
      form.reset();
      destinationInput.value = '';
      utxosInput.value = '';
      if (oneClickRevealBtn) {
        oneClickRevealBtn.style.display = 'none';
      }
    }
    
    // Show modal
    modal.classList.remove('hidden');
  } catch (err) {
    showMessage(`Error: ${err.message}`, 'error');
  }
}

// One-click reveal using stored data
async function oneClickReveal(sessionId) {
  try {
    const session = await electronAPI.coinjoin.get(sessionId);
    if (!session || !session.originalUtxos || !session.originalDestination) {
      showMessage('Stored UTXO data not found. Please use manual reveal.', 'error');
      return;
    }
    
    showMessage('Revealing UTXOs...', 'info');
    const result = await electronAPI.coinjoin.reveal(sessionId, session.originalUtxos, session.originalDestination);
    
    if (result.success) {
      showMessage(result.message || 'UTXOs revealed successfully! Waiting for other participants.', 'success');
      closeRevealModal();
      loadCoinjoinSessions();
      refreshCoinjoinStats();
    } else {
      showMessage(result.error || 'Failed to reveal UTXOs', 'error');
    }
  } catch (err) {
    showMessage(`Error: ${err.message}`, 'error');
  }
}

// Close reveal modal
function closeRevealModal() {
  const modal = document.getElementById('coinjoin-reveal-modal');
  if (modal) {
    modal.classList.add('hidden');
    document.getElementById('coinjoin-reveal-form').reset();
  }
}

// Store transaction data globally for signing
let currentCoinjoinTransaction = null;

// Build coinjoin transaction
async function buildCoinjoinTransaction(sessionId) {
  try {
    // Get all revealed zero-trust sessions
    const allSessions = await electronAPI.coinjoin.list();
    let revealedSessions = allSessions.filter(({ session }) => 
      session.zeroTrustMode && session.status === 'revealed'
    );
    
    if (revealedSessions.length < ZERO_TRUST_REQUIRED_PARTICIPANTS) {
      showMessage(`Need ${ZERO_TRUST_REQUIRED_PARTICIPANTS} revealed participants. Currently: ${revealedSessions.length}`, 'warning');
      return;
    }
    
    if (revealedSessions.length > ZERO_TRUST_REQUIRED_PARTICIPANTS) {
      showMessage(`Only ${ZERO_TRUST_REQUIRED_PARTICIPANTS} participants are supported. Currently: ${revealedSessions.length}. Using the first ${ZERO_TRUST_REQUIRED_PARTICIPANTS}.`, 'warning');
      revealedSessions = revealedSessions.slice(0, ZERO_TRUST_REQUIRED_PARTICIPANTS);
    }
    
    // Confirm with user
    const sessionIds = revealedSessions.map(({ sessionId }) => sessionId);
    const confirmMsg = `Build coinjoin transaction with ${revealedSessions.length} participants?\n\n` +
      `This will create a transaction with equal outputs for all participants.`;
    
    if (!confirm(confirmMsg)) {
      return;
    }
    
    showMessage('Building coinjoin transaction...', 'info');
    const result = await electronAPI.coinjoin.build(sessionIds);
    
    if (result) {
      // Store transaction data
      currentCoinjoinTransaction = result;
      
      // Open signing modal
      openCoinjoinSignModal(result);
      showMessage('Transaction structure built! Please sign your inputs.', 'success');
    }
  } catch (err) {
    showMessage(`Error: ${err.message}`, 'error');
  }
}

// Open coinjoin signing modal
async function openCoinjoinSignModal(transactionData) {
  const modal = document.getElementById('coinjoin-sign-modal');
  if (!modal) {
    showMessage('Signing modal not found in HTML', 'error');
    return;
  }
  
  // Store transaction data globally
  currentCoinjoinTransaction = transactionData;
  
  // Try to load existing signatures from backend
  try {
    const signaturesResult = await electronAPI.coinjoin.getSignatures(transactionData);
    if (signaturesResult && signaturesResult.success && signaturesResult.signatures) {
      currentCoinjoinTransaction.signatures = signaturesResult.signatures;
    } else {
      currentCoinjoinTransaction.signatures = [];
    }
  } catch (err) {
    console.warn('[Coinjoin] Failed to load existing signatures:', err);
    currentCoinjoinTransaction.signatures = [];
  }
  
  // Get all sessions to map participants
  const allSessions = await electronAPI.coinjoin.list();
  const participantMap = new Map();
  
  transactionData.inputOwners.forEach(owner => {
    if (!participantMap.has(owner.sessionId)) {
      const session = allSessions.find(s => s.sessionId === owner.sessionId);
      if (session && session.session) {
        // Use session.destinationAddress instead of owner.destinationAddress
        // to get the actual destination address from the session
        participantMap.set(owner.sessionId, {
          sessionId: owner.sessionId,
          destinationAddress: session.session.destinationAddress || owner.destinationAddress,
          inputCount: 0,
          signed: false,
          signedInputs: []
        });
      }
    }
    if (participantMap.has(owner.sessionId)) {
      participantMap.get(owner.sessionId).inputCount++;
    }
  });
  
  const participants = Array.from(participantMap.values());
  
  // Check which participants have signed
  const existingSignatures = currentCoinjoinTransaction.signatures || [];
  const signedInputIndices = new Set(existingSignatures.map(sig => sig.inputIndex));
  
  participants.forEach(p => {
    // Find all input indices for this participant
    const participantInputIndices = [];
    transactionData.inputOwners.forEach((owner, idx) => {
      if (owner.sessionId === p.sessionId) {
        participantInputIndices.push(owner.inputIndex);
      }
    });
    
    // Check if all inputs for this participant are signed
    const allSigned = participantInputIndices.every(idx => signedInputIndices.has(idx));
    p.signed = allSigned;
    p.signedInputs = existingSignatures.filter(sig => participantInputIndices.includes(sig.inputIndex));
  });
  
  // Find current user's session(s) by matching wallet address
  // For testing, multiple participants might have the same address, so we track all matches
  let currentUserSessionIds = new Set();
  let walletAddress = null;
  try {
    const walletInfoResult = await electronAPI.wallet.info();
    if (walletInfoResult && walletInfoResult.success && walletInfoResult.wallet && walletInfoResult.wallet.address) {
      walletAddress = walletInfoResult.wallet.address;
      const normalizedWalletAddr = walletAddress.replace(/^kaspa:/, '').toLowerCase();
      
      // Find ALL matching participants (for testing with same address)
      const matchingParticipants = participants.filter(p => {
        const pAddress = (p.destinationAddress || '').replace(/^kaspa:/, '').toLowerCase();
        const normalizedPAddr = pAddress.toLowerCase();
        return normalizedPAddr === normalizedWalletAddr;
      });
      
      if (matchingParticipants.length > 0) {
        matchingParticipants.forEach(p => {
          currentUserSessionIds.add(p.sessionId);
        });
        console.log(`[Coinjoin] Found ${matchingParticipants.length} matching participant(s) for wallet ${walletAddress}:`, matchingParticipants.map(p => p.sessionId));
      } else {
        // No match found - log for debugging
        console.log('[Coinjoin] No matching participant found for wallet:', walletAddress);
        console.log('[Coinjoin] Available participants:', participants.map(p => ({
          sessionId: p.sessionId,
          destinationAddress: p.destinationAddress
        })));
        // For testing: if no match, allow signing first session (might be testing with different addresses)
        if (transactionData.sessionIds.length > 0) {
          currentUserSessionIds.add(transactionData.sessionIds[0]);
        }
      }
    } else {
      console.log('[Coinjoin] No wallet imported - defaulting to first session for testing');
      if (transactionData.sessionIds.length > 0) {
        currentUserSessionIds.add(transactionData.sessionIds[0]);
      }
    }
  } catch (e) {
    console.error('Error finding current user session:', e);
    if (transactionData.sessionIds.length > 0) {
      currentUserSessionIds.add(transactionData.sessionIds[0]);
    }
  }
  
  // Store wallet address for use in template (to show hints)
  const normalizedWalletAddr = walletAddress ? walletAddress.replace(/^kaspa:/, '').toLowerCase() : null;
  
  // For backward compatibility, keep currentUserSessionId as first match (for highlighting)
  const currentUserSessionId = Array.from(currentUserSessionIds)[0] || null;
  
  // Render modal content
  const modalContent = document.getElementById('coinjoin-sign-modal-content');
  // Calculate participant contributions
  const participantContributions = new Map();
  transactionData.inputOwners.forEach(owner => {
    if (!participantContributions.has(owner.sessionId)) {
      participantContributions.set(owner.sessionId, {
        sessionId: owner.sessionId,
        inputCount: 0,
        totalAmount: 0n
      });
    }
  });
  
  // Calculate each participant's contribution
  transactionData.inputs.forEach((input, idx) => {
    const owner = transactionData.inputOwners.find(o => o.inputIndex === idx);
    if (owner && participantContributions.has(owner.sessionId)) {
      const contrib = participantContributions.get(owner.sessionId);
      contrib.inputCount++;
      contrib.totalAmount += BigInt(String(input.amount || '0'));
    }
  });
  
  modalContent.innerHTML = `
    <div class="coinjoin-sign-info" style="margin-bottom: 1.5rem; padding: 1rem; background: rgba(112, 199, 186, 0.1); border-radius: 8px;">
      <h3 style="margin: 0 0 0.75rem 0; color: var(--kaspa-primary);">Transaction Ready</h3>
      
      <!-- Security Notice -->
      <div style="padding: 0.75rem; background: rgba(112, 199, 186, 0.15); border-left: 3px solid var(--kaspa-primary); border-radius: 4px; margin-bottom: 1rem;">
        <strong style="color: var(--kaspa-primary); display: flex; align-items: center; gap: 0.5rem;">
          <span>🔒</span>
          <span>Secure Signing</span>
        </strong>
        <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.25rem;">
          Your private key stays on your device. It is only used locally to sign your inputs and is never transmitted to the server.
        </div>
      </div>
      
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem; font-size: 0.9rem; margin-bottom: 1rem;">
        <div>
          <strong>Participants:</strong> ${transactionData.participants}
        </div>
        <div>
          <strong>Inputs:</strong> ${transactionData.inputs.length} UTXOs
        </div>
        <div>
          <strong>Total Input:</strong> ${(Number(transactionData.totalInput) / 1e8).toFixed(8)} KAS
        </div>
        <div>
          <strong>Total Output:</strong> ${(Number(transactionData.totalOutput) / 1e8).toFixed(8)} KAS
        </div>
        <div>
          <strong>Fee:</strong> ${(Number(transactionData.fee) / 1e8).toFixed(8)} KAS
        </div>
        <div>
          <strong>Per Participant:</strong> ${(Number(transactionData.outputs[0]?.amount || 0) / 1e8).toFixed(8)} KAS
        </div>
      </div>
      <div style="padding: 0.75rem; background: rgba(255, 193, 7, 0.1); border-left: 3px solid var(--warning); border-radius: 4px; margin-top: 0.75rem;">
        <strong style="color: var(--warning);">💡 Important:</strong>
        <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.25rem;">
          In zero-trust coinjoin, <strong>all UTXOs you provided</strong> are used, not a preset amount. 
          Each participant receives an <strong>equal share</strong> of the total (minus fees).
        </div>
        <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.5rem;">
          <strong>Your contribution:</strong> ${(() => {
            const userContrib = participantContributions.get(currentUserSessionId);
            if (userContrib) {
              return `${(Number(userContrib.totalAmount) / 1e8).toFixed(8)} KAS (${userContrib.inputCount} UTXO${userContrib.inputCount > 1 ? 's' : ''})`;
            }
            return 'Calculating...';
          })()}
        </div>
        ${transactionData.contributionStats && transactionData.contributionStats.ratio > 1.01 ? `
        <div style="font-size: 0.85rem; color: var(--error); margin-top: 0.75rem; padding: 0.5rem; background: rgba(244, 67, 54, 0.1); border-radius: 4px; border-left: 3px solid var(--error);">
          <strong>⚠️ Amount Mismatch:</strong> Participant contributions do not match (ratio: ${transactionData.contributionStats.ratio.toFixed(2)}x). 
          Min: ${transactionData.contributionStats.min.toFixed(8)} KAS, Max: ${transactionData.contributionStats.max.toFixed(8)} KAS. 
          All participants must contribute the EXACT same amount for fairness and security. This transaction cannot be built until all participants match exactly.
        </div>
        ` : ''}
      </div>
    </div>
    
    <div class="coinjoin-sign-participants" style="margin-bottom: 1.5rem;">
      <h4 style="margin: 0 0 0.75rem 0;">Signing Status</h4>
      <div id="coinjoin-sign-participants-list">
        ${participants.map((p, idx) => `
          <div class="coinjoin-participant-sign" data-session-id="${p.sessionId}" style="padding: 1rem; margin-bottom: 0.75rem; border: 1px solid rgba(112, 199, 186, 0.3); border-radius: 8px; ${p.sessionId === currentUserSessionId ? 'background: rgba(112, 199, 186, 0.05);' : ''}">
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;">
              <div>
                <strong>Participant ${idx + 1}</strong>
                <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.25rem;">
                  ${p.destinationAddress.substring(0, 20)}... (${p.inputCount} input${p.inputCount > 1 ? 's' : ''})
                </div>
              </div>
              <div>
                ${p.signed ? `
                  <span class="coinjoin-sign-status" style="padding: 0.5rem 1rem; background: rgba(112, 199, 186, 0.1); color: var(--kaspa-primary); border-radius: 4px; display: flex; align-items: center; gap: 0.25rem;">
                    ✓ Signed (${p.inputCount} input${p.inputCount > 1 ? 's' : ''})
                  </span>
                ` : currentUserSessionIds.has(p.sessionId) ? `
                  <button class="btn btn-primary coinjoin-sign-btn" data-session-id="${p.sessionId}" style="padding: 0.5rem 1rem;">
                    ✍️ Sign My Inputs
                  </button>
                ` : `
                  <span class="coinjoin-sign-status" style="padding: 0.5rem 1rem; background: rgba(255, 193, 7, 0.1); color: var(--warning); border-radius: 4px;">
                    ⏳ Waiting for signature
                    ${(() => {
                      // Show hint if wallet is imported but doesn't match this participant
                      if (normalizedWalletAddr) {
                        const pAddr = (p.destinationAddress || '').replace(/^kaspa:/, '').toLowerCase();
                        if (pAddr && normalizedWalletAddr !== pAddr) {
                          return '<br><small style="font-size: 0.75rem; opacity: 0.8;">Import wallet matching this address to sign</small>';
                        }
                      }
                      return '';
                    })()}
                  </span>
                `}
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
    
    <div class="coinjoin-sign-actions" style="display: flex; gap: 0.75rem; justify-content: flex-end; padding-top: 1rem; border-top: 1px solid rgba(112, 199, 186, 0.3);">
      <button class="btn btn-secondary" id="coinjoin-sign-cancel-btn">Cancel</button>
      <button class="btn btn-primary" id="coinjoin-sign-submit-btn" ${(() => {
        const allSigned = participants.every(p => p.signed);
        return allSigned ? '' : 'disabled style="opacity: 0.5; cursor: not-allowed;"';
      })()}>
        Submit Transaction
      </button>
    </div>
  `;
  
  // Attach event listeners
  document.querySelectorAll('.coinjoin-sign-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sessionId = btn.getAttribute('data-session-id');
      await signMyInputs(sessionId);
    });
  });
  
  const cancelBtn = document.getElementById('coinjoin-sign-cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      closeCoinjoinSignModal();
    });
  }
  
  const closeBtn = document.getElementById('close-coinjoin-sign-modal');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      closeCoinjoinSignModal();
    });
  }
  
  const submitBtn = document.getElementById('coinjoin-sign-submit-btn');
  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      await submitCoinjoinTransaction();
    });
  }
  
  // Show modal
  modal.classList.remove('hidden');
}

// Sign my inputs
async function signMyInputs(sessionId) {
  if (!currentCoinjoinTransaction) {
    showMessage('No transaction data available', 'error');
    return;
  }
  
  try {
    // Check if wallet is imported
    const walletInfoResult = await electronAPI.wallet.info();
    if (!walletInfoResult || !walletInfoResult.success || !walletInfoResult.wallet) {
      showMessage('Please import your wallet first in the Wallet tab', 'warning');
      return;
    }
    
    // Get private key separately (it's not in wallet.info for security)
    const privateKeyResult = await electronAPI.wallet.getPrivateKey();
    if (!privateKeyResult || !privateKeyResult.success || !privateKeyResult.privateKey) {
      showMessage('Could not retrieve wallet private key. Please re-import your wallet.', 'error');
      return;
    }
    
    const privateKeyHex = privateKeyResult.privateKey;
    
    showMessage('Signing your inputs...', 'info');
    const result = await electronAPI.coinjoin.sign(sessionId, currentCoinjoinTransaction, privateKeyHex);
    
    if (result && result.signedInputs) {
      // Store signatures in transaction data
      if (!currentCoinjoinTransaction.signatures) {
        currentCoinjoinTransaction.signatures = [];
      }
      
      // Remove any existing signatures for these inputs and add new ones
      const signedInputIndices = new Set(result.signedInputs.map(sig => sig.inputIndex));
      currentCoinjoinTransaction.signatures = currentCoinjoinTransaction.signatures.filter(
        sig => !signedInputIndices.has(sig.inputIndex)
      );
      currentCoinjoinTransaction.signatures.push(...result.signedInputs);
      
      // Store signatures in backend for persistence
      try {
        await electronAPI.coinjoin.storeSignatures(currentCoinjoinTransaction, currentCoinjoinTransaction.signatures);
      } catch (err) {
        console.warn('[Coinjoin] Failed to store signatures:', err);
      }
      
      // Update UI to show signed status
      const participantElement = document.querySelector(`.coinjoin-participant-sign[data-session-id="${sessionId}"]`);
      if (participantElement) {
        const statusContainer = participantElement.querySelector('div > div:last-child');
        if (statusContainer) {
          const inputCount = result.inputCount || 1;
          statusContainer.innerHTML = `
            <span class="coinjoin-sign-status" style="padding: 0.5rem 1rem; background: rgba(112, 199, 186, 0.1); color: var(--kaspa-primary); border-radius: 4px; display: flex; align-items: center; gap: 0.25rem;">
              ✓ Signed (${inputCount} input${inputCount > 1 ? 's' : ''})
            </span>
          `;
        }
      }
      
      // Check if all inputs are signed by checking all participants
      const allSessions = await electronAPI.coinjoin.list();
      const participantMap = new Map();
      currentCoinjoinTransaction.inputOwners.forEach(owner => {
        if (!participantMap.has(owner.sessionId)) {
          const session = allSessions.find(s => s.sessionId === owner.sessionId);
          if (session && session.session) {
            participantMap.set(owner.sessionId, {
              sessionId: owner.sessionId,
              inputCount: 0
            });
          }
        }
        if (participantMap.has(owner.sessionId)) {
          participantMap.get(owner.sessionId).inputCount++;
        }
      });
      
      const signedInputIndicesSet = new Set(currentCoinjoinTransaction.signatures.map(sig => sig.inputIndex));
      const allSigned = Array.from(participantMap.values()).every(p => {
        const participantInputIndices = [];
        currentCoinjoinTransaction.inputOwners.forEach((owner, idx) => {
          if (owner.sessionId === p.sessionId) {
            participantInputIndices.push(owner.inputIndex);
          }
        });
        return participantInputIndices.every(idx => signedInputIndicesSet.has(idx));
      });
      
      if (allSigned) {
        // Enable submit button
        const submitBtn = document.getElementById('coinjoin-sign-submit-btn');
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.style.opacity = '1';
          submitBtn.style.cursor = 'pointer';
        }
        showMessage('All inputs signed! You can now submit the transaction.', 'success');
      } else {
        const allInputsCount = currentCoinjoinTransaction.inputs.length;
        const signedInputsCount = currentCoinjoinTransaction.signatures.length;
        showMessage(`Signed ${result.inputCount} input(s). ${allInputsCount - signedInputsCount} more needed.`, 'success');
      }
    }
  } catch (err) {
    showMessage(`Error signing: ${err.message}`, 'error');
  }
}

// Submit coinjoin transaction
async function submitCoinjoinTransaction() {
  if (!currentCoinjoinTransaction) {
    showMessage('No transaction data available', 'error');
    return;
  }
  
  const allInputsCount = currentCoinjoinTransaction.inputs.length;
  const signedInputsCount = currentCoinjoinTransaction.signatures ? currentCoinjoinTransaction.signatures.length : 0;
  
  if (signedInputsCount < allInputsCount) {
    showMessage(`Not all inputs are signed. ${allInputsCount - signedInputsCount} more needed.`, 'warning');
    return;
  }
  
  if (!confirm(`Submit coinjoin transaction?\n\nThis will broadcast the transaction to the network.`)) {
    return;
  }
  
  try {
    showMessage('Submitting transaction...', 'info');
    const result = await electronAPI.coinjoin.submit(currentCoinjoinTransaction, currentCoinjoinTransaction.signatures);
    
    if (result && result.success) {
      showMessage(`Transaction submitted! TX ID: ${result.transactionId}`, 'success');
      closeCoinjoinSignModal();
      loadCoinjoinSessions();
      refreshCoinjoinStats();
      currentCoinjoinTransaction = null;
    }
  } catch (err) {
    showMessage(`Error submitting transaction: ${err.message}`, 'error');
  }
}

// Close coinjoin sign modal
function closeCoinjoinSignModal() {
  const modal = document.getElementById('coinjoin-sign-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
  currentCoinjoinTransaction = null;
}

// View coinjoin session
async function viewCoinjoinSession(sessionId) {
  try {
    const session = await electronAPI.coinjoin.get(sessionId);
    if (!session) {
      showMessage('Session not found', 'error');
      return;
    }
    
    const details = `
      Session ID: ${session.id}
      Status: ${session.status}
      Mode: ${session.zeroTrustMode ? 'Zero-Trust' : 'Trusted'}
      Created: ${new Date(session.createdAt).toLocaleString()}
      ${session.depositAddress ? `Deposit: ${session.depositAddress}` : ''}
      ${session.amount ? `Amount: ${(Number(session.amount) / 1e8).toFixed(8)} KAS` : ''}
      ${session.destinationAddress ? `Destination: ${session.destinationAddress}` : ''}
      ${session.error ? `Error: ${session.error}` : ''}
    `;
    
    alert(details);
  } catch (err) {
    showMessage(`Error: ${err.message}`, 'error');
  }
}

// Load WebSocket server status
async function loadWebSocketServerStatus() {
  try {
    const wsInfo = await electronAPI.coinjoin.ws.info();
    const wsStatusEl = document.getElementById('coinjoin-ws-status');
    if (!wsStatusEl) return;
    
    if (wsInfo.running) {
      wsStatusEl.innerHTML = `
        <div class="coinjoin-card-title">
          <h3>WebSocket Bridge</h3>
          <p>Real-time coordinator for lobby updates and signature exchange.</p>
        </div>
        <div class="coinjoin-status-row">
          <span class="status-indicator running"></span>
          <div class="status-body">
            <div class="status-title">Running</div>
            <div class="status-subtext">
              ${wsInfo.lobbyParticipants} in lobby • ${wsInfo.activeRooms} active room${wsInfo.activeRooms === 1 ? '' : 's'}
            </div>
          </div>
          <code class="status-endpoint">${wsInfo.url}</code>
        </div>
      `;
    } else {
      wsStatusEl.innerHTML = `
        <div class="coinjoin-card-title">
          <h3>WebSocket Bridge</h3>
          <p>Spin up the relay to coordinate zero-trust crews.</p>
        </div>
        <div class="coinjoin-status-row">
          <span class="status-indicator stopped"></span>
          <div class="status-body">
            <div class="status-title">Offline</div>
            <div class="status-subtext">Start the service to enable lobby sync</div>
          </div>
          <button class="btn btn-primary btn-sm" id="coinjoin-ws-start-btn">▶️ Start Server</button>
        </div>
      `;
      
      // Attach event listener to start button
      const startBtn = document.getElementById('coinjoin-ws-start-btn');
      if (startBtn) {
        startBtn.addEventListener('click', startWebSocketServer);
      }
    }
  } catch (err) {
    console.error('Error loading WebSocket status:', err);
  }
}

// Start WebSocket server
async function startWebSocketServer() {
  try {
    const result = await electronAPI.coinjoin.ws.start(8080);
    if (result.success) {
      showMessage(`WebSocket server started on ${result.url}`, 'success');
      loadWebSocketServerStatus();
    } else {
      showMessage(`Failed to start WebSocket server: ${result.error}`, 'error');
    }
  } catch (err) {
    showMessage(`Error: ${err.message}`, 'error');
  }
}

// Stop WebSocket server
window.stopWebSocketServer = async function() {
  try {
    const result = await electronAPI.coinjoin.ws.stop();
    if (result.success) {
      showMessage('WebSocket server stopped', 'success');
      loadWebSocketServerStatus();
    } else {
      showMessage(`Failed to stop WebSocket server: ${result.error}`, 'error');
    }
  } catch (err) {
    showMessage(`Error: ${err.message}`, 'error');
  }
};

// Refresh WebSocket status when coinjoin tab is loaded
document.addEventListener('DOMContentLoaded', () => {
  // Override the coinjoin tab load to also refresh WS status
  const originalLoad = loadCoinjoinSessions;
  loadCoinjoinSessions = async function() {
    await originalLoad();
    await loadWebSocketServerStatus();
  };
});

function formatHashrate(h) {
  if (!h || h === 0) return '0 H/s';
  if (h < 1000) return `${h.toFixed(2)} H/s`;
  if (h < 1000000) return `${(h / 1000).toFixed(2)} KH/s`;
  if (h < 1000000000) return `${(h / 1000000).toFixed(2)} MH/s`;
  const gh = h / 1000000000;
  if (gh >= 1000) return `${(gh / 1000).toFixed(2)} TH/s`;
  return `${gh.toFixed(2)} GH/s`;
}

// Parse difficulty safely (from services/node-ui.js)
function parseDifficulty(difficulty) {
  if (!difficulty) return null;
  
  try {
    if (typeof difficulty === 'bigint') {
      return difficulty;
    }
    if (typeof difficulty === 'string') {
      return BigInt(difficulty);
    }
    if (typeof difficulty === 'number') {
      return BigInt(Math.floor(difficulty));
    }
  } catch (err) {
    return null;
  }
  
  return null;
}

// Render connection status section (from services/node-ui.js)
function renderConnectionStatus(s) {
  return `
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
  `;
}

// Render network info section (from services/node-ui.js)
function renderNetworkInfo(s) {
  return `
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
  `;
}

// Render BlockDAG stats section (from services/node-ui.js)
function renderBlockDagStats(s) {
  const difficulty = parseDifficulty(s.difficulty);
  
  return `
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
  `;
}

// Render mempool stats section (from services/node-ui.js)
function renderMempoolStats(mempool) {
  return `
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
  `;
}

// Render fee estimates section (from services/node-ui.js)
function renderFeeEstimates(mempool) {
  if (!mempool.feeRates || (!mempool.feeRates.high && !mempool.feeRates.normal && !mempool.feeRates.low)) {
    return '';
  }
  
  return `
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
  `;
}

// Render node status modal (from services/node-ui.js)
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
  
  content.innerHTML = `
    <div class="node-status-grid">
      ${renderConnectionStatus(s)}
      ${renderNetworkInfo(s)}
      ${renderBlockDagStats(s)}
      ${renderMempoolStats(mempool)}
      ${renderFeeEstimates(mempool)}
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
      connected: result.status.connected,
      synced: result.status.synced,
      peerCount: result.status.peerCount
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
      
      // Update port badges when pool status changes
      if (nodeStatusData) {
        updateNodeStatusIndicator(nodeStatusData);
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
          const blocksFound = Number(j.blocksFound || 0);
          const poolHashrate = j.poolHashrateFormatted || '0 H/s';
          
          document.getElementById('pool-miners').textContent = String(miners);
          document.getElementById('pool-workers').textContent = String(workers);
          document.getElementById('pool-network').textContent = j.networkId || '-';
          document.getElementById('pool-connections').textContent = String(miners);
          const blocksEl = document.getElementById('pool-blocks-found');
          if (blocksEl) blocksEl.textContent = String(blocksFound);
          const hashrateEl = document.getElementById('pool-hashrate');
          if (hashrateEl) hashrateEl.textContent = poolHashrate;
          
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
const poolForcePayoutBtn = document.getElementById('pool-force-payout');
const poolPortInput = document.getElementById('pool-port');
const poolDiffInput = document.getElementById('pool-difficulty');
const poolThreshKasInput = document.getElementById('pool-threshold-kas');

// Vardiff UI elements
const vardiffEnabledCheckbox = document.getElementById('pool-vardiff-enabled');
const vardiffSettingsPanel = document.getElementById('vardiff-settings');
const vardiffTargetTimeInput = document.getElementById('vardiff-target-time');
const vardiffMinDiffInput = document.getElementById('vardiff-min-difficulty');
const vardiffMaxDiffInput = document.getElementById('vardiff-max-difficulty');
const vardiffMaxChangeInput = document.getElementById('vardiff-max-change');
const vardiffChangeIntervalInput = document.getElementById('vardiff-change-interval');

// Toggle vardiff settings panel visibility
if (vardiffEnabledCheckbox && vardiffSettingsPanel) {
  vardiffEnabledCheckbox.addEventListener('change', (e) => {
    vardiffSettingsPanel.style.display = e.target.checked ? 'block' : 'none';
  });
}

// Payment interval UI elements
const poolPaymentIntervalSelect = document.getElementById('pool-payment-interval');
const poolPaymentIntervalCustom = document.getElementById('pool-payment-interval-custom');
const poolMinerSettingsPanel = document.getElementById('pool-miner-settings');
const poolToggleMinerSettingsBtn = document.getElementById('pool-toggle-miner-settings');
const poolMinerAddressInput = document.getElementById('pool-miner-address');
const poolVerificationIpInput = document.getElementById('pool-verification-ip');
const poolSavePaymentIntervalBtn = document.getElementById('pool-save-payment-interval');
const poolGetMinerInfoBtn = document.getElementById('pool-get-miner-info');
const poolMinerInfoDisplay = document.getElementById('pool-miner-info-display');
const poolMinerInfoContent = document.getElementById('pool-miner-info-content');

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
    
    // Load vardiff settings
    if (cfg.stratum?.vardiff) {
      const vardiff = cfg.stratum.vardiff;
      if (vardiffEnabledCheckbox) {
        vardiffEnabledCheckbox.checked = vardiff.enabled === true;
        if (vardiffSettingsPanel) {
          vardiffSettingsPanel.style.display = vardiff.enabled ? 'block' : 'none';
        }
      }
      if (vardiffTargetTimeInput && vardiff.targetTime) vardiffTargetTimeInput.value = vardiff.targetTime;
      if (vardiffMinDiffInput && vardiff.minDifficulty) vardiffMinDiffInput.value = vardiff.minDifficulty;
      if (vardiffMaxDiffInput && vardiff.maxDifficulty) vardiffMaxDiffInput.value = vardiff.maxDifficulty;
      if (vardiffMaxChangeInput && vardiff.maxChange) vardiffMaxChangeInput.value = vardiff.maxChange;
      if (vardiffChangeIntervalInput && vardiff.changeInterval) vardiffChangeIntervalInput.value = vardiff.changeInterval;
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
    
    // Collect vardiff settings
    const vardiff = {
      enabled: vardiffEnabledCheckbox?.checked === true,
      targetTime: vardiffTargetTimeInput ? Number(vardiffTargetTimeInput.value || 30) : 30,
      minDifficulty: vardiffMinDiffInput ? Number(vardiffMinDiffInput.value || 64) : 64,
      maxDifficulty: vardiffMaxDiffInput ? Number(vardiffMaxDiffInput.value || 65536) : 65536,
      maxChange: vardiffMaxChangeInput ? Number(vardiffMaxChangeInput.value || 2.0) : 2.0,
      changeInterval: vardiffChangeIntervalInput ? Number(vardiffChangeIntervalInput.value || 30) : 30,
      variancePercent: 50 // Fixed value (can be made configurable later if needed)
    };
    
    poolStartBtn.disabled = true;
    poolStartBtn.textContent = 'Starting...';
    
    try {
      await electronAPI.pool.config.update({ port, difficulty, paymentThresholdSompi, vardiff });
      const res = await electronAPI.pool.start({ port, difficulty, paymentThresholdSompi });
      
      if (res.success && res.started) {
        showMessage(`Pool started on :${res.port}`, 'success');
      } else {
        // Check if this is a Bun installation error
        const errorMsg = res.error || res.message || 'Failed to start pool';
        
        if (errorMsg.includes('Bun') || errorMsg.includes('bun')) {
          // Format Bun installation error more user-friendly
          const bunErrorMsg = errorMsg.replace(/\n/g, '<br>') + 
            '<br><br><strong>Installation Steps:</strong><br>' +
            '1. Open PowerShell as Administrator<br>' +
            '2. Run: <code>powershell -c "irm bun.sh/install.ps1 | iex"</code><br>' +
            '3. Restart this application<br><br>' +
            '<a href="https://bun.sh/install" target="_blank">Or download Bun directly</a>';
          
          // Show error in a more prominent way for Bun issues
          showMessage(bunErrorMsg, 'error', 15000); // Show for 15 seconds
        } else {
          showMessage(errorMsg, 'error');
        }
      }
    } catch (error) {
      showMessage(`Error starting pool: ${error.message}`, 'error');
    } finally {
      poolStartBtn.disabled = false;
      poolStartBtn.textContent = 'Start';
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
    
    // Update port badges after pool starts
    if (nodeStatusData) {
      setTimeout(() => updateNodeStatusIndicator(nodeStatusData), 600);
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
    
    // Update port badges after pool stops
    if (nodeStatusData) {
      setTimeout(() => updateNodeStatusIndicator(nodeStatusData), 600);
    }
  });
}

// Force Payout All Miners
if (poolForcePayoutBtn) {
  poolForcePayoutBtn.addEventListener('click', async () => {
    // Confirm action
    if (!confirm('Force payout will send all pending balances to all miners (ignoring thresholds). Continue?')) {
      return;
    }

    poolForcePayoutBtn.disabled = true;
    poolForcePayoutBtn.textContent = 'Processing...';

    try {
      if (!electronAPI?.pool?.forcePayoutAll) {
        showMessage('Force payout feature not available. Please restart the application.', 'error');
        return;
      }

      const result = await electronAPI.pool.forcePayoutAll();
      
      if (result.success) {
        if (result.paymentsCount === 0) {
          showMessage('No miners with pending balance to payout', 'info');
        } else {
          const totalKAS = result.totalAmountKAS || (BigInt(result.totalAmount || '0') / 100000000n).toString();
          
          // Build message with transaction hashes
          let message = `Force payout successful: ${result.paymentsCount} payment(s) sent totaling ${totalKAS} KAS`;
          
          if (result.txHashes && result.txHashes.length > 0) {
            message += `\n\nTransaction hashes:`;
            result.txHashes.forEach((txHash, idx) => {
              message += `\n${idx + 1}. ${txHash}`;
            });
            message += `\n\nVerify on explorer: https://kas.fyi/tx/${result.txHashes[0]}`;
          }
          
          showMessage(message, 'success');
          
          // Also log to console for easy copy-paste
          if (result.txHashes && result.txHashes.length > 0) {
            console.log('[Force Payout] Transaction hashes:', result.txHashes);
            result.txHashes.forEach((txHash, idx) => {
              console.log(`  ${idx + 1}. https://kas.fyi/tx/${txHash}`);
            });
          }
          
          // Refresh pool status to show updated balances
          setTimeout(() => {
            refreshPoolStatus();
            refreshWorkersDashboard();
          }, 1000);
        }
      } else {
        showMessage(result.error || 'Failed to force payout', 'error');
      }
    } catch (error) {
      showMessage(`Error: ${error.message}`, 'error');
    } finally {
      poolForcePayoutBtn.disabled = false;
      poolForcePayoutBtn.textContent = 'Force Payout All Miners';
    }
  });
}

// Payment Interval UI Handlers
if (poolPaymentIntervalSelect) {
  poolPaymentIntervalSelect.addEventListener('change', () => {
    if (poolPaymentIntervalCustom) {
      if (poolPaymentIntervalSelect.value === 'custom') {
        poolPaymentIntervalCustom.style.display = 'block';
        poolPaymentIntervalCustom.focus();
      } else {
        poolPaymentIntervalCustom.style.display = 'none';
        poolPaymentIntervalCustom.value = '';
      }
    }
  });
}

if (poolToggleMinerSettingsBtn && poolMinerSettingsPanel) {
  poolToggleMinerSettingsBtn.addEventListener('click', () => {
    const isVisible = poolMinerSettingsPanel.style.display !== 'none';
    poolMinerSettingsPanel.style.display = isVisible ? 'none' : 'block';
    poolToggleMinerSettingsBtn.textContent = isVisible 
      ? 'Configure Miner Payment Settings' 
      : 'Hide Miner Payment Settings';
  });
}

if (poolSavePaymentIntervalBtn) {
  poolSavePaymentIntervalBtn.addEventListener('click', async () => {
    const address = poolMinerAddressInput?.value?.trim();
    const verificationIP = poolVerificationIpInput?.value?.trim();
    
    if (!address) {
      showMessage('Please enter your miner address', 'error');
      return;
    }
    
    if (!verificationIP) {
      showMessage('Please enter your verification IP address', 'error');
      return;
    }
    
    // Check if API is available
    if (!electronAPI?.pool?.miner?.updatePaymentInterval) {
      showMessage('Payment interval feature not available. Please restart the application.', 'error');
      return;
    }
    
    // Get interval value
    let intervalHours = null;
    if (poolPaymentIntervalSelect?.value) {
      if (poolPaymentIntervalSelect.value === 'custom') {
        const customValue = poolPaymentIntervalCustom?.value;
        if (customValue) {
          intervalHours = parseFloat(customValue);
          if (isNaN(intervalHours) || intervalHours < 1 || intervalHours > 168) {
            showMessage('Custom interval must be between 1 and 168 hours', 'error');
            return;
          }
        } else {
          showMessage('Please enter a custom interval value', 'error');
          return;
        }
      } else {
        intervalHours = parseFloat(poolPaymentIntervalSelect.value);
      }
    }
    
    poolSavePaymentIntervalBtn.disabled = true;
    poolSavePaymentIntervalBtn.textContent = 'Saving...';
    
    try {
      const result = await electronAPI.pool.miner.updatePaymentInterval(
        address,
        intervalHours,
        verificationIP
      );
      
      if (result.success) {
        const message = intervalHours 
          ? `Payment interval set to ${intervalHours} hour${intervalHours !== 1 ? 's' : ''}` 
          : 'Time-based payouts disabled (threshold only)';
        showMessage(message, 'success');
        
        // Refresh miner info display
        if (poolGetMinerInfoBtn) {
          poolGetMinerInfoBtn.click();
        }
      } else {
        showMessage(result.error || 'Failed to update payment interval', 'error');
      }
    } catch (error) {
      showMessage(`Error: ${error.message}`, 'error');
    } finally {
      poolSavePaymentIntervalBtn.disabled = false;
      poolSavePaymentIntervalBtn.textContent = 'Save Payment Interval';
    }
  });
}

if (poolGetMinerInfoBtn) {
  poolGetMinerInfoBtn.addEventListener('click', async () => {
    const address = poolMinerAddressInput?.value?.trim();
    
    if (!address) {
      showMessage('Please enter your miner address', 'error');
      return;
    }
    
    // Check if API is available
    if (!electronAPI?.pool?.miner?.get) {
      showMessage('Miner info feature not available. Please restart the application.', 'error');
      return;
    }
    
    poolGetMinerInfoBtn.disabled = true;
    poolGetMinerInfoBtn.textContent = 'Loading...';
    
    try {
      const result = await electronAPI.pool.miner.get(address);
      
      if (result.success && result.miner) {
        const miner = result.miner;
        const balanceKAS = (BigInt(miner.balance || '0') / 100000000n).toString();
        const thresholdKAS = miner.paymentThreshold ? (BigInt(miner.paymentThreshold) / 100000000n).toString() : 'Not set';
        const intervalHours = miner.paymentIntervalHours || null;
        
        // Format hashrate
        function formatHashrate(h) {
          if (!h || h === 0) return '0 H/s';
          if (h < 1000) return `${h.toFixed(2)} H/s`;
          if (h < 1000000) return `${(h / 1000).toFixed(2)} KH/s`;
          if (h < 1000000000) return `${(h / 1000000).toFixed(2)} MH/s`;
          const gh = h / 1000000000;
          if (gh >= 1000) return `${(gh / 1000).toFixed(2)} TH/s`;
          return `${gh.toFixed(2)} GH/s`;
        }
        
        const hashrate = miner.hashrateFormatted || (miner.hashrate ? formatHashrate(miner.hashrate) : '0 H/s');
        
        let infoText = `Balance: ${balanceKAS} KAS\n`;
        infoText += `Hashrate: ${hashrate}\n`;
        infoText += `Blocks Found: ${miner.blocks || []} (${(miner.blocks || []).length} shown)\n`;
        infoText += `Payments: ${(miner.payments || []).length} recent\n`;
        infoText += `Payment Threshold: ${thresholdKAS} KAS\n`;
        infoText += `Payment Interval: ${intervalHours ? `${intervalHours} hour${intervalHours !== 1 ? 's' : ''}` : 'Disabled'}\n`;
        
        if (miner.lastPayoutTime) {
          const lastPayout = new Date(miner.lastPayoutTime);
          infoText += `Last Payout: ${lastPayout.toLocaleString()}\n`;
        } else {
          infoText += `Last Payout: Never\n`;
        }
        
        if (miner.nextPayoutTime && intervalHours) {
          const nextPayout = new Date(miner.nextPayoutTime);
          const now = Date.now();
          const timeUntil = nextPayout - now;
          if (timeUntil > 0) {
            const hours = Math.floor(timeUntil / (1000 * 60 * 60));
            const minutes = Math.floor((timeUntil % (1000 * 60 * 60)) / (1000 * 60));
            infoText += `Next Payout: ${nextPayout.toLocaleString()} (in ${hours}h ${minutes}m)\n`;
          } else {
            infoText += `Next Payout: Due now\n`;
          }
        }
        
        if (poolMinerInfoContent) {
          poolMinerInfoContent.textContent = infoText;
        }
        
        if (poolMinerInfoDisplay) {
          poolMinerInfoDisplay.style.display = 'block';
        }
        
        // Update UI to match current settings
        if (poolPaymentIntervalSelect) {
          if (intervalHours) {
            const intervalValue = intervalHours.toString();
            if (poolPaymentIntervalSelect.querySelector(`option[value="${intervalValue}"]`)) {
              poolPaymentIntervalSelect.value = intervalValue;
              if (poolPaymentIntervalCustom) {
                poolPaymentIntervalCustom.style.display = 'none';
              }
            } else {
              poolPaymentIntervalSelect.value = 'custom';
              if (poolPaymentIntervalCustom) {
                poolPaymentIntervalCustom.style.display = 'block';
                poolPaymentIntervalCustom.value = intervalHours;
              }
            }
          } else {
            poolPaymentIntervalSelect.value = '';
            if (poolPaymentIntervalCustom) {
              poolPaymentIntervalCustom.style.display = 'none';
            }
          }
        }
      } else {
        showMessage(result.error || 'Failed to get miner info', 'error');
      }
    } catch (error) {
      showMessage(`Error: ${error.message}`, 'error');
    } finally {
      poolGetMinerInfoBtn.disabled = false;
      poolGetMinerInfoBtn.textContent = 'Get My Settings';
    }
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

// Auto-detect IPv4 address and fill in LAN connection string
const poolDetectIpBtn = document.getElementById('pool-detect-ip');
if (poolDetectIpBtn) {
  poolDetectIpBtn.addEventListener('click', async () => {
    try {
      poolDetectIpBtn.disabled = true;
      poolDetectIpBtn.textContent = 'Detecting...';
      
      const result = await electronAPI.system.getLocalIp();
      
      if (result.success && result.ip) {
        // Get the current port
        const port = Number(document.getElementById('pool-port')?.value || 7777);
        const lanEl = document.getElementById('pool-connect-lan');
        
        if (lanEl) {
          lanEl.textContent = `stratum+tcp://${result.ip}:${port}`;
          showMessage(`IPv4 address detected: ${result.ip}`, 'success');
          
          // Also copy to clipboard
          try {
            await navigator.clipboard.writeText(`stratum+tcp://${result.ip}:${port}`);
            setTimeout(() => showMessage('Connection string copied to clipboard', 'success'), 500);
          } catch (err) {
            // Fallback copy method
            const textArea = document.createElement('textarea');
            textArea.value = `stratum+tcp://${result.ip}:${port}`;
            textArea.style.position = 'fixed';
            textArea.style.opacity = '0';
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            setTimeout(() => showMessage('Connection string copied to clipboard', 'success'), 500);
          }
        }
      } else {
        showMessage(result.error || 'Failed to detect IPv4 address', 'error');
      }
    } catch (error) {
      showMessage(error.message || 'Failed to detect IP address', 'error');
    } finally {
      poolDetectIpBtn.disabled = false;
      poolDetectIpBtn.textContent = 'Auto-Detect IP';
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
      
      const blocksFound = miner.blocksFound || 0;
      
      const hashrate = miner.hashrateFormatted || (miner.hashrate ? formatHashrate(miner.hashrate) : '0 H/s');
      
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
              <span class="worker-detail-label">Hashrate:</span>
              <span class="worker-detail-value">${hashrate}</span>
            </div>
            <div class="worker-detail">
              <span class="worker-detail-label">Workers:</span>
              <span class="worker-detail-value">${workersCount}</span>
            </div>
            <div class="worker-detail">
              <span class="worker-detail-label">Connections:</span>
              <span class="worker-detail-value">${miner.connections || 0}</span>
            </div>
            <div class="worker-detail">
              <span class="worker-detail-label">Blocks Found:</span>
              <span class="worker-detail-value">${blocksFound}</span>
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

// Mining Calculator Logic
const calculatorHashrateInput = document.getElementById('calculator-hashrate');
const calculatorHashrateUnit = document.getElementById('calculator-hashrate-unit');
const calculatorPoolFeeInput = document.getElementById('calculator-pool-fee');
const calculatorCalculateBtn = document.getElementById('calculator-calculate');
const calculatorLoading = document.getElementById('calculator-loading');
const calculatorResults = document.getElementById('calculator-results');
const calculatorError = document.getElementById('calculator-error');

// Format large numbers
function formatNumber(num) {
  if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(2);
}

// Convert hashrate to H/s (from services/mining-calculator.js)
function convertHashrateToHashes(value, unit) {
  const multipliers = {
    'H/s': 1,
    'KH/s': 1e3,
    'MH/s': 1e6,
    'GH/s': 1e9,
    'TH/s': 1e12
  };
  return value * (multipliers[unit] || 1);
}

// Get current Kaspa block reward from pool API
// This uses the actual block template to get the real coinbase reward
async function getBlockReward() {
  try {
    const response = await fetch('http://127.0.0.1:8080/block-reward', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Failed to fetch block reward');
    }
    const data = await response.json();
    
    if (data.reward && data.reward > 0) {
      return data.reward; // KAS per block
    }
    
    // Fallback if reward is null or 0
    throw new Error('Block reward not available');
  } catch (err) {
    console.warn('[Calculator] Could not fetch block reward:', err);
    // Fallback: Use approximate (but warn user)
    return null; // Return null to indicate fallback needed
  }
}

async function calculateMiningEarnings() {
  // Hide previous results and errors
  calculatorResults.style.display = 'none';
  calculatorError.style.display = 'none';
  calculatorLoading.style.display = 'block';

  try {
    // Get user inputs
    const hashrateValue = parseFloat(calculatorHashrateInput.value) || 0;
    const hashrateUnit = calculatorHashrateUnit.value;
    const poolFeePercent = parseFloat(calculatorPoolFeeInput.value) || 1;

    if (hashrateValue <= 0) {
      throw new Error('Please enter a valid hashrate value');
    }

    // Convert user hashrate to H/s
    const userHashrateHashes = convertHashrateToHashes(hashrateValue, hashrateUnit);

    // Fetch network info from pool API
    let networkDifficulty = 0;
    let networkHashrate = 0;
    let daaScore = null;
    let blockReward = 440; // Default fallback

    try {
      // Get network info
      const networkResponse = await fetch('http://127.0.0.1:8080/network-info', { cache: 'no-store' });
      if (!networkResponse.ok) {
        throw new Error('Pool API not available. Make sure the pool is running.');
      }
      const networkInfo = await networkResponse.json();
      
      // Network difficulty from getBlockDagInfo
      const difficultyStr = networkInfo.difficulty || '0';
      networkDifficulty = parseFloat(difficultyStr);
      daaScore = networkInfo.virtualDaaScore ? parseFloat(networkInfo.virtualDaaScore) : null;
      
      if (networkDifficulty <= 0 || !isFinite(networkDifficulty)) {
        throw new Error('Unable to get network difficulty. Node may not be synced.');
      }

      // For Kaspa: difficulty represents the target hashrate needed
      // Post-Crescendo: 10 blocks/second, so difficulty ≈ network hashrate in hashes/second
      networkHashrate = networkDifficulty;
      
    } catch (apiError) {
      throw new Error(`Failed to fetch network data: ${apiError.message}. Ensure the pool and node are running.`);
    }

    // Get actual block reward from pool API (uses Kaspa WASM to get real coinbase amount)
    blockReward = await getBlockReward();
    
    // If we couldn't get the actual reward, throw an error (don't use inaccurate fallback)
    if (blockReward === null || blockReward <= 0) {
      throw new Error('Unable to determine current block reward. Please ensure the pool and node are running.');
    }
    
    // Calculate earnings based on network-wide mining
    // Block reward is fetched from actual block template (varies with emission schedule)
    // Kaspa post-Crescendo: 10 blocks per second (0.1 seconds per block)
    const blockTimeSeconds = 0.1; // Post-Crescendo block time
    const blocksPerDay = 86400 / blockTimeSeconds; // 864,000 blocks per day at 10 BPS
    const poolFeeMultiplier = 1 - (poolFeePercent / 100);

    // Your share of the network (what percentage of all blocks you'd find)
    const yourShareOfNetwork = userHashrateHashes / networkHashrate;
    
    // Blocks you expect to find per day (based on your share of network)
    const yourBlocksPerDay = blocksPerDay * yourShareOfNetwork;
    
    // Daily earnings (after pool fee - represents what you'd earn in a pool)
    const dailyKAS = yourBlocksPerDay * blockReward * poolFeeMultiplier;

    // Calculate for different periods
    const earnings24h = dailyKAS;
    const earnings7d = dailyKAS * 7;
    const earnings30d = dailyKAS * 30;

    // Display network info
    document.getElementById('calculator-network-hashrate').textContent = formatHashrate(networkHashrate);
    document.getElementById('calculator-network-difficulty').textContent = formatNumber(networkDifficulty);
    
    // Display block reward and your share
    const shareElement = document.getElementById('calculator-your-share');
    if (shareElement) {
      shareElement.textContent = `${(yourShareOfNetwork * 100).toFixed(6)}%`;
    }
    
    // Display block reward (if element exists)
    const blockRewardElement = document.getElementById('calculator-block-reward');
    if (blockRewardElement) {
      blockRewardElement.textContent = `${blockReward.toFixed(4)} KAS`;
    }
    
    // Debug output to console for verification
    console.log('[Calculator] Block reward:', blockReward.toFixed(4), 'KAS');
    console.log('[Calculator] Your blocks per day:', yourBlocksPerDay.toFixed(2));
    console.log('[Calculator] Daily earnings:', dailyKAS.toFixed(2), 'KAS');
    console.log('[Calculator] Formula check:', yourBlocksPerDay.toFixed(2), 'blocks ×', blockReward.toFixed(4), 'KAS ×', (poolFeeMultiplier * 100).toFixed(1) + '% =', dailyKAS.toFixed(2), 'KAS/day');

    // Display earnings (KAS only for now - USD would require price API)
    document.getElementById('calculator-24h-kas').textContent = 
      earnings24h >= 0.01 ? earnings24h.toFixed(2) + ' KAS' : '<0.01 KAS';
    document.getElementById('calculator-24h-usd').textContent = 'Price data unavailable';
    
    document.getElementById('calculator-7d-kas').textContent = 
      earnings7d >= 0.01 ? earnings7d.toFixed(2) + ' KAS' : '<0.01 KAS';
    document.getElementById('calculator-7d-usd').textContent = 'Price data unavailable';
    
    document.getElementById('calculator-30d-kas').textContent = 
      earnings30d >= 0.01 ? earnings30d.toFixed(2) + ' KAS' : '<0.01 KAS';
    document.getElementById('calculator-30d-usd').textContent = 'Price data unavailable';

    // Show results
    calculatorLoading.style.display = 'none';
    calculatorResults.style.display = 'block';

  } catch (error) {
    calculatorLoading.style.display = 'none';
    calculatorError.style.display = 'block';
    document.getElementById('calculator-error-text').textContent = error.message;
  }
}

// Attach event listener
if (calculatorCalculateBtn) {
  calculatorCalculateBtn.addEventListener('click', calculateMiningEarnings);
}

// Also calculate on Enter key in hashrate input
if (calculatorHashrateInput) {
  calculatorHashrateInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && calculatorCalculateBtn) {
      calculatorCalculateBtn.click();
    }
  });
}

// Load config on tab open
document.addEventListener('DOMContentLoaded', () => {
  loadPoolConfig().catch(() => {});
});

// Block Found Notification System
let blockNotificationQueue = [];
let activeBlockNotification = null;

function showBlockNotification(blockData) {
  const container = document.getElementById('block-notification-container');
  if (!container) return;
  
  // Create notification popup
  const notification = document.createElement('div');
  notification.className = 'block-notification';
  notification.dataset.timestamp = blockData.timestamp;
  
  const hashShort = blockData.hash.substring(0, 16) + '...';
  const addressDisplay = blockData.address.startsWith('kaspa:') ? blockData.address : `kaspa:${blockData.address}`;
  
  notification.innerHTML = `
    <div class="block-notification-content">
      <div class="block-notification-header">
        <div class="block-notification-title">
          <span class="block-icon">⛏️</span>
          <span>Block Found!</span>
        </div>
        <button class="block-notification-close">&times;</button>
      </div>
      <div class="block-notification-body">
        <div class="block-info-row">
          <span class="block-info-label">Hash:</span>
          <span class="block-info-value block-hash" title="${blockData.hash}">${hashShort}</span>
        </div>
        <div class="block-info-row">
          <span class="block-info-label">Miner:</span>
          <span class="block-info-value" title="${addressDisplay}">${addressDisplay.substring(0, 20)}${addressDisplay.length > 20 ? '...' : ''}</span>
        </div>
        <div class="block-info-row">
          <span class="block-info-label">Difficulty:</span>
          <span class="block-info-value">${blockData.difficulty}</span>
        </div>
        <div class="block-notification-actions">
          <a href="${blockData.explorerUrl}" target="_blank" class="btn btn-primary" style="margin-top: 0.75rem; padding: 0.5rem 1rem; font-size: 0.875rem;">
            View on Explorer
          </a>
        </div>
      </div>
    </div>
  `;
  
  container.appendChild(notification);
  
  // Attach close button event listener
  const closeBtn = notification.querySelector('.block-notification-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      notification.remove();
      if (activeBlockNotification === notification) {
        activeBlockNotification = null;
      }
      processBlockNotificationQueue();
    });
  }
  
  // Animate in
  setTimeout(() => {
    notification.classList.add('show');
  }, 10);
  
  // Set as active
  activeBlockNotification = notification;
  
  // Auto-remove after 15 seconds if not manually closed
  setTimeout(() => {
    if (notification.parentNode) {
      notification.classList.remove('show');
      setTimeout(() => {
        if (notification.parentNode) {
          notification.remove();
          if (activeBlockNotification === notification) {
            activeBlockNotification = null;
          }
          processBlockNotificationQueue();
        }
      }, 300);
    }
  }, 15000);
}

function processBlockNotificationQueue() {
  // If there's an active notification, wait
  if (activeBlockNotification && activeBlockNotification.parentNode) {
    return;
  }
  
  // Show next notification in queue
  if (blockNotificationQueue.length > 0) {
    const nextBlock = blockNotificationQueue.shift();
    showBlockNotification(nextBlock);
  }
}

// Listen for block found events
if (electronAPI.pool && electronAPI.pool.onBlockFound) {
  electronAPI.pool.onBlockFound((blockData) => {
    // Add to queue
    blockNotificationQueue.push(blockData);
    processBlockNotificationQueue();
  });
}

// Expose function for notification close button
window.activeBlockNotification = null;
window.processBlockNotificationQueue = processBlockNotificationQueue;

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
  
  // Load node mode on startup
  loadNodeMode();
  
});

// Load node mode and update UI
async function loadNodeMode() {
  try {
    const result = await electronAPI.node.getMode();
    if (result.success) {
      updateNodeModeUI(result.mode);
    }
  } catch (error) {
    console.error('Failed to load node mode:', error);
  }
}

// Update node mode UI
function updateNodeModeUI(mode) {
  const toggleBtn = document.getElementById('node-mode-toggle');
  const modeText = document.getElementById('node-mode-text');
  
  if (!toggleBtn || !modeText) return;
  
  toggleBtn.classList.remove('public', 'private');
  toggleBtn.classList.add(mode);
  
  modeText.textContent = mode === 'public' ? 'Public' : 'Private';
  toggleBtn.title = mode === 'public' 
    ? 'Node Mode: Public (UPnP Enabled) - Click to switch to Private' 
    : 'Node Mode: Private (UPnP Disabled) - Click to switch to Public';
}

// Toggle node mode
async function toggleNodeMode() {
  const toggleBtn = document.getElementById('node-mode-toggle');
  const modeText = document.getElementById('node-mode-text');
  
  if (!toggleBtn || !modeText) return;
  
  const currentMode = toggleBtn.classList.contains('public') ? 'public' : 'private';
  const newMode = currentMode === 'public' ? 'private' : 'public';
  
  // Disable button during operation
  toggleBtn.disabled = true;
  modeText.textContent = 'Switching...';
  
  try {
    const result = await electronAPI.node.setMode(newMode);
    
    if (result.success) {
      updateNodeModeUI(newMode);
      
      if (result.restarted) {
        showMessage(`Node mode changed to ${newMode}. Node is restarting...`, 'info');
        // Update node status after restart
        setTimeout(async () => {
          try {
            const statusResult = await electronAPI.node.status();
            if (statusResult.success) {
              updateNodeStatusIndicator({
                status: statusResult.status.connected ? 'connected' : 'disconnected',
                connected: statusResult.status.connected,
                synced: statusResult.status.synced,
                peerCount: statusResult.status.peerCount
              });
            }
          } catch (err) {
            console.error('Failed to refresh node status:', err);
          }
        }, 5000);
      } else {
        showMessage(`Node mode set to ${newMode}. Restart node manually for changes to take effect.`, 'info');
      }
    } else {
      showMessage(`Failed to change node mode: ${result.error}`, 'error');
      // Revert UI
      updateNodeModeUI(currentMode);
    }
  } catch (error) {
    console.error('Failed to toggle node mode:', error);
    showMessage(`Failed to toggle node mode: ${error.message}`, 'error');
    // Revert UI
    updateNodeModeUI(currentMode);
  } finally {
    toggleBtn.disabled = false;
  }
}

// Node mode toggle button event listener
document.addEventListener('DOMContentLoaded', () => {
  const nodeModeToggle = document.getElementById('node-mode-toggle');
  if (nodeModeToggle) {
    nodeModeToggle.addEventListener('click', toggleNodeMode);
  }
});

