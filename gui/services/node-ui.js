// Node status UI service

const { formatBytes, formatDuration, formatNumber, formatNumberWithSeparators } = require('../utils/formatting');

// Convert difficulty to BigInt safely
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

// Render connection status section
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

// Render network info section
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

// Render BlockDAG stats section
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

// Render mempool stats section
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

// Render fee estimates section
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

// Render node status modal content
function renderNodeStatusModal(status) {
  if (!status || !status.connected) {
    return `
      <div class="node-status-error">
        <p><strong>Node Status:</strong> Disconnected</p>
        ${status?.error ? `<p class="error-text">Error: ${status.error}</p>` : ''}
        <button class="btn btn-primary" id="start-node-btn" style="margin-top: 1rem;">Start Node</button>
      </div>
    `;
  }
  
  const s = status;
  const mempool = s.mempool || {};
  
  return `
    <div class="node-status-grid">
      ${renderConnectionStatus(s)}
      ${renderNetworkInfo(s)}
      ${renderBlockDagStats(s)}
      ${renderMempoolStats(mempool)}
      ${renderFeeEstimates(mempool)}
    </div>
  `;
}

module.exports = {
  renderNodeStatusModal,
  parseDifficulty,
};

