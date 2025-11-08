// Pool UI service

const { formatHashrate } = require('../utils/formatting');
const { escapeHtml } = require('../utils/dom-helpers');

// Fetch pool API status
async function fetchPoolStatus() {
  try {
    const r = await fetch('http://127.0.0.1:8080/status', { cache: 'no-store' });
    if (r.ok) {
      return await r.json();
    }
  } catch (_) {}
  return null;
}

// Fetch pool miners
async function fetchPoolMiners() {
  try {
    const minersRes = await fetch('http://127.0.0.1:8080/miners', { cache: 'no-store' });
    if (minersRes.ok) {
      return await minersRes.json();
    }
  } catch (_) {}
  return null;
}

// Update pool status display
function updatePoolStatusDisplay(s, poolData) {
  const statusEl = document.getElementById('pool-status-text');
  if (statusEl) {
    if (s.running) {
      statusEl.textContent = `Running (PID ${s.pid}) on :${s.port}`;
    } else if (s.exited) {
      statusEl.textContent = `Stopped (exit code ${s.exitCode ?? 'N/A'})`;
    } else {
      statusEl.textContent = 'Stopped';
    }
  }
  
  const outputEl = document.getElementById('pool-output');
  if (outputEl && s.output) {
    outputEl.textContent = s.output;
    outputEl.scrollTop = outputEl.scrollHeight;
  }
  
  if (poolData) {
    const miners = Number(poolData.miners || 0);
    const workers = Number(poolData.workers || 0);
    const blocksFound = Number(poolData.blocksFound || 0);
    const poolHashrate = poolData.poolHashrateFormatted || '0 H/s';
    
    const minersEl = document.getElementById('pool-miners');
    const workersEl = document.getElementById('pool-workers');
    const networkEl = document.getElementById('pool-network');
    const connectionsEl = document.getElementById('pool-connections');
    const blocksEl = document.getElementById('pool-blocks-found');
    const hashrateEl = document.getElementById('pool-hashrate');
    
    if (minersEl) minersEl.textContent = String(miners);
    if (workersEl) workersEl.textContent = String(workers);
    if (networkEl) networkEl.textContent = poolData.networkId || '-';
    if (connectionsEl) connectionsEl.textContent = String(miners);
    if (blocksEl) blocksEl.textContent = String(blocksFound);
    if (hashrateEl) hashrateEl.textContent = poolHashrate;
  }
}

// Update connection help endpoints
function updateConnectionHelp(port) {
  const localEl = document.getElementById('pool-connect-local');
  const lanEl = document.getElementById('pool-connect-lan');
  if (localEl) localEl.textContent = `stratum+tcp://127.0.0.1:${port}`;
  if (lanEl) lanEl.textContent = `stratum+tcp://YOUR_PC_IP:${port}`;
}

// Render worker card
function renderWorkerCard(miner, idx) {
  const balance = (BigInt(miner.balance || 0) / 100000000n).toLocaleString();
  const workersCount = miner.workers || 0;
  const workersDetail = miner.workersDetail || [];
  const addressEscaped = escapeHtml(miner.address);
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
              const wName = escapeHtml(w.name || 'Unnamed');
              const wAgent = escapeHtml(w.agent || 'Unknown');
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
}

// Render miner modal content
function renderMinerModalContent(data, minerAddress) {
  return `
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
              <div style="font-weight: 600; color: var(--text-primary);">${escapeHtml(w.name || 'Unnamed')}</div>
              <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.25rem;">
                Agent: ${escapeHtml(w.agent || 'Unknown')} | Difficulty: ${w.difficulty || 0}
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    ` : '<div class="status-section" style="margin-top: 1rem;"><p style="color: var(--text-secondary);">No workers active</p></div>'}
  `;
}

module.exports = {
  fetchPoolStatus,
  fetchPoolMiners,
  updatePoolStatusDisplay,
  updateConnectionHelp,
  renderWorkerCard,
  renderMinerModalContent,
};

