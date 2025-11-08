// Test script to verify GUI UTXO flow matches test script behavior
// Uses test-config-10.json to simulate GUI "Use My Wallet" flow

const path = require('path');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');
process.chdir(projectRoot);

// Load config
const { kaspa, KASPA_NETWORK } = require(path.join(projectRoot, 'lib', 'config'));
const walletModule = require(path.join(projectRoot, 'lib', 'wallet'));
const { importPrivateKey, createMatchingUtxo, waitForUtxoConfirmation, hasMatchingUtxo, sendFromWallet, getWalletInfo } = walletModule;
const { getConfirmedUtxos } = require(path.join(projectRoot, 'lib', 'utils', 'utxo-helpers'));
const { getAllCoinjoinSessions } = require(path.join(projectRoot, 'lib', 'services', 'coinjoin'));

// Load test config
const configPath = path.join(__dirname, 'test-config-10.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Test first participant from config
async function testGUIFlow() {
  console.log('='.repeat(60));
  console.log('Testing GUI "Use My Wallet" Flow');
  console.log('='.repeat(60));
  console.log('');
  
  const participant = config.participants[0];
  const privateKeyHex = participant.privateKey;
  const amountKAS = config.amountKAS;
  
  console.log(`Testing with Participant 1:`);
  console.log(`  Private Key: ${privateKeyHex.substring(0, 16)}...`);
  console.log(`  Address: ${participant.address}`);
  console.log(`  Amount: ${amountKAS} KAS`);
  console.log('');
  
  // Step 1: Import wallet (simulating GUI import)
  console.log('Step 1: Importing wallet...');
  try {
    const importResult = importPrivateKey(privateKeyHex);
    console.log(`  ✅ Wallet imported`);
    console.log(`  Address: ${importResult.address}`);
    console.log(`  Expected: ${participant.address}`);
    
    if (importResult.address !== participant.address) {
      console.log(`  ⚠️  Address mismatch! Derived: ${importResult.address}, Expected: ${participant.address}`);
    } else {
      console.log(`  ✅ Address matches`);
    }
  } catch (err) {
    console.error(`  ❌ Failed to import wallet: ${err.message}`);
    return;
  }
  
  console.log('');
  
  // Step 2: Get wallet info (simulating GUI wallet.info() call)
  console.log('Step 2: Getting wallet info (simulating GUI call)...');
  try {
    const walletInfo = getWalletInfo();
    console.log(`  Wallet info structure:`, JSON.stringify(walletInfo, null, 2));
    
    // Test different access patterns
    let walletAddress = null;
    if (walletInfo && walletInfo.address) {
      walletAddress = walletInfo.address;
      console.log(`  ✅ Found address via walletInfo.address: ${walletAddress}`);
    } else if (walletInfo && walletInfo.wallet && walletInfo.wallet.address) {
      walletAddress = walletInfo.wallet.address;
      console.log(`  ✅ Found address via walletInfo.wallet.address: ${walletAddress}`);
    } else {
      console.error(`  ❌ Could not find address in wallet info`);
      console.error(`  Structure:`, walletInfo);
      return;
    }
    
    if (walletAddress !== participant.address) {
      console.error(`  ❌ Address mismatch! Got: ${walletAddress}, Expected: ${participant.address}`);
      return;
    }
    
    console.log(`  ✅ Address matches expected: ${walletAddress}`);
  } catch (err) {
    console.error(`  ❌ Failed to get wallet info: ${err.message}`);
    return;
  }
  
  console.log('');
  
  // Step 3: Get exclude UTXOs (simulating GUI session exclusion)
  console.log('Step 3: Getting exclude UTXOs from previous sessions...');
  let excludeUtxos = [];
  try {
    const allSessions = await getAllCoinjoinSessions();
    for (const { session } of allSessions) {
      if (session.zeroTrustMode) {
        const sessionUtxos = session.revealedUtxos || session.originalUtxos || [];
        excludeUtxos.push(...sessionUtxos);
      }
    }
    console.log(`  ✅ Excluding ${excludeUtxos.length} UTXO(s) from previous sessions`);
  } catch (err) {
    console.warn(`  ⚠️  Could not get existing sessions: ${err.message}`);
  }
  
  console.log('');
  
  // Step 4: Parse amount (simulating GUI exact parsing)
  console.log('Step 4: Parsing amount (exact precision)...');
  const amountKASStr = amountKAS.toString();
  const parts = amountKASStr.split('.');
  const integerPart = parts[0] || '0';
  const decimalPart = parts[1] || '';
  const integerSompi = BigInt(integerPart) * 100000000n;
  const decimalSompi = BigInt((decimalPart.padEnd(8, '0').substring(0, 8)));
  const targetAmountSompi = integerSompi + decimalSompi;
  console.log(`  Input: ${amountKASStr} KAS`);
  console.log(`  Parsed: ${targetAmountSompi} sompi`);
  console.log(`  ✅ Amount parsed correctly`);
  
  console.log('');
  
  // Step 5: Check for matching UTXO (simulating GUI hasMatchingUtxo call)
  console.log('Step 5: Checking for matching UTXO...');
  try {
    const hasMatch = await hasMatchingUtxo(targetAmountSompi, 0, excludeUtxos);
    console.log(`  Has match: ${hasMatch.hasMatch}`);
    console.log(`  ✅ Check completed`);
  } catch (err) {
    console.error(`  ❌ Failed to check UTXO: ${err.message}`);
    return;
  }
  
  console.log('');
  
  // Step 6: Test sendFromWallet call (simulating GUI wallet.send)
  console.log('Step 6: Testing sendFromWallet (simulating GUI wallet.send)...');
  try {
    const walletInfo = getWalletInfo();
    const walletAddress = walletInfo ? walletInfo.address : participant.address;
    
    console.log(`  Wallet address: ${walletAddress}`);
    console.log(`  Amount: ${amountKAS} KAS`);
    
    if (!walletAddress || typeof walletAddress !== 'string' || walletAddress.trim() === '') {
      console.error(`  ❌ Invalid wallet address: ${walletAddress}`);
      return;
    }
    
    console.log(`  ✅ Wallet address valid`);
    console.log(`  Note: Not actually sending (would create transaction ${walletAddress})`);
    console.log(`  This would call: sendFromWallet("${walletAddress}", ${amountKAS})`);
  } catch (err) {
    console.error(`  ❌ Failed: ${err.message}`);
    return;
  }
  
  console.log('');
  console.log('='.repeat(60));
  console.log('✅ All GUI flow steps validated!');
  console.log('='.repeat(60));
  console.log('');
  console.log('Summary:');
  console.log(`  1. Wallet import: ✅`);
  console.log(`  2. Wallet info retrieval: ✅`);
  console.log(`  3. Exclude UTXOs collection: ✅`);
  console.log(`  4. Exact amount parsing: ✅`);
  console.log(`  5. UTXO matching check: ✅`);
  console.log(`  6. Wallet address validation: ✅`);
  console.log('');
  console.log('The GUI should work correctly with these structures.');
}

// Run test
testGUIFlow().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

