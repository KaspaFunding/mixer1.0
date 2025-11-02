// RPC client management and node status checking

const { kaspa, KASPA_NODE_URL, KASPA_NETWORK, KASPA_ENCODING } = require('./config');

let rpc = null;

// Initialize RPC connection
async function getRpcClient() {
  if (!rpc) {
    console.log(`Connecting to Kaspa node: ${KASPA_NODE_URL}`);
    rpc = new kaspa.RpcClient({
      url: KASPA_NODE_URL,
      network: KASPA_NETWORK,
      encoding: kaspa.Encoding[KASPA_ENCODING.charAt(0).toUpperCase() + KASPA_ENCODING.slice(1)] || kaspa.Encoding.Borsh,
    });
    await rpc.connect();
    console.log('✓ Connected to Kaspa node');
  }
  return rpc;
}

// Helper function to safely convert BigInt to Number
function safeToNumber(value, defaultValue = 0) {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  const num = Number(value);
  return isNaN(num) ? defaultValue : num;
}

// Helper function to safely convert BigInt to String
function safeToString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

// Check and display node status
async function checkNodeStatus() {
  try {
    const rpc = await getRpcClient();
    
    // Get comprehensive node information in parallel
    const [info, dagInfo, peers, feeEstimate, serverInfo, mempoolEntries, connections, peerAddresses, metrics] = await Promise.all([
      rpc.getInfo({}).catch(() => null),
      rpc.getBlockDagInfo({}).catch(() => null),
      rpc.getConnectedPeerInfo({}).catch(() => null),
      rpc.getFeeEstimate({}).catch(() => null),
      rpc.getServerInfo({}).catch(() => null),
      rpc.getMempoolEntries({}).catch(() => null),
      rpc.getConnections({}).catch(() => null),
      rpc.getPeerAddresses({}).catch(() => null),
      rpc.getMetrics({}).catch(() => null),
    ]);
    
    if (!info || !dagInfo) {
      console.log('⚠ Node status: Connected but unable to fetch detailed information');
      return { connected: true, healthy: false };
    }
    
    // Extract peer count
    let peerCount = 0;
    let peerDetails = [];
    if (Array.isArray(peers)) {
      peerCount = peers.length;
      peerDetails = peers;
    } else if (peers && Array.isArray(peers.connectedPeerInfo)) {
      peerCount = peers.connectedPeerInfo.length;
      peerDetails = peers.connectedPeerInfo;
    } else if (peers && Array.isArray(peers.peerInfo)) {
      peerCount = peers.peerInfo.length;
      peerDetails = peers.peerInfo;
    }
    // Calculate mempool statistics - use actual data from RPC calls
    let mempoolStats = {
      transactionCount: 0, // Will be set from actual entries count
      totalSize: 0,
      oldestTxAge: null,
      averageFeeRate: 0,
      feeRates: { high: 0, normal: 0, low: 0 }
    };
    
    // Use actual mempool entry count if available, otherwise fallback to info.mempoolSize
    if (mempoolEntries && mempoolEntries.entries) {
      const entries = mempoolEntries.entries;
      let totalSize = 0;
      let totalFee = 0n;
      let oldestTimestamp = null;
      let transactionCount = 0;
      
      entries.forEach(entry => {
        if (entry) {
          transactionCount++;
          
          // Use actual transaction size if available (from mass or size field)
          if (entry.transaction?.mass !== undefined && entry.transaction.mass !== null) {
            // Mass is roughly proportional to size (1 mass ≈ 1 byte), but use actual if available
            totalSize += safeToNumber(entry.transaction.mass, 200);
          } else if (entry.transaction?.size !== undefined && entry.transaction.size !== null) {
            totalSize += safeToNumber(entry.transaction.size, 200);
          } else {
            // Fallback estimate only if real data not available
            totalSize += 200;
          }
          
          // Get actual fee from entry if available
          if (entry.fee !== undefined && entry.fee !== null) {
            const feeNum = safeToNumber(entry.fee, 0);
            totalFee = totalFee + BigInt(Math.floor(feeNum));
          } else if (entry.transaction?.fee !== undefined && entry.transaction.fee !== null) {
            const feeNum = safeToNumber(entry.transaction.fee, 0);
            totalFee = totalFee + BigInt(Math.floor(feeNum));
          }
          
          // Get timestamp from entry (preferred) or transaction
          let txTime = null;
          if (entry.timestamp !== undefined && entry.timestamp !== null) {
            txTime = safeToNumber(entry.timestamp, 0);
          } else if (entry.transaction?.timestamp !== undefined && entry.transaction.timestamp !== null) {
            txTime = safeToNumber(entry.transaction.timestamp, 0);
          } else if (entry.timeAdded !== undefined && entry.timeAdded !== null) {
            txTime = safeToNumber(entry.timeAdded, 0);
          }
          
          if (txTime > 0 && (!oldestTimestamp || txTime < oldestTimestamp)) {
            oldestTimestamp = txTime;
          }
        }
      });
      
      // Use actual count from entries, with fallback to info.mempoolSize from getInfo()
      mempoolStats.transactionCount = transactionCount > 0 ? transactionCount : (info.mempoolSize || 0);
      mempoolStats.totalSize = totalSize;
      
      // Calculate average fee rate only if we have real fee data
      if (transactionCount > 0 && totalFee > 0n && totalSize > 0) {
        // Average fee per byte (fee in sompi, size in bytes)
        mempoolStats.averageFeeRate = Number(totalFee) / totalSize;
      }
      
      // Calculate oldest transaction age in milliseconds
      if (oldestTimestamp && oldestTimestamp > 0) {
        // Handle both Unix timestamp (seconds) and milliseconds
        const timestampMs = oldestTimestamp < 1e12 ? oldestTimestamp * 1000 : oldestTimestamp;
        mempoolStats.oldestTxAge = Date.now() - timestampMs;
      }
    } else {
      // Fallback: use mempool size from getInfo() if entries not available
      // This is still real data from the node
      mempoolStats.transactionCount = info.mempoolSize || 0;
    }
    
    // Get fee estimate info
    if (feeEstimate && feeEstimate.estimate) {
      const est = feeEstimate.estimate;
      if (est.priorityBucket && est.priorityBucket.feerate !== undefined) {
        const feerate = est.priorityBucket.feerate;
        mempoolStats.feeRates.high = typeof feerate === 'bigint' ? Number(feerate) : (typeof feerate === 'number' ? feerate : Number(feerate) || 0);
      }
      if (est.normalBuckets && est.normalBuckets.length > 0 && est.normalBuckets[0].feerate !== undefined) {
        const feerate = est.normalBuckets[0].feerate;
        mempoolStats.feeRates.normal = typeof feerate === 'bigint' ? Number(feerate) : (typeof feerate === 'number' ? feerate : Number(feerate) || 0);
      }
      if (est.lowBuckets && est.lowBuckets.length > 0 && est.lowBuckets[0].feerate !== undefined) {
        const feerate = est.lowBuckets[0].feerate;
        mempoolStats.feeRates.low = typeof feerate === 'bigint' ? Number(feerate) : (typeof feerate === 'number' ? feerate : Number(feerate) || 0);
      }
    }
    
    // Calculate sync progress (if not synced)
    let syncProgress = null;
    if (!info.isSynced && dagInfo.headerCount && dagInfo.blockCount) {
      // Safely convert BigInt values to numbers
      const blockCount = safeToNumber(dagInfo.blockCount, 0);
      const headerCount = safeToNumber(dagInfo.headerCount, 0);
      if (headerCount > 0) {
        const progress = (blockCount / headerCount) * 100;
        syncProgress = Math.min(100, Math.max(0, progress));
      }
    }
    
    // Display status
    console.log('\n📊 Node Status:');
    console.log(`   Network: ${info.networkId || serverInfo?.networkId || KASPA_NETWORK}`);
    console.log(`   Server: ${info.serverVersion || serverInfo?.serverVersion || 'unknown'}`);
    console.log(`   Synced: ${info.isSynced ? '✓ Yes' : '✗ No'}`);
    if (syncProgress !== null) {
      console.log(`   Sync Progress: ${syncProgress.toFixed(1)}%`);
    }
    console.log(`   UTXO Indexed: ${info.isUtxoIndexed ? '✓ Yes' : '✗ No'}`);
    // Safely convert BigInt values for console output
    const blockCountNum = safeToNumber(dagInfo.blockCount, 0);
    const headerCountNum = safeToNumber(dagInfo.headerCount, 0);
    const daaScoreNum = safeToNumber(dagInfo.virtualDaaScore, 0);
    const difficultyNum = dagInfo.difficulty ? safeToNumber(dagInfo.difficulty, 0) : null;
    
    console.log(`   Blocks: ${blockCountNum}`);
    console.log(`   Headers: ${headerCountNum}`);
    console.log(`   DAA Score: ${daaScoreNum}`);
    console.log(`   Difficulty: ${difficultyNum ? (difficultyNum / 1e12).toFixed(2) + ' TH' : 'N/A'}`);
    console.log(`   Peers: ${peerCount}`);
    console.log(`   Mempool: ${mempoolStats.transactionCount} transactions (~${(mempoolStats.totalSize / 1024).toFixed(2)} KB)`);
    
    const isHealthy = info.isSynced && peerCount > 0;
    
    if (isHealthy) {
      console.log('\n✓ Node is ready - mixing will work correctly');
    } else {
      console.log('\n⚠ Warning: Node may not be fully ready');
      if (!info.isSynced) {
        console.log('  - Node is not synced. Mixing may be delayed.');
      }
      if (peerCount === 0) {
        console.log('  - No peers connected. Check network connectivity.');
      }
    }
    
    console.log('');
    
    // Convert all potentially BigInt values to safe types for return
    const safeBlockCount = safeToNumber(dagInfo.blockCount, 0);
    const safeHeaderCount = safeToNumber(dagInfo.headerCount, 0);
    const safeDaaScore = safeToNumber(dagInfo.virtualDaaScore, 0);
    const safeDifficulty = safeToString(dagInfo.difficulty);
    
    return {
      connected: true,
      healthy: isHealthy,
      synced: info.isSynced,
      peerCount,
      networkId: info.networkId || serverInfo?.networkId || KASPA_NETWORK,
      serverVersion: info.serverVersion || serverInfo?.serverVersion,
      isUtxoIndexed: info.isUtxoIndexed,
      blockCount: safeBlockCount,
      headerCount: safeHeaderCount,
      virtualDaaScore: safeDaaScore,
      difficulty: safeDifficulty,
      mempool: mempoolStats,
      feeEstimate: feeEstimate?.estimate || null,
      syncProgress: syncProgress,
      tipHashes: dagInfo.tipHashes || [],
    };
  } catch (err) {
    console.log('\n✗ Node Status: Error checking node');
    const errorMsg = err.message || String(err);
    // Check if error is related to BigInt mixing
    if (errorMsg.includes('BigInt') || errorMsg.includes('explicit conversions')) {
      console.log(`   Error: ${errorMsg}`);
      console.log('   This may be due to BigInt conversion issues. Attempting safe fallback...');
      // Return a minimal status if we can at least connect
      try {
        const rpc = await getRpcClient();
        return { 
          connected: true, 
          healthy: false, 
          error: 'Node connected but status check failed: ' + errorMsg 
        };
      } catch {
        return { connected: false, healthy: false, error: errorMsg };
      }
    }
    console.log(`   Error: ${errorMsg}`);
    console.log('');
    return { connected: false, healthy: false, error: errorMsg };
  }
}

module.exports = {
  getRpcClient,
  checkNodeStatus,
};

