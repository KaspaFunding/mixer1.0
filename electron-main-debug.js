// Debug: Test if all modules load correctly
// Run: node electron-main-debug.js

console.log('Testing module loading...');

try {
  console.log('1. Loading config...');
  const config = require('./lib/config');
  console.log('   ✓ Config loaded');
  console.log('   - KASPA_NODE_URL:', config.KASPA_NODE_URL);
  console.log('   - DB_PATH:', config.DB_PATH);
  
  console.log('2. Loading database...');
  const { getAllSessions } = require('./lib/database');
  console.log('   ✓ Database loaded');
  
  console.log('3. Testing getAllSessions...');
  const sessions = await getAllSessions();
  console.log('   ✓ Found', sessions.length, 'sessions');
  
  console.log('4. Loading session-manager...');
  const sessionManager = require('./lib/session-manager');
  console.log('   ✓ Session manager loaded');
  
  console.log('5. Loading rpc-client...');
  const rpcClient = require('./lib/rpc-client');
  console.log('   ✓ RPC client loaded');
  
  console.log('\n✓ All modules loaded successfully!');
} catch (error) {
  console.error('\n✗ Module loading failed:');
  console.error('  Error:', error.message);
  console.error('  Stack:', error.stack);
  process.exit(1);
}

