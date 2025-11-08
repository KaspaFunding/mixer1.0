// Session UI service

const { escapeHtml } = require('../utils/dom-helpers');

// Session state
let allSessionsData = [];
let currentFilter = 'all';
let currentSort = 'newest';
let currentSearch = '';

// Set session state
function setSessionState(sessions, filter, sort, search) {
  allSessionsData = sessions || [];
  currentFilter = filter || 'all';
  currentSort = sort || 'newest';
  currentSearch = search || '';
}

// Get session state
function getSessionState() {
  return {
    sessions: allSessionsData,
    filter: currentFilter,
    sort: currentSort,
    search: currentSearch
  };
}

// Render timeline for a session
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

// Apply search filter
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

// Apply status filter
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

// Sort sessions
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

// Filter and sort sessions
function filterAndSortSessions(sessions, filter, sort, search) {
  let filtered = applySearchFilter(sessions, search);
  filtered = applyStatusFilter(filtered, filter);
  return sortSessions(filtered, sort);
}

// Render session card
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

module.exports = {
  setSessionState,
  getSessionState,
  renderTimeline,
  filterAndSortSessions,
  renderSessionCard,
};

