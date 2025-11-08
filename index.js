// Standalone Mixer - Main entry point
// This can be packaged into .exe using pkg or nexe

const { checkNodeStatus } = require('./lib/rpc-client');
const { startMonitoring, startIntermediateMonitoring } = require('./lib/monitor');
const { processFinalPayout } = require('./lib/payout');
const { createCLI } = require('./lib/cli');
const { KASPA_NODE_URL } = require('./lib/config');
const { createSession, getSession, getAllSessions } = require('./lib/session-manager');
const { ensureNodeRunning } = require('./lib/node-starter');

// Main
async function main() {
  try {
    console.log('=== Kaspa Mixer (Standalone) ===\n');
    
    // Try to auto-start node if needed
    console.log('Checking for Kaspa node...');
    const nodeStart = await ensureNodeRunning();
    
    if (!nodeStart.found && nodeStart.found !== undefined) {
      // Node files not found, but continue anyway
      console.log('');
    }
    
    // Check node status
    console.log('Connecting to Kaspa node...');
    const nodeStatus = await checkNodeStatus();
    
    if (!nodeStatus.connected) {
      console.error('\n✗ Cannot connect to Kaspa node.');
      console.error(`   Attempted to connect to: ${KASPA_NODE_URL}`);
      console.error('\n   Please ensure:');
      console.error('   1. kaspad.exe is running');
      console.error('   2. Or use start-mixer-with-node.bat to auto-start it');
      console.error('   3. Or start kaspad.exe manually');
      process.exit(1);
    }
    
    // Start monitoring loops (pass processFinalPayout as callback)
    startMonitoring();
    startIntermediateMonitoring(processFinalPayout);
    
    // Start coinjoin deposit monitoring (trusted mode)
    const { monitorCoinjoinDeposits } = require('./lib/services/coinjoin');
    monitorCoinjoinDeposits();
    
    // Start WebSocket server for zero-trust coinjoin coordination
    try {
      const { createCoinjoinWebSocketServer } = require('./lib/services/coinjoin-websocket');
      const wsServer = createCoinjoinWebSocketServer(8080);
      console.log(`[Coinjoin] WebSocket server started on port ${wsServer.port}`);
      console.log(`[Coinjoin] WebSocket URL: ws://localhost:${wsServer.port}/ws/coinjoin`);
    } catch (error) {
      console.error('[Coinjoin] Error starting WebSocket server:', error.message);
      console.log('[Coinjoin] WebSocket server is optional - coinjoin will work without it');
    }
    
    // Create CLI interface
    createCLI();
  } catch (err) {
    console.error('\n✗ Fatal error:', err.message);
    console.error('Stack:', err.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// Export for testing/other use
module.exports = { createSession, getSession, getAllSessions };
