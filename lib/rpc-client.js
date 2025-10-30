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

// Check and display node status
async function checkNodeStatus() {
  try {
    const rpc = await getRpcClient();
    
    // Get node information
    const [info, dagInfo, peers] = await Promise.all([
      rpc.getInfo({}).catch(() => null),
      rpc.getBlockDagInfo({}).catch(() => null),
      rpc.getConnectedPeerInfo({}).catch(() => null),
    ]);
    
    if (!info || !dagInfo) {
      console.log('⚠ Node status: Connected but unable to fetch detailed information');
      return { connected: true, healthy: false };
    }
    
    // Extract peer count
    let peerCount = 0;
    if (Array.isArray(peers)) {
      peerCount = peers.length;
    } else if (peers && Array.isArray(peers.connectedPeerInfo)) {
      peerCount = peers.connectedPeerInfo.length;
    } else if (peers && Array.isArray(peers.peerInfo)) {
      peerCount = peers.peerInfo.length;
    }
    
    // Display status
    console.log('\n📊 Node Status:');
    console.log(`   Network: ${info.networkId || KASPA_NETWORK}`);
    console.log(`   Server: ${info.serverVersion || 'unknown'}`);
    console.log(`   Synced: ${info.isSynced ? '✓ Yes' : '✗ No'}`);
    console.log(`   UTXO Indexed: ${info.isUtxoIndexed ? '✓ Yes' : '✗ No'}`);
    console.log(`   Blocks: ${dagInfo.blockCount || 0}`);
    console.log(`   Peers: ${peerCount}`);
    console.log(`   Mempool: ${info.mempoolSize || 0} transactions`);
    
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
    
    return {
      connected: true,
      healthy: isHealthy,
      synced: info.isSynced,
      peerCount,
      networkId: info.networkId,
    };
  } catch (err) {
    console.log('\n✗ Node Status: Error checking node');
    console.log(`   Error: ${err.message}`);
    console.log('');
    return { connected: false, healthy: false, error: err.message };
  }
}

module.exports = {
  getRpcClient,
  checkNodeStatus,
};

