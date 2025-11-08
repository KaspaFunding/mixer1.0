#!/usr/bin/env node

/**
 * Coinjoin Testing Script
 * 
 * This script automates the process of creating, revealing, building, signing, and submitting
 * zero-trust coinjoin transactions for testing purposes.
 * 
 * Usage:
 *   node scripts/test-coinjoin.js --config test-config.json
 *   node scripts/test-coinjoin.js --participants 3 --amount 1.0
 * 
 * Configuration options:
 *   - participants: Number of participants (default: 3)
 *   - amountKAS: Amount per participant in KAS (default: 1.0)
 *   - participants: Array of participant configurations
 *     Each participant needs:
 *       - privateKey: Private key in hex format (required if not using autoWallet)
 *       - address: Address to use (will be derived from privateKey if not provided)
 *       - destinationAddress: Where to receive mixed coins (required)
 *       - utxos: Array of UTXOs to use (optional - will auto-fetch if not provided)
 *         Each UTXO: { transactionId, index, amount }
 *   - autoWallet: If true, uses the imported wallet for all participants (for quick testing)
 *   - waitForConfirmations: Wait for UTXOs to confirm before proceeding (default: true)
 */

const path = require('path');
const fs = require('fs');

// Load config and services
// Change to project root directory first
const scriptDir = __dirname;
const projectRoot = path.join(scriptDir, '..');
process.chdir(projectRoot);

// Verify we're in the right directory
const configPath = path.join(projectRoot, 'lib', 'config.js');
if (!fs.existsSync(configPath)) {
  console.error(`Error: Cannot find lib/config.js at ${configPath}`);
  console.error(`Current directory: ${process.cwd()}`);
  console.error(`Script directory: ${scriptDir}`);
  console.error(`Project root: ${projectRoot}`);
  process.exit(1);
}

// Now load modules relative to project root
const { kaspa, KASPA_NETWORK } = require(path.join(projectRoot, 'lib', 'config'));
const { createCoinjoinSession, revealUtxosForCoinjoin, buildZeroTrustCoinjoinTransaction, signCoinjoinInputs, submitSignedCoinjoinTransaction, getCoinjoinSignatures, getAllCoinjoinSessions } = require(path.join(projectRoot, 'lib', 'services', 'coinjoin'));
const { getRpcClient } = require(path.join(projectRoot, 'lib', 'rpc-client'));
const walletModule = require(path.join(projectRoot, 'lib', 'wallet'));
const readWallet = () => {
  // readWallet is not exported, so we need to read the wallet file directly
  const fs = require('fs');
  const path = require('path');
  const { DB_PATH } = require(path.join(projectRoot, 'lib', 'config'));
  const WALLET_FILE = path.join(path.dirname(DB_PATH), 'wallet.json');
  try {
    if (fs.existsSync(WALLET_FILE)) {
      const data = fs.readFileSync(WALLET_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    // Ignore errors
  }
  return null;
};
const { importPrivateKey, createMatchingUtxo, waitForUtxoConfirmation, hasMatchingUtxo, sendFromWallet, getWalletInfo } = walletModule;
const { getConfirmedUtxos } = require(path.join(projectRoot, 'lib', 'utils', 'utxo-helpers'));

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logError(message) {
  console.error(`${colors.red}❌ ${message}${colors.reset}`);
}

function logSuccess(message) {
  console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

function logInfo(message) {
  console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
}

function logWarning(message) {
  console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      const configPath = path.resolve(args[i + 1]);
      if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
      }
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      Object.assign(config, configData);
      i++;
    } else if (args[i] === '--participants' && args[i + 1]) {
      config.participants = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--amount' && args[i + 1]) {
      config.amountKAS = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === '--auto-wallet') {
      config.autoWallet = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node scripts/test-coinjoin.js [options]

Options:
  --config <file>          Path to JSON configuration file
  --participants <number>  Number of participants (default: 3)
  --amount <number>        Amount per participant in KAS (default: 1.0)
  --auto-wallet           Use imported wallet for all participants (for quick testing)
  --help, -h              Show this help message

Configuration File Format:
{
  "participants": 3,
  "amountKAS": 1.0,
  "autoWallet": false,
  "participants": [
    {
      "privateKey": "hex...",
      "destinationAddress": "kaspa:...",
      "utxos": [
        { "transactionId": "...", "index": 0, "amount": "100000000" }
      ]
    }
  ]
}
`);
      process.exit(0);
    }
  }
  
  return config;
}

// Automatically find or create UTXOs for a participant
async function prepareParticipantUtxos(privateKeyHex, address, amountKAS, excludeUtxos = []) {
  const targetAmountSompi = BigInt(Math.floor(amountKAS * 1e8));
  
  logInfo(`  Fetching UTXOs for address ${address}...`);
  const { entries: allUtxos } = await getConfirmedUtxos(address);
  
  if (allUtxos.length === 0) {
    throw new Error(`No UTXOs found at address ${address}. Please send funds to this address first.`);
  }
  
  // CRITICAL: Always create new UTXOs - never reuse existing ones
  // Even if we find a matching UTXO, we should create a fresh one to avoid conflicts
  // This ensures each test run uses completely fresh UTXOs
  
  // Build a set of excluded UTXO keys for fast lookup
  const excludedKeys = new Set();
  for (const excludedUtxo of excludeUtxos) {
    const excludedTxId = excludedUtxo.transactionId || excludedUtxo.txId || '';
    const excludedIndex = excludedUtxo.index !== undefined ? excludedUtxo.index : 0;
    excludedKeys.add(`${excludedTxId}:${excludedIndex}`);
  }
  
  // Filter out excluded UTXOs from available UTXOs
  const availableUtxos = allUtxos.filter(utxo => {
    const txId = utxo.outpoint?.transactionId || utxo.transactionId || '';
    const index = utxo.outpoint?.index !== undefined ? utxo.outpoint.index : (utxo.index !== undefined ? utxo.index : 0);
    const key = `${txId}:${index}`;
    return !excludedKeys.has(key);
  });
  
  // Check if any available UTXOs match the target amount AND are not excluded
  // CRITICAL: For fairness and security, require EXACT match - no tolerance
  // This ensures test script creates UTXOs that will pass CoinJoin validation
  
  // First, check if any available UTXOs match the target amount EXACTLY
  for (const utxo of availableUtxos) {
    const amount = BigInt(String(utxo.amount || '0'));
    // Must match EXACTLY - no tolerance allowed
    const matchesAmount = amount === targetAmountSompi;
    
    if (matchesAmount) {
      // Found matching amount - verify it's not in excludeUtxos
      const txId = utxo.outpoint?.transactionId || utxo.transactionId;
      const index = utxo.outpoint?.index !== undefined ? utxo.outpoint.index : utxo.index;
      const key = `${txId}:${index}`;
      
      // Check if this UTXO is excluded
      if (!excludedKeys.has(key)) {
        // Found matching UTXO that's not excluded
        // BUT: For testing, we should still create a new one to avoid any potential issues
        // However, if the user wants to reuse, we can return it here
        // For now, let's log a warning and still create a new one if forceRecreate is enabled
        logInfo(`  Found matching UTXO: ${key} (${(Number(amount) / 1e8).toFixed(8)} KAS), but will create fresh one to avoid reuse`);
        // Continue to create new UTXO below
      } else {
        logInfo(`  UTXO ${key} is excluded (already used in previous session)`);
      }
      // Always create new UTXO to ensure no reuse
    }
  }
  
  // No matching UTXO found - try to create one
  logInfo(`  No matching UTXO found. Attempting to create ${amountKAS} KAS UTXO...`);
  
  // CRITICAL: Derive address from private key - this is the actual address where UTXOs exist
  // The UTXO will be created at wallet.address (derived from private key), not the address parameter
  // So we must use the derived address to ensure consistency
  let actualAddress;
  try {
    const privateKey = new kaspa.PrivateKey(privateKeyHex);
    const keypair = kaspa.Keypair.fromPrivateKey(privateKey);
    actualAddress = keypair.toAddress(KASPA_NETWORK).toString();
    
    if (actualAddress !== address) {
      logWarning(`  ⚠️  Address mismatch: config has ${address}, but private key derives ${actualAddress}`);
      logWarning(`  Using derived address ${actualAddress} (this is where UTXOs will be created)`);
      // Use derived address instead - this is where the UTXO actually exists
      address = actualAddress;
    }
  } catch (err) {
    throw new Error(`Invalid private key: ${err.message}`);
  }
  
  // Create matching UTXO by sending to self
  // Temporarily import wallet for creating UTXO
  const originalWallet = readWallet();
  
  try {
    // Import the private key temporarily
    await importPrivateKey(privateKeyHex);
    
    // CRITICAL: Always create a fresh UTXO for testing - never reuse existing ones
    // Even if a matching UTXO exists, we want to create a new one to avoid conflicts
    // First, check if a matching UTXO exists (excluding already used ones)
    const { hasMatch } = await hasMatchingUtxo(targetAmountSompi, 10, excludeUtxos);
    
    // Get wallet address - use the address we already derived, or derive it again from the private key
    // The wallet should now be imported, so we can get it from getWalletInfo or derive from private key
    let walletAddress = address; // Use the address parameter as fallback
    try {
      const walletInfo = getWalletInfo();
      if (walletInfo && walletInfo.address) {
        walletAddress = walletInfo.address;
      } else {
        // Fallback: derive from private key (same as we did earlier)
        const privateKey = new kaspa.PrivateKey(privateKeyHex);
        const publicKey = privateKey.toPublicKey();
        walletAddress = publicKey.toAddress(KASPA_NETWORK).toString();
      }
    } catch (err) {
      // Final fallback: derive from private key
      const privateKey = new kaspa.PrivateKey(privateKeyHex);
      const publicKey = privateKey.toPublicKey();
      walletAddress = publicKey.toAddress(KASPA_NETWORK).toString();
    }
    
    let createResult;
    if (hasMatch) {
      // A matching UTXO exists, but we want to create a fresh one
      // Force creation by calling sendFromWallet directly
      logInfo(`  Matching UTXO exists, but forcing creation of fresh UTXO to avoid reuse`);
      const amountKAS = Number(targetAmountSompi) / 1e8;
      try {
        logInfo(`  Sending ${amountKAS} KAS to ${walletAddress} to create fresh UTXO...`);
        const result = await sendFromWallet(walletAddress, amountKAS);
        createResult = {
          created: true,
          txId: result.txId,
          message: `Forced creation of fresh UTXO via transaction ${result.txId}`,
          amount: result.amount,
          excludeUtxos: excludeUtxos
        };
        logInfo(`  ✅ Forced UTXO creation transaction submitted: ${result.txId}`);
      } catch (err) {
        logError(`  Error forcing UTXO creation: ${err.message}`);
        throw new Error(`Failed to force create matching UTXO: ${err.message}. Please ensure you have sufficient balance (need ${(Number(targetAmountSompi) / 1e8).toFixed(8)} KAS + fees).`);
      }
    } else {
      // No matching UTXO exists, use createMatchingUtxo normally
      try {
        createResult = await createMatchingUtxo(targetAmountSompi, excludeUtxos);
      } catch (err) {
        logError(`  Error creating UTXO: ${err.message}`);
        throw new Error(`Failed to create matching UTXO: ${err.message}. Please ensure you have sufficient balance (need ${(Number(targetAmountSompi) / 1e8).toFixed(8)} KAS + fees).`);
      }
    }
    
    // Log the result for debugging
    if (createResult.message) {
      logInfo(`  createMatchingUtxo result: ${createResult.message}`);
    }
    
    if (createResult.created || createResult.alreadyInMempool) {
      logInfo(`  UTXO creation transaction submitted: ${createResult.txId}`);
      logInfo(`  Waiting for confirmation...`);
      
      const waitResult = await waitForUtxoConfirmation(
        targetAmountSompi, 
        180000,  // Increased to 3 minutes for 1.5 KAS
        3000,    // Check every 3 seconds
        createResult.txId,
        excludeUtxos
      );
      
      if (waitResult.confirmed && waitResult.utxo) {
        // Use the UTXO returned by waitForUtxoConfirmation
        const newUtxo = waitResult.utxo;
        const utxoAmount = BigInt(String(newUtxo.amount || '0'));
        const expectedAmount = targetAmountSompi;
        const utxoIndex = newUtxo.outpoint?.index !== undefined ? newUtxo.outpoint.index : (newUtxo.index !== undefined ? newUtxo.index : 0);
        
        logSuccess(`  UTXO confirmed: ${newUtxo.outpoint?.transactionId || newUtxo.transactionId}:${utxoIndex} (${(Number(utxoAmount) / 1e8).toFixed(8)} KAS)`);
        
        // CRITICAL: Verify the amount matches EXACTLY - no tolerance allowed
        if (utxoAmount !== expectedAmount) {
          const diff = utxoAmount > expectedAmount 
            ? (Number(utxoAmount - expectedAmount) / 1e8).toFixed(8)
            : (Number(expectedAmount - utxoAmount) / 1e8).toFixed(8);
          logError(`  ❌ UTXO amount ${(Number(utxoAmount) / 1e8).toFixed(8)} KAS does NOT match expected ${(Number(expectedAmount) / 1e8).toFixed(8)} KAS (difference: ${diff} KAS)`);
          throw new Error(`UTXO amount mismatch: Expected exactly ${(Number(expectedAmount) / 1e8).toFixed(8)} KAS, but got ${(Number(utxoAmount) / 1e8).toFixed(8)} KAS. This will fail CoinJoin validation which requires exact matching.`);
        } else {
          logSuccess(`  ✅ UTXO amount verified: Exactly ${(Number(utxoAmount) / 1e8).toFixed(8)} KAS as expected`);
        }
        
        return [{
          transactionId: newUtxo.outpoint?.transactionId || newUtxo.transactionId,
          index: utxoIndex,
          amount: String(utxoAmount)
        }];
      } else if (waitResult.confirmed) {
        // waitForUtxoConfirmation confirmed but didn't return utxo - try to fetch it
        const wallet = readWallet();
        const utxoAddress = wallet && wallet.address ? wallet.address : address;
        logInfo(`  Fetching UTXO from ${utxoAddress} (wallet address)`);
        const { entries: refreshedUtxos } = await getConfirmedUtxos(utxoAddress);
        const newUtxo = refreshedUtxos.find(u => {
          const txId = u.outpoint?.transactionId || u.transactionId;
          return txId === createResult.txId;
        });
        
        if (newUtxo) {
          const utxoAmount = BigInt(String(newUtxo.amount || '0'));
          const expectedAmount = targetAmountSompi;
          const utxoIndex = newUtxo.outpoint?.index !== undefined ? newUtxo.outpoint.index : (newUtxo.index !== undefined ? newUtxo.index : 0);
          
          logSuccess(`  UTXO confirmed: ${newUtxo.outpoint?.transactionId || newUtxo.transactionId}:${utxoIndex} (${(Number(utxoAmount) / 1e8).toFixed(8)} KAS)`);
          
          // CRITICAL: Verify the amount matches EXACTLY - no tolerance allowed
          if (utxoAmount !== expectedAmount) {
            const diff = utxoAmount > expectedAmount 
              ? (Number(utxoAmount - expectedAmount) / 1e8).toFixed(8)
              : (Number(expectedAmount - utxoAmount) / 1e8).toFixed(8);
            logError(`  ❌ UTXO amount ${(Number(utxoAmount) / 1e8).toFixed(8)} KAS does NOT match expected ${(Number(expectedAmount) / 1e8).toFixed(8)} KAS (difference: ${diff} KAS)`);
            throw new Error(`UTXO amount mismatch: Expected exactly ${(Number(expectedAmount) / 1e8).toFixed(8)} KAS, but got ${(Number(utxoAmount) / 1e8).toFixed(8)} KAS. This will fail CoinJoin validation which requires exact matching.`);
          } else {
            logSuccess(`  ✅ UTXO amount verified: Exactly ${(Number(utxoAmount) / 1e8).toFixed(8)} KAS as expected`);
          }
          
          return [{
            transactionId: newUtxo.outpoint?.transactionId || newUtxo.transactionId,
            index: utxoIndex,
            amount: String(utxoAmount)
          }];
        }
      } else {
        logWarning(`  UTXO confirmation timed out. Transaction ${createResult.txId} may still be pending.`);
        logWarning(`  You can try running the script again - it will find the UTXO once confirmed.`);
      }
    } else {
      // createMatchingUtxo returned created: false (e.g., matching UTXO already exists)
      // But we're forcing creation, so this shouldn't happen
      logError(`  createMatchingUtxo returned: ${JSON.stringify(createResult)}`);
      throw new Error(`Failed to create matching UTXO. Result: ${createResult.message || 'Unknown error'}. Please ensure you have sufficient balance (need ${(Number(targetAmountSompi) / 1e8).toFixed(8)} KAS + fees).`);
    }
  } finally {
    // Restore original wallet if it existed
    if (originalWallet) {
      const fs = require('fs');
      const { DB_PATH } = require(path.join(projectRoot, 'lib', 'config'));
      const WALLET_FILE = path.join(path.dirname(DB_PATH), 'wallet.json');
      fs.writeFileSync(WALLET_FILE, JSON.stringify(originalWallet, null, 2), 'utf8');
    }
  }
}

// Generate participant configuration
async function generateParticipantConfig(participantIndex, amountKAS, autoWallet = false) {
  if (autoWallet) {
    // Use imported wallet
    const wallet = readWallet();
    if (!wallet) {
      throw new Error('No wallet imported. Please import a wallet first or set autoWallet=false');
    }
    
    const privateKey = new kaspa.PrivateKey(wallet.privateKeyHex);
    const keypair = kaspa.Keypair.fromPrivateKey(privateKey);
    const address = keypair.toAddress(KASPA_NETWORK).toString();
    
    // Generate a unique destination address for this participant
    const destKeypair = kaspa.Keypair.random();
    const destinationAddress = destKeypair.toAddress(KASPA_NETWORK).toString();
    
    // Get or create UTXOs
    const selectedUtxos = await prepareParticipantUtxos(wallet.privateKeyHex, address, amountKAS, []);
    
    return {
      privateKey: wallet.privateKeyHex,
      address: address,
      destinationAddress: destinationAddress,
      utxos: selectedUtxos
    };
  } else {
    // Generate new keypair for this participant
    const keypair = kaspa.Keypair.random();
    const address = keypair.toAddress(KASPA_NETWORK).toString();
    const privateKey = keypair.privateKey.toString();
    
    // Generate destination address
    const destKeypair = kaspa.Keypair.random();
    const destinationAddress = destKeypair.toAddress(KASPA_NETWORK).toString();
    
    logWarning(`Participant ${participantIndex + 1}: Generated address ${address}`);
    logWarning(`  You need to send ${amountKAS} KAS to this address before running the test.`);
    logWarning(`  Destination: ${destinationAddress}`);
    
    return {
      privateKey: privateKey,
      address: address,
      destinationAddress: destinationAddress,
      utxos: [] // Will be fetched when revealing
    };
  }
}

// Main test function
async function runTest(config) {
  try {
    log('\n' + '='.repeat(60), 'bright');
    log('🚀 Starting Coinjoin Test', 'bright');
    log('='.repeat(60) + '\n', 'bright');
    
    const rpc = await getRpcClient();
    
    // Validate node is ready
    try {
      const dagInfo = await rpc.getBlockDagInfo({});
      logInfo(`Node DAA Score: ${dagInfo.virtualDaaScore}`);
    } catch (err) {
      logError('Failed to connect to Kaspa node. Is kaspad running?');
      throw err;
    }
    
    const participants = config.participants || 3;
    const amountKAS = config.amountKAS || 1.0;
    const autoWallet = config.autoWallet || false;
    
    logInfo(`Participants: ${participants}`);
    logInfo(`Amount per participant: ${amountKAS} KAS`);
    logInfo(`Auto-wallet mode: ${autoWallet ? 'Yes' : 'No'}\n`);
    
    // Generate or load participant configurations
    const participantConfigs = [];
    
    if (config.participants && Array.isArray(config.participants)) {
      // Use provided configurations - automatically prepare UTXOs
      logInfo('Preparing UTXOs for provided participants...');
      
      // Collect all UTXOs from ALL previous sessions to exclude them
      // CRITICAL: We must always create new UTXOs and never reuse old ones
      const excludeUtxos = [];
      const forceRecreate = true; // Force recreation to ensure correct amount and avoid reuse
      try {
        const allSessions = await getAllCoinjoinSessions();
        for (const { session: s } of allSessions) {
          if (s.zeroTrustMode) {
            // Collect UTXOs from all sources (revealed, original, committed)
            const sessionUtxos = s.revealedUtxos || s.originalUtxos || [];
            excludeUtxos.push(...sessionUtxos);
            
            // Also collect from commitments if available (to be thorough)
            if (s.utxoCommitments && s.originalUtxos) {
              excludeUtxos.push(...s.originalUtxos);
            }
          }
        }
        logInfo(`  Excluding ${excludeUtxos.length} UTXO(s) from previous sessions`);
      } catch (err) {
        logWarning(`  Could not load previous sessions for exclusion: ${err.message}`);
      }
      
      for (let i = 0; i < config.participants.length; i++) {
        const participant = config.participants[i];
        
        // Validate required fields
        if (!participant.privateKey) {
          throw new Error(`Participant ${i + 1} missing privateKey`);
        }
        if (!participant.destinationAddress) {
          throw new Error(`Participant ${i + 1} missing destinationAddress`);
        }
        
        // CRITICAL: Derive address from private key - this is where UTXOs actually exist
        // The config address might be wrong, so we always derive from private key
        const privateKey = new kaspa.PrivateKey(participant.privateKey);
        const keypair = kaspa.Keypair.fromPrivateKey(privateKey);
        const derivedAddress = keypair.toAddress(KASPA_NETWORK).toString();
        
        // Use derived address instead of config address
        participant.address = derivedAddress;
        
        if (participant.address && participant.address !== derivedAddress) {
          logWarning(`Participant ${i + 1}: Config address ${participant.address} doesn't match private key. Using derived address ${derivedAddress}`);
        }
        
        logInfo(`Preparing participant ${i + 1}...`);
        logInfo(`  Address (from private key): ${derivedAddress}`);
        logInfo(`  Destination: ${participant.destinationAddress}`);
        
        // CRITICAL: Always create new UTXOs - never reuse old ones
        // forceRecreate ensures we always create fresh UTXOs for each test run
        if (forceRecreate && participant.utxos && participant.utxos.length > 0) {
          logInfo(`  Forcing UTXO recreation for participant ${i + 1} (amount: ${amountKAS} KAS)`);
          // Add existing UTXOs to exclude list to force creation of new ones
          excludeUtxos.push(...participant.utxos);
        }
        
        // Always call prepareParticipantUtxos - it will create new UTXOs if needed
        const utxos = await prepareParticipantUtxos(
          participant.privateKey,
          derivedAddress, // Use derived address
          amountKAS,
          excludeUtxos
        );
        participant.utxos = utxos;
        
        // Update excludeUtxos for next participant to ensure no reuse
        excludeUtxos.push(...utxos);
        
        logSuccess(`Participant ${i + 1}: Found/created ${utxos.length} UTXO(s) (fresh UTXO, not reused)`);
        
        participantConfigs.push(participant);
      }
    } else {
      // Generate configurations
      logInfo('Generating participant configurations...');
      for (let i = 0; i < participants; i++) {
        const participantConfig = await generateParticipantConfig(i, amountKAS, autoWallet);
        participantConfigs.push(participantConfig);
        logSuccess(`Participant ${i + 1} configured`);
      }
    }
    
    log('\n' + '-'.repeat(60), 'bright');
    log('Step 1: Creating Coinjoin Sessions', 'bright');
    log('-'.repeat(60) + '\n', 'bright');
    
    // Create sessions
    const sessionIds = [];
    for (let i = 0; i < participantConfigs.length; i++) {
      const participant = participantConfigs[i];
      logInfo(`Creating session for participant ${i + 1}...`);
      
      const session = await createCoinjoinSession(
        participant.destinationAddress,
        {
          zeroTrustMode: true,
          userUtxos: participant.utxos,
          amount: BigInt(Math.floor(amountKAS * 1e8)) // Convert to sompi
        }
      );
      
      sessionIds.push(session.id);
      logSuccess(`Session created: ${session.id}`);
    }
    
    log('\n' + '-'.repeat(60), 'bright');
    log('Step 2: Revealing UTXOs', 'bright');
    log('-'.repeat(60) + '\n', 'bright');
    
    // Reveal UTXOs for each session
    for (let i = 0; i < sessionIds.length; i++) {
      const sessionId = sessionIds[i];
      const participant = participantConfigs[i];
      
      logInfo(`Revealing UTXOs for participant ${i + 1}...`);
      
      // UTXOs should already be prepared, but verify
      if (!participant.utxos || participant.utxos.length === 0) {
        throw new Error(`No UTXOs prepared for participant ${i + 1}. This should not happen.`);
      }
      
      // Pass the source address (participant.address) so the build phase knows where to query UTXOs
      await revealUtxosForCoinjoin(sessionId, participant.utxos, participant.destinationAddress, participant.address);
      logSuccess(`UTXOs revealed for participant ${i + 1} (${participant.utxos.length} UTXO(s))`);
    }
    
    log('\n' + '-'.repeat(60), 'bright');
    log('Step 3: Building Transaction', 'bright');
    log('-'.repeat(60) + '\n', 'bright');
    
    // Build transaction
    logInfo('Building coinjoin transaction...');
    const transactionData = await buildZeroTrustCoinjoinTransaction(sessionIds);
    logSuccess(`Transaction built successfully`);
    logInfo(`  Inputs: ${transactionData.inputs.length}`);
    logInfo(`  Outputs: ${transactionData.outputs.length}`);
    logInfo(`  Total Input: ${(Number(transactionData.totalInput) / 1e8).toFixed(8)} KAS`);
    logInfo(`  Total Output: ${(Number(transactionData.totalOutput) / 1e8).toFixed(8)} KAS`);
    logInfo(`  Fee: ${(Number(transactionData.fee) / 1e8).toFixed(8)} KAS`);
    
    log('\n' + '-'.repeat(60), 'bright');
    log('Step 4: Signing Inputs', 'bright');
    log('-'.repeat(60) + '\n', 'bright');
    
    // Sign inputs for each participant
    // Collect signatures as array of { inputIndex, signature } objects
    const allSignatures = [];
    
    for (let i = 0; i < sessionIds.length; i++) {
      const sessionId = sessionIds[i];
      const participant = participantConfigs[i];
      
      logInfo(`Signing inputs for participant ${i + 1}...`);
      
      const privateKey = new kaspa.PrivateKey(participant.privateKey);
      // PrivateKey.toString() returns hex string
      const signatures = await signCoinjoinInputs(sessionId, transactionData, privateKey.toString());
      
      // Store signatures - signCoinjoinInputs returns { sessionId, signedInputs: [{ inputIndex, signature }], inputCount }
      // Convert to array format expected by submitSignedCoinjoinTransaction
      if (signatures && signatures.signedInputs && Array.isArray(signatures.signedInputs)) {
        for (const sigEntry of signatures.signedInputs) {
          allSignatures.push({
            inputIndex: sigEntry.inputIndex,
            signature: sigEntry.signature
          });
        }
      }
      
      logSuccess(`Participant ${i + 1} signed ${signatures?.signedInputs?.length || 0} input(s)`);
    }
    
    log('\n' + '-'.repeat(60), 'bright');
    log('Step 5: Submitting Transaction', 'bright');
    log('-'.repeat(60) + '\n', 'bright');
    
    // Submit transaction
    logInfo('Submitting transaction to network...');
    const result = await submitSignedCoinjoinTransaction(transactionData, allSignatures);
    
    logSuccess(`Transaction submitted successfully!`);
    const txId = result.transactionId || result.txId;
    logInfo(`Transaction ID: ${txId}`);
    if (txId) {
      logInfo(`View on explorer: https://kas.fyi/transaction/${txId}`);
    }
    
    log('\n' + '='.repeat(60), 'bright');
    log('✅ Test Completed Successfully!', 'green');
    log('='.repeat(60) + '\n', 'bright');
    
    return {
      success: true,
      txId: txId,
      sessionIds: sessionIds
    };
    
  } catch (error) {
    logError(`Test failed: ${error.message}`);
    console.error(error);
    throw error;
  }
}

// Run the test
async function main() {
  try {
    const config = parseArgs();
    
    // If no config provided, show help
    if (Object.keys(config).length === 0 && process.argv.length === 2) {
      log('No configuration provided. Use --help for usage information.', 'yellow');
      process.exit(1);
    }
    
    await runTest(config);
    process.exit(0);
  } catch (error) {
    logError(`Fatal error: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { runTest, generateParticipantConfig };

