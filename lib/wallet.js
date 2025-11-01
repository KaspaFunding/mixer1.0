// Wallet management - import private key and send funds

const { kaspa, KASPA_NETWORK } = require('./config');
const { getRpcClient } = require('./rpc-client');
const path = require('path');
const fs = require('fs');
const { DB_PATH } = require('./config');

// Wallet storage file
const WALLET_FILE = path.join(path.dirname(DB_PATH), 'wallet.json');

// Ensure wallet directory exists
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

// Read wallet data
function readWallet() {
  try {
    if (fs.existsSync(WALLET_FILE)) {
      const data = fs.readFileSync(WALLET_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading wallet file:', err.message);
  }
  return null;
}

// Write wallet data
function writeWallet(walletData) {
  try {
    fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing wallet file:', err.message);
    throw err;
  }
}

// Import private key
function importPrivateKey(privateKeyHex) {
  try {
    // Validate input
    if (typeof privateKeyHex !== 'string' || !privateKeyHex.trim()) {
      throw new Error('Private key must be a hex string');
    }
    
    // Create PrivateKey from hex string (constructor takes hex directly)
    const privateKey = new kaspa.PrivateKey(privateKeyHex.trim());
    
    // Create keypair from private key (alternatively: privateKey.toKeypair())
    const keypair = kaspa.Keypair.fromPrivateKey(privateKey);
    const address = keypair.toAddress(KASPA_NETWORK).toString();
    
    // Store wallet data
    const walletData = {
      address: address,
      privateKeyHex: privateKeyHex,
      importedAt: Date.now()
    };
    
    writeWallet(walletData);
    
    return {
      address,
      privateKeyHex
    };
  } catch (err) {
    throw new Error(`Failed to import private key: ${err.message}`);
  }
}

// Import wallet from mnemonic (BIP44 derivation: m/44'/111111'/0')
function importMnemonic(mnemonicPhrase, passphrase = '') {
  try {
    // Validate input
    if (typeof mnemonicPhrase !== 'string' || !mnemonicPhrase.trim()) {
      throw new Error('Mnemonic phrase must be a string');
    }
    
    // Validate mnemonic
    if (!kaspa.Mnemonic.validate(mnemonicPhrase.trim())) {
      throw new Error('Invalid mnemonic phrase. Please check your words and try again.');
    }
    
    // Create mnemonic object and get seed
    const mnemonic = new kaspa.Mnemonic(mnemonicPhrase.trim());
    const seed = mnemonic.toSeed(passphrase);
    
    // Create XPrv from seed
    const xprv = new kaspa.XPrv(seed);
    
    // Derive account key using BIP44 path: m/44'/111111'/0' (Kaspa mainnet)
    // Path components: 44' (hardened), 111111' (hardened), 0' (hardened)
    const accountKey = xprv.derivePath("m/44'/111111'/0'");
    
    // Get private key from account key (we'll use the account key itself, not derive further)
    // For first address, we typically use m/44'/111111'/0'/0/0 (external chain, first address)
    // But for simplicity, we'll use the account key's private key for the main address
    const addressKey = accountKey.deriveChild(0, false).deriveChild(0, false);
    const privateKey = addressKey.toPrivateKey();
    
    // Create keypair and address
    const keypair = kaspa.Keypair.fromPrivateKey(privateKey);
    const address = keypair.toAddress(KASPA_NETWORK).toString();
    
    // Get private key hex for storage
    const privateKeyHex = privateKey.toString();
    
    // Derive account-level KPUB from the account key
    // This allows users to generate multiple addresses from the same wallet
    const accountXPub = accountKey.toXPub();
    const kpubString = accountXPub.toString(); // This will be in kpub format
    
    // Store wallet data (including KPUB for mnemonic imports)
    const walletData = {
      address: address,
      privateKeyHex: privateKeyHex,
      importedAt: Date.now(),
      importedFrom: 'mnemonic', // Mark that it was imported from mnemonic
      kpub: kpubString, // Store the account-level KPUB
      derivationPath: "m/44'/111111'/0'" // Store the derivation path
    };
    
    writeWallet(walletData);
    
    return {
      address,
      privateKeyHex,
      kpub: kpubString // Return KPUB so it can be displayed
    };
  } catch (err) {
    throw new Error(`Failed to import mnemonic: ${err.message}`);
  }
}

// Detect KPUB/XPUB format
function detectKPUBFormat(extendedKey) {
  if (typeof extendedKey !== 'string') {
    throw new Error('Extended key must be a string');
  }
  
  const trimmed = extendedKey.trim();
  
  // Check for Kaspium KPUB format (Kaspa native format)
  if (trimmed.startsWith('kpub')) {
    return {
      format: 'kaspium',
      prefix: 'kpub',
      walletType: 'kaspium',
      description: 'Kaspium wallet format (Kaspa native)'
    };
  }
  
  // Check for standard Bitcoin-compatible XPUB format
  if (trimmed.startsWith('xpub')) {
    return {
      format: 'standard',
      prefix: 'xpub',
      walletType: 'standard',
      description: 'Standard XPUB format (Bitcoin-compatible, used by Kasware and others)'
    };
  }
  
  // Check for testnet TPUB format
  if (trimmed.startsWith('tpub')) {
    return {
      format: 'testnet',
      prefix: 'tpub',
      walletType: 'testnet',
      description: 'Testnet TPUB format'
    };
  }
  
  // Unknown format
  return {
    format: 'unknown',
    prefix: trimmed.substring(0, 4),
    walletType: 'unknown',
    description: 'Unknown format'
  };
}

// Detect wallet type with optional mnemonic hint
function detectWalletType(extendedKey, mnemonic = null) {
  const formatInfo = detectKPUBFormat(extendedKey);
  
  // Kaspa.js library supports both kpub and xpub natively
  // We can determine more about wallet type if we have mnemonic info
  if (mnemonic) {
    const words = mnemonic.trim().split(/\s+/);
    const wordCount = words.length;
    
    if (formatInfo.format === 'kaspium') {
      return {
        ...formatInfo,
        seedLength: wordCount,
        derivationPath: wordCount === 24 ? "m/44'/111111'/0'" : "m/44'/111111'/0'",
        wallet: wordCount === 24 ? 'kaspium_24' : 'kaspium_12'
      };
    }
    
    if (formatInfo.format === 'standard') {
      // Standard xpub could be from different wallets
      if (wordCount === 24) {
        return {
          ...formatInfo,
          seedLength: 24,
          derivationPath: "m/44'/111111'/0'",
          wallet: 'kasware_24', // or kaspium in standard format
          description: 'Kasware 24-word wallet (standard XPUB format)'
        };
      } else if (wordCount === 12) {
        return {
          ...formatInfo,
          seedLength: 12,
          derivationPath: "m/44'/972/0'",
          wallet: 'kasware_12', // or legacy KDX
          description: 'Kasware 12-word or Legacy KDX wallet'
        };
      }
    }
  }
  
  // Return format info with default derivation path
  return {
    ...formatInfo,
    derivationPath: formatInfo.format === 'kaspium' ? "m/44'/111111'/0'" : "m/44'/111111'/0'",
    wallet: formatInfo.format === 'kaspium' ? 'kaspium' : 'standard'
  };
}

// Generate addresses from extended public key (KPUB/XPUB)
// Supports Kaspium KPUB, standard XPUB, and testnet TPUB formats
// The kaspa.js library handles both kpub and xpub formats natively
function generateAddressesFromKPUB(kpubOrXpub, startIndex = 0, count = 10) {
  try {
    // Validate input
    if (typeof kpubOrXpub !== 'string' || !kpubOrXpub.trim()) {
      throw new Error('KPUB/XPUB must be a string');
    }
    
    const kpubStr = kpubOrXpub.trim();
    
    // Detect format for better error messages and logging
    const formatInfo = detectKPUBFormat(kpubStr);
    if (formatInfo.format === 'unknown') {
      throw new Error(`Unsupported extended key format. Expected kpub, xpub, or tpub, got: ${formatInfo.prefix}`);
    }
    
    // Parse KPUB/XPUB string using kaspa.js XPub constructor
    // The library natively supports both kpub (Kaspa format) and xpub (standard format)
    let xpub;
    try {
      xpub = new kaspa.XPub(kpubStr);
    } catch (err) {
      throw new Error(`Invalid ${formatInfo.format} format: ${err.message}. Please verify your ${formatInfo.prefix} key is correct.`);
    }
    
    // Detect wallet type for better path information
    const walletInfo = detectWalletType(kpubStr);
    
    // Generate addresses
    const addresses = [];
    for (let i = startIndex; i < startIndex + count; i++) {
      try {
        // Derive child key: external chain (0), address index (i)
        // Path: m/44'/111111'/0'/0/i (assuming account key is already at m/44'/111111'/0')
        // If kpub is at account level, we derive: 0 (external chain) then i (address index)
        // Note: Some wallets might use different derivation paths, but most use the standard BIP44 path
        const chainXPub = xpub.deriveChild(0, false);
        const addressXPub = chainXPub.deriveChild(i, false);
        
        // Get public key from extended public key
        const publicKey = addressXPub.toPublicKey();
        
        // Create address from public key
        // PublicKey has toAddress method that works with NetworkType
        const address = publicKey.toAddress(KASPA_NETWORK).toString();
        
        addresses.push({
          index: i,
          path: `${walletInfo.derivationPath}/0/${i}`,
          address: address,
          publicKey: publicKey.toString(),
          walletType: walletInfo.wallet,
          format: formatInfo.format
        });
      } catch (err) {
        console.warn(`Failed to derive address at index ${i}:`, err.message);
        // Continue with next address
      }
    }
    
    if (addresses.length === 0) {
      throw new Error(`Failed to generate any addresses. Please check your ${formatInfo.prefix} key format and try again.`);
    }
    
    return {
      kpub: kpubStr,
      addresses: addresses,
      count: addresses.length,
      formatInfo: formatInfo,
      walletInfo: walletInfo
    };
  } catch (err) {
    throw new Error(`Failed to generate addresses from KPUB/XPUB: ${err.message}`);
  }
}

// Get wallet info
function getWalletInfo() {
  const wallet = readWallet();
  if (!wallet) {
    return null;
  }
  
  const info = {
    address: wallet.address,
    importedAt: new Date(wallet.importedAt).toISOString(),
    importedFrom: wallet.importedFrom || 'privatekey' // Default to privatekey if not specified
  };
  
  // Include KPUB if available (for mnemonic imports)
  if (wallet.kpub) {
    info.kpub = wallet.kpub;
    info.derivationPath = wallet.derivationPath || "m/44'/111111'/0'";
    info.hasKPUB = true;
  } else {
    info.hasKPUB = false;
    info.kpubNote = 'KPUB not available for private key imports. Import via mnemonic to get account-level KPUB.';
  }
  
  return info;
}

// Get wallet private key
function getWalletPrivateKey() {
  const wallet = readWallet();
  if (!wallet || !wallet.privateKeyHex) {
    return null;
  }
  return wallet.privateKeyHex;
}

// Get wallet balance with detailed breakdown
async function getWalletBalance() {
  const wallet = readWallet();
  if (!wallet) {
    throw new Error('No wallet imported. Use "wallet import" to import your private key.');
  }
  
  try {
    const rpc = await getRpcClient();
    const result = await rpc.getUtxosByAddresses({ addresses: [wallet.address] });
    
    if (!result || !result.entries || result.entries.length === 0) {
      return {
        total: 0,
        confirmed: 0,
        unconfirmed: 0,
        mature: 0,
        utxoCount: 0,
        lastUpdated: Date.now()
      };
    }
    
    const { MIN_CONFIRMATIONS } = require('./config');
    let currentDaaScore = 0;
    try {
      const dagInfo = await rpc.getBlockDagInfo({});
      currentDaaScore = typeof dagInfo.virtualDaaScore === 'bigint' 
        ? Number(dagInfo.virtualDaaScore) 
        : (dagInfo.virtualDaaScore || 0);
    } catch (err) {}
    
    let confirmed = 0n;
    let unconfirmed = 0n;
    let mature = 0n;
    
    for (const utxo of result.entries) {
      const amount = BigInt(utxo.amount || 0);
      const blockDaaScore = utxo.blockDaaScore 
        ? (typeof utxo.blockDaaScore === 'bigint' ? Number(utxo.blockDaaScore) : utxo.blockDaaScore)
        : null;
      
      if (blockDaaScore && (currentDaaScore - blockDaaScore >= MIN_CONFIRMATIONS)) {
        confirmed += amount;
        mature += amount; // Mature UTXOs are confirmed and past maturity threshold
      } else {
        unconfirmed += amount;
      }
    }
    
    return {
      total: Number(confirmed + unconfirmed) / 1e8,
      confirmed: Number(confirmed) / 1e8,
      unconfirmed: Number(unconfirmed) / 1e8,
      mature: Number(mature) / 1e8,
      utxoCount: result.entries.length,
      lastUpdated: Date.now()
    };
  } catch (err) {
    throw new Error(`Failed to get wallet balance: ${err.message}`);
  }
}

// Get transaction history for wallet address
async function getWalletTransactionHistory(limit = 50, offset = 0) {
  const wallet = readWallet();
  if (!wallet) {
    throw new Error('No wallet imported');
  }
  
  try {
    const rpc = await getRpcClient();
    const transactions = [];
    const seenTxIds = new Set();
    
    console.log(`[TX History] Fetching transactions for address: ${wallet.address}`);
    
    // Load stored transaction history from wallet file
    const storedTransactions = wallet.transactionHistory || [];
    console.log(`[TX History] Found ${storedTransactions.length} stored transactions`);
    
    // Add stored transactions to the list
    for (const storedTx of storedTransactions) {
      if (storedTx.txId && !seenTxIds.has(storedTx.txId)) {
        seenTxIds.add(storedTx.txId);
        transactions.push({
          ...storedTx,
          // Ensure all fields are present
          timestamp: storedTx.timestamp || Date.now(),
          status: storedTx.status || 'pending',
          confirmations: storedTx.confirmations || 0,
          isConfirmed: storedTx.isConfirmed || false
        });
      }
    }
    
    // Get UTXOs to find transactions where this address received funds
    const utxoResult = await rpc.getUtxosByAddresses({ addresses: [wallet.address] });
    const utxos = utxoResult.entries || [];
    console.log(`[TX History] Found ${utxos.length} UTXOs`);
    
    // Collect transaction IDs from UTXOs (incoming transactions)
    // Since getTransaction might not be available, we'll create simplified transaction records from UTXO data
    for (const utxo of utxos) {
      if (utxo.outpoint && utxo.outpoint.transactionId && !seenTxIds.has(utxo.outpoint.transactionId)) {
        seenTxIds.add(utxo.outpoint.transactionId);
        
        try {
          // Try to get full transaction details if method exists
          let tx = null;
          let txInputs = [];
          let txOutputs = [];
          let fee = 0n;
          let blockHash = null;
          let blockDaaScore = null;
          
          // Check if getTransaction method exists
          if (typeof rpc.getTransaction === 'function') {
            try {
              const txResult = await rpc.getTransaction({
                transactionId: utxo.outpoint.transactionId,
                includeBlockInfo: true
              });
              
              if (txResult && txResult.transaction) {
                tx = txResult.transaction;
                txInputs = tx.inputs || [];
                txOutputs = tx.outputs || [];
                fee = BigInt(tx.fee || 0);
                blockHash = tx.blockHash || null;
                blockDaaScore = tx.blockDaaScore || null;
              }
            } catch (err) {
              console.log(`[TX History] getTransaction failed for ${utxo.outpoint.transactionId}: ${err.message}`);
              // Fallback: create basic transaction from UTXO data
            }
          }
          
          // If we couldn't get full transaction, create a basic record from UTXO
          if (!tx) {
            // This is an incoming transaction (we have the UTXO)
            const incomingAmount = BigInt(utxo.amount || 0);
            const txId = utxo.outpoint.transactionId;
            blockDaaScore = utxo.blockDaaScore || null;
            
            // Get confirmation status from UTXO
            let confirmations = 0;
            let isConfirmed = false;
            let blockTime = null;
            
            if (blockDaaScore !== null && blockDaaScore !== undefined) {
              try {
                const dagInfo = await rpc.getBlockDagInfo({});
                const currentDaaScore = typeof dagInfo.virtualDaaScore === 'bigint' 
                  ? Number(dagInfo.virtualDaaScore) 
                  : (dagInfo.virtualDaaScore || 0);
                const txScore = typeof blockDaaScore === 'bigint' 
                  ? Number(blockDaaScore) 
                  : blockDaaScore;
                confirmations = Math.max(0, currentDaaScore - txScore);
                isConfirmed = confirmations >= 6;
                blockTime = Date.now() - (confirmations * 1000); // Approximate
              } catch (err) {
                blockTime = Date.now();
              }
            } else {
              blockTime = Date.now();
            }
            
            // Only add if not already in stored transactions
            if (!seenTxIds.has(txId)) {
              seenTxIds.add(txId);
              transactions.push({
                txId: txId,
                type: 'received',
                amount: Number(incomingAmount) / 1e8,
                incomingAmount: Number(incomingAmount) / 1e8,
                outgoingAmount: 0,
                fee: 0,
                confirmations: confirmations,
                isConfirmed: isConfirmed,
                blockHash: null,
                blockTime: blockTime,
                timestamp: blockTime,
                status: isConfirmed ? 'confirmed' : 'pending'
              });
            }
            continue;
          }
          
          // Process full transaction data
          // Find our address in outputs (incoming)
          const ourOutputs = txOutputs.filter(out => out.address === wallet.address);
          const incomingAmount = ourOutputs.reduce((sum, out) => sum + BigInt(out.amount || 0), 0n);
          
          // Find our address in inputs (outgoing)  
          const ourInputs = txInputs.filter(inp => inp.address === wallet.address);
          const outgoingAmount = ourInputs.reduce((sum, inp) => sum + BigInt(inp.amount || 0), 0n);
          
          // Determine transaction type and net amount
          let type = 'unknown';
          let netAmount = 0;
          
          // Calculate total sent (all outputs except our own)
          const totalSent = txOutputs
            .filter(out => out.address !== wallet.address)
            .reduce((sum, out) => sum + BigInt(out.amount || 0), 0n);
          
          if (incomingAmount > 0n && outgoingAmount === 0n) {
            // Pure incoming
            type = 'received';
            netAmount = Number(incomingAmount) / 1e8;
          } else if (outgoingAmount > 0n && incomingAmount === 0n) {
            // Pure outgoing (no change back to us)
            type = 'sent';
            netAmount = -Number(totalSent) / 1e8;
          } else if (incomingAmount > 0n && outgoingAmount > 0n) {
            // Change transaction (sent and received change back)
            type = 'sent';
            // Net amount is what we sent to others (excluding change back to us)
            netAmount = -Number(totalSent) / 1e8;
          } else if (outgoingAmount > 0n) {
            // Outgoing without receiving change
            type = 'sent';
            netAmount = -Number(totalSent) / 1e8;
          }
          
          // Get confirmation status
          let confirmations = 0;
          let isConfirmed = false;
          let blockTime = null;
          
          if (blockHash && blockDaaScore !== undefined && blockDaaScore !== null) {
            try {
              const dagInfo = await rpc.getBlockDagInfo({});
              const currentDaaScore = typeof dagInfo.virtualDaaScore === 'bigint' 
                ? Number(dagInfo.virtualDaaScore) 
                : (dagInfo.virtualDaaScore || 0);
              const txDaaScore = typeof blockDaaScore === 'bigint' 
                ? Number(blockDaaScore) 
                : blockDaaScore;
              confirmations = Math.max(0, currentDaaScore - txDaaScore);
              isConfirmed = confirmations >= 6;
              
              // Try to get block time
              if (blockHash && typeof rpc.getBlock === 'function') {
                try {
                  const blockResult = await rpc.getBlock({ hash: blockHash, includeTransactions: false });
                  if (blockResult && blockResult.block && blockResult.block.header) {
                    const timestamp = blockResult.block.header.timestamp;
                    blockTime = typeof timestamp === 'bigint' ? Number(timestamp) * 1000 : timestamp * 1000;
                  }
                } catch (err) {
                  blockTime = Date.now();
                }
              } else {
                blockTime = Date.now();
              }
            } catch (err) {
              console.log(`[TX History] Could not determine confirmations: ${err.message}`);
              blockTime = Date.now();
            }
          } else {
            // Transaction is in mempool
            blockTime = Date.now();
          }
          
          // Only add if we have a valid transaction type and not already stored
          const txId = tx.transactionId || utxo.outpoint.transactionId;
          if (type !== 'unknown' && !seenTxIds.has(txId)) {
            seenTxIds.add(txId);
            transactions.push({
              txId: txId,
              type: type,
              amount: netAmount,
              incomingAmount: Number(incomingAmount) / 1e8,
              outgoingAmount: Number(outgoingAmount) / 1e8,
              fee: Number(fee) / 1e8,
              confirmations: confirmations,
              isConfirmed: isConfirmed,
              blockHash: blockHash,
              blockTime: blockTime,
              timestamp: blockTime || Date.now(),
              status: isConfirmed ? 'confirmed' : 'pending'
            });
          }
        } catch (err) {
          console.log(`[TX History] Error processing UTXO ${utxo.outpoint?.transactionId}: ${err.message}`);
        }
      }
    }
    
    // Check mempool for pending transactions (both incoming and outgoing)
    try {
      if (rpc.getMempoolEntriesByAddresses && typeof rpc.getMempoolEntriesByAddresses === 'function') {
        const mempoolResult = await rpc.getMempoolEntriesByAddresses({ addresses: [wallet.address] });
        const mempoolEntries = mempoolResult.entries || [];
        console.log(`[TX History] Found ${mempoolEntries.length} mempool entries`);
        
        for (const entry of mempoolEntries) {
          if (entry.transactionId && !seenTxIds.has(entry.transactionId)) {
            seenTxIds.add(entry.transactionId);
            try {
              // Try to get transaction details if method exists
              if (typeof rpc.getTransaction === 'function') {
                const txResult = await rpc.getTransaction({
                  transactionId: entry.transactionId,
                  includeBlockInfo: false
                });
                
                if (txResult && txResult.transaction) {
                  const tx = txResult.transaction;
                  const txInputs = tx.inputs || [];
                  const txOutputs = tx.outputs || [];
                  
                  // Check if our address is in inputs (outgoing)
                  const ourInputs = txInputs.filter(inp => inp.address === wallet.address);
                  const outgoingAmount = ourInputs.reduce((sum, inp) => sum + BigInt(inp.amount || 0), 0n);
                  
                  // Check if our address is in outputs (incoming)
                  const ourOutputs = txOutputs.filter(out => out.address === wallet.address);
                  const incomingAmount = ourOutputs.reduce((sum, out) => sum + BigInt(out.amount || 0), 0n);
                  
                  // Calculate total sent to others
                  const totalSent = txOutputs
                    .filter(out => out.address !== wallet.address)
                    .reduce((sum, out) => sum + BigInt(out.amount || 0), 0n);
                  
                  const fee = BigInt(tx.fee || 0);
                  
                  if (outgoingAmount > 0n) {
                    // This is a send transaction
                    transactions.push({
                      txId: entry.transactionId,
                      type: 'sent',
                      amount: -Number(totalSent) / 1e8,
                      incomingAmount: Number(incomingAmount) / 1e8,
                      outgoingAmount: Number(outgoingAmount) / 1e8,
                      fee: Number(fee) / 1e8,
                      confirmations: 0,
                      isConfirmed: false,
                      blockHash: null,
                      blockTime: Date.now(),
                      timestamp: Date.now(),
                      status: 'pending'
                    });
                  } else if (incomingAmount > 0n) {
                    // This is a receive transaction (pending)
                    transactions.push({
                      txId: entry.transactionId,
                      type: 'received',
                      amount: Number(incomingAmount) / 1e8,
                      incomingAmount: Number(incomingAmount) / 1e8,
                      outgoingAmount: 0,
                      fee: Number(fee) / 1e8,
                      confirmations: 0,
                      isConfirmed: false,
                      blockHash: null,
                      blockTime: Date.now(),
                      timestamp: Date.now(),
                      status: 'pending'
                    });
                  }
                }
              }
            } catch (err) {
              console.log(`[TX History] Error processing mempool entry: ${err.message}`);
            }
          }
        }
      }
    } catch (err) {
      console.log(`[TX History] Mempool query failed: ${err.message}`);
    }
    
    console.log(`[TX History] Total transactions found: ${transactions.length} (${storedTransactions.length} stored, ${transactions.length - storedTransactions.length} from UTXOs)`);
    
    // Update stored transaction confirmations if we have new info
    if (wallet.transactionHistory && wallet.transactionHistory.length > 0) {
      let updated = false;
      try {
        const dagInfo = await rpc.getBlockDagInfo({});
        const currentDaaScore = typeof dagInfo.virtualDaaScore === 'bigint' 
          ? Number(dagInfo.virtualDaaScore) 
          : (dagInfo.virtualDaaScore || 0);
        
        for (const storedTx of wallet.transactionHistory) {
          // Try to update confirmations for stored pending transactions
          if (storedTx.status === 'pending' && storedTx.txId) {
            // Method 1: Check if we have UTXO from this transaction (for change outputs or received transactions)
            const utxoFromTx = utxos.find(u => u.outpoint?.transactionId === storedTx.txId);
            if (utxoFromTx && utxoFromTx.blockDaaScore) {
              const txScore = typeof utxoFromTx.blockDaaScore === 'bigint' 
                ? Number(utxoFromTx.blockDaaScore) 
                : utxoFromTx.blockDaaScore;
              const confirmations = Math.max(0, currentDaaScore - txScore);
              const isConfirmed = confirmations >= 6;
              
              storedTx.confirmations = confirmations;
              storedTx.isConfirmed = isConfirmed;
              storedTx.status = isConfirmed ? 'confirmed' : 'pending';
              storedTx.blockHash = utxoFromTx.blockHash || null;
              updated = true;
            } else if (storedTx.type === 'sent') {
              // Method 2: For sent transactions without change, check if transaction was sent recently
              // If it's been more than ~2 minutes (roughly time for 6 confirmations at 1 second blocks),
              // and we don't see the UTXOs we spent anymore, it's likely confirmed
              // This is a heuristic - ideally we'd query the transaction, but that's not available
              const timeSinceSent = Date.now() - (storedTx.timestamp || Date.now());
              const TWO_MINUTES = 2 * 60 * 1000;
              
              // If sent more than 2 minutes ago and we haven't updated it, mark as likely confirmed
              // But be conservative - only mark as confirmed if we're very sure
              if (timeSinceSent > TWO_MINUTES && storedTx.confirmations === 0) {
                // Heuristic: If enough time has passed, transaction is likely in a block
                // We'll estimate based on time (Kaspa blocks are ~1 second apart)
                const estimatedConfirmations = Math.floor(timeSinceSent / 1000);
                if (estimatedConfirmations >= 6) {
                  storedTx.confirmations = estimatedConfirmations;
                  storedTx.isConfirmed = true;
                  storedTx.status = 'confirmed';
                  updated = true;
                }
              }
            }
          }
        }
        
        if (updated) {
          writeWallet(wallet);
        }
      } catch (err) {
        console.log(`[TX History] Could not update stored transaction confirmations: ${err.message}`);
      }
    }
    
    // Sort by timestamp (newest first)
    transactions.sort((a, b) => b.timestamp - a.timestamp);
    
    // Apply pagination
    const paginated = transactions.slice(offset, offset + limit);
    
    return {
      transactions: paginated,
      total: transactions.length,
      limit: limit,
      offset: offset
    };
  } catch (err) {
    console.error(`[TX History] Error: ${err.message}`);
    throw new Error(`Failed to get transaction history: ${err.message}`);
  }
}

// Estimate transaction fee before sending
async function estimateTransactionFee(toAddress, amountKAS) {
  const wallet = readWallet();
  if (!wallet) {
    throw new Error('No wallet imported');
  }
  
  try {
    const rpc = await getRpcClient();
    const amountSompi = BigInt(Math.floor(amountKAS * 1e8));
    
    // Get UTXOs
    const utxoResult = await rpc.getUtxosByAddresses({ addresses: [wallet.address] });
    if (!utxoResult || !utxoResult.entries || utxoResult.entries.length === 0) {
      throw new Error('No UTXOs found in wallet');
    }
    
    const { MIN_CONFIRMATIONS } = require('./config');
    let currentDaaScore = 0;
    try {
      const dagInfo = await rpc.getBlockDagInfo({});
      currentDaaScore = typeof dagInfo.virtualDaaScore === 'bigint' 
        ? Number(dagInfo.virtualDaaScore) 
        : (dagInfo.virtualDaaScore || 0);
    } catch (err) {
      throw new Error(`Failed to get DAA score: ${err.message}`);
    }
    
    // Filter confirmed UTXOs
    const confirmedUtxos = utxoResult.entries.filter(utxo => {
      const blockDaaScore = utxo.blockDaaScore 
        ? (typeof utxo.blockDaaScore === 'bigint' ? Number(utxo.blockDaaScore) : utxo.blockDaaScore)
        : null;
      return blockDaaScore && (currentDaaScore - blockDaaScore >= MIN_CONFIRMATIONS);
    });
    
    if (confirmedUtxos.length === 0) {
      throw new Error('No confirmed UTXOs available');
    }
    
    // Create temporary transaction to estimate fee
    const tempOutputs = [{ address: toAddress, amount: amountSompi }];
    let txPreview;
    try {
      txPreview = kaspa.createTransaction(confirmedUtxos, tempOutputs, 0n);
    } catch (err) {
      throw new Error(`Failed to create transaction preview: ${err.message}`);
    }
    
    // Get fee estimate from node
    let feerate = 1;
    let feeEstimate = null;
    try {
      const feeEstimateResp = await rpc.getFeeEstimate({});
      if (feeEstimateResp && feeEstimateResp.estimate) {
        feeEstimate = feeEstimateResp.estimate;
        if (feeEstimate.priorityBucket && feeEstimate.priorityBucket.feerate !== undefined) {
          feerate = typeof feeEstimate.priorityBucket.feerate === 'bigint' 
            ? Number(feeEstimate.priorityBucket.feerate) 
            : feeEstimate.priorityBucket.feerate;
        }
      }
    } catch (err) {
      // Use default feerate
    }
    
    // Calculate fee: feerate (sompi per mass unit) * transaction mass
    const txMass = typeof txPreview.mass === 'bigint' ? Number(txPreview.mass) : txPreview.mass;
    let fee = BigInt(Math.floor(feerate * txMass));
    if (fee < 10000n) fee = 10000n;
    
    // Calculate total cost (amount + fee)
    const totalCost = amountSompi + fee;
    
    // Calculate available balance
    const totalAvailable = confirmedUtxos.reduce((sum, utxo) => sum + BigInt(utxo.amount || 0), 0n);
    
    // Calculate change (if any)
    const change = totalAvailable - totalCost;
    
    return {
      estimatedFee: Number(fee) / 1e8,
      estimatedFeeRate: feerate,
      transactionMass: txMass,
      totalCost: Number(totalCost) / 1e8,
      availableBalance: Number(totalAvailable) / 1e8,
      change: change > 0n ? Number(change) / 1e8 : 0,
      canSend: totalAvailable >= totalCost,
      feeEstimateData: feeEstimate ? {
        high: feeEstimate.priorityBucket?.feerate || null,
        normal: feeEstimate.normalBuckets?.[0]?.feerate || null,
        low: feeEstimate.lowBuckets?.[0]?.feerate || null
      } : null
    };
  } catch (err) {
    throw new Error(`Failed to estimate transaction fee: ${err.message}`);
  }
}

// Send funds from wallet
async function sendFromWallet(toAddress, amountKAS) {
  const wallet = readWallet();
  if (!wallet) {
    throw new Error('No wallet imported. Use "wallet import" to import your private key.');
  }
  
  // Validate address
  if (!kaspa.Address.validate(toAddress)) {
    throw new Error(`Invalid Kaspa address: ${toAddress}`);
  }
  
  // Validate amount
  const amountSompi = Math.round(amountKAS * 1e8);
  if (amountSompi < 1000) {
    throw new Error('Amount too small. Minimum is 0.00001 KAS (dust threshold).');
  }
  
  try {
    const rpc = await getRpcClient();
    
    // Get UTXOs
    const utxoResult = await rpc.getUtxosByAddresses({ addresses: [wallet.address] });
    if (!utxoResult || !utxoResult.entries || utxoResult.entries.length === 0) {
      throw new Error('No UTXOs found in wallet. Make sure the wallet has funds.');
    }
    
    const { MIN_CONFIRMATIONS } = require('./config');
    let currentDaaScore = 0;
    try {
      const dagInfo = await rpc.getBlockDagInfo({});
      currentDaaScore = dagInfo.virtualDaaScore || 0;
    } catch (err) {
      throw new Error(`Failed to get DAA score: ${err.message}`);
    }
    
    // Filter confirmed UTXOs
    const confirmedUtxos = utxoResult.entries.filter(utxo => 
      utxo.blockDaaScore && (currentDaaScore - utxo.blockDaaScore >= MIN_CONFIRMATIONS)
    );
    
    if (confirmedUtxos.length === 0) {
      throw new Error('No confirmed UTXOs found. Please wait for confirmations.');
    }
    
    const totalAvailable = confirmedUtxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
    const requiredAmount = BigInt(amountSompi);
    
    if (totalAvailable < requiredAmount) {
      throw new Error(`Insufficient balance. Available: ${(Number(totalAvailable) / 1e8).toFixed(8)} KAS, Required: ${amountKAS.toFixed(8)} KAS`);
    }
    
    // Estimate fee
    let fee = 10000n;
    try {
      // Create temporary transaction to estimate fee
      const tempOutputs = [{ address: toAddress, amount: requiredAmount }];
      const txPreview = kaspa.createTransaction(confirmedUtxos, tempOutputs, 0n);
      let feerate = 1;
      try {
        const feeEstimateResp = await rpc.getFeeEstimate({});
        feerate = feeEstimateResp.estimate.priorityBucket.feerate;
      } catch (err) {}
      fee = BigInt(feerate) * BigInt(txPreview.mass);
      if (fee < 10000n) fee = 10000n;
    } catch (err) {
      console.log(`Warning: Could not estimate fee precisely, using default: ${(Number(fee) / 1e8).toFixed(8)} KAS`);
    }
    
    // Calculate outputs
    const availableAfterFee = totalAvailable - fee;
    const sendAmount = availableAfterFee >= requiredAmount ? requiredAmount : availableAfterFee;
    
    // Calculate change (if any)
    const change = availableAfterFee - sendAmount;
    
    let outputs = [{ address: toAddress, amount: sendAmount }];
    
    // Add change output if there's meaningful change (> dust threshold)
    if (change > 1000n) {
      outputs.push({ address: wallet.address, amount: change });
    } else if (change > 0n) {
      // Small change goes to fee
      outputs[0].amount += change;
    }
    
    // Recalculate fee with actual outputs
    try {
      const txPreview = kaspa.createTransaction(confirmedUtxos, outputs, 0n);
      let feerate = 1;
      try {
        const feeEstimateResp = await rpc.getFeeEstimate({});
        feerate = feeEstimateResp.estimate.priorityBucket.feerate;
      } catch (err) {}
      const recalculatedFee = BigInt(feerate) * BigInt(txPreview.mass);
      if (recalculatedFee > fee) {
        // If fee increased, reduce outputs
        fee = recalculatedFee;
        const newAvailable = totalAvailable - fee;
        if (newAvailable < sendAmount) {
          // Can't send full amount after fee increase
          outputs[0].amount = newAvailable > 1000n ? newAvailable : 1000n;
          if (outputs.length > 1) {
            outputs.pop(); // Remove change output
          }
        } else {
          outputs[0].amount = sendAmount;
          const newChange = newAvailable - sendAmount;
          if (newChange > 1000n && outputs.length === 1) {
            outputs.push({ address: wallet.address, amount: newChange });
          } else if (newChange > 0n && outputs.length === 1) {
            outputs[0].amount += newChange;
          }
        }
      }
      if (fee < 10000n) fee = 10000n;
    } catch (err) {
      console.log(`Warning: Could not recalculate fee: ${err.message}`);
    }
    
    // Final verification
    const finalOutputSum = outputs.reduce((sum, o) => sum + o.amount, 0n);
    if (totalAvailable < finalOutputSum + fee) {
      // Adjust last output to balance
      const diff = totalAvailable - finalOutputSum - fee;
      if (diff !== 0n && outputs.length > 0) {
        outputs[0].amount += diff;
      }
    }
    
    console.log(`\nSending transaction:`);
    console.log(`  From: ${wallet.address}`);
    console.log(`  To: ${toAddress}`);
    console.log(`  Amount: ${(Number(outputs[0].amount) / 1e8).toFixed(8)} KAS`);
    if (outputs.length > 1) {
      console.log(`  Change: ${(Number(outputs[1].amount) / 1e8).toFixed(8)} KAS`);
    }
    console.log(`  Fee: ${(Number(fee) / 1e8).toFixed(8)} KAS`);
    
    // Create and sign transaction
    const tx = kaspa.createTransaction(confirmedUtxos, outputs, fee);
    const privateKey = new kaspa.PrivateKey(wallet.privateKeyHex);
    const signedTx = kaspa.signTransaction(tx, [privateKey], true);
    
    // Submit transaction
    const result = await rpc.submitTransaction({ transaction: signedTx });
    const txId = result.transactionId;
    
    // Store sent transaction in wallet history
    // Re-read wallet to get latest data (including any new transaction history)
    const walletData = readWallet();
    if (walletData) {
      if (!walletData.transactionHistory) {
        walletData.transactionHistory = [];
      }
      
      // Calculate total sent (excluding change back to us)
      const totalSent = outputs
        .filter(out => out.address !== wallet.address)
        .reduce((sum, out) => sum + out.amount, 0n);
      
      const changeAmount = outputs
        .filter(out => out.address === wallet.address)
        .reduce((sum, out) => sum + out.amount, 0n);
      
      // Add transaction to history
      const txRecord = {
        txId: txId,
        type: 'sent',
        amount: -Number(totalSent) / 1e8,
        incomingAmount: Number(changeAmount) / 1e8, // Change received back
        outgoingAmount: Number(totalAvailable) / 1e8, // Total spent
        fee: Number(fee) / 1e8,
        toAddress: toAddress,
        timestamp: Date.now(),
        status: 'pending',
        confirmations: 0,
        isConfirmed: false,
        storedBy: 'sendTransaction' // Mark as stored by us
      };
      
      walletData.transactionHistory.push(txRecord);
      
      // Keep only last 1000 transactions to prevent file bloat
      if (walletData.transactionHistory.length > 1000) {
        walletData.transactionHistory = walletData.transactionHistory
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 1000);
      }
      
      writeWallet(walletData);
    }
    
    return {
      txId: txId,
      amount: Number(outputs[0].amount) / 1e8,
      fee: Number(fee) / 1e8,
      change: outputs.length > 1 ? Number(outputs[1].amount) / 1e8 : 0
    };
  } catch (err) {
    throw new Error(`Failed to send transaction: ${err.message}`);
  }
}

// Remove wallet (delete private key)
function removeWallet() {
  try {
    if (fs.existsSync(WALLET_FILE)) {
      fs.unlinkSync(WALLET_FILE);
      return true;
    }
    return false;
  } catch (err) {
    throw new Error(`Failed to remove wallet: ${err.message}`);
  }
}

// ==================== Address Book Functions ====================

// Get all addresses from address book
function getAddressBook() {
  try {
    const wallet = readWallet();
    if (!wallet) {
      return [];
    }
    return wallet.addressBook || [];
  } catch (err) {
    console.error('Error reading address book:', err.message);
    return [];
  }
}

// Add address to address book
function addAddressToBook(address, label, category = '') {
  try {
    // Validate address
    if (!address || typeof address !== 'string') {
      throw new Error('Address is required');
    }
    
    // Validate address format
    if (!kaspa.Address.validate(address)) {
      throw new Error(`Invalid Kaspa address: ${address}`);
    }
    
    // Validate label
    if (!label || typeof label !== 'string' || !label.trim()) {
      throw new Error('Label is required');
    }
    
    const wallet = readWallet();
    if (!wallet) {
      throw new Error('No wallet found. Please import a wallet first.');
    }
    
    // Initialize address book if it doesn't exist
    if (!wallet.addressBook) {
      wallet.addressBook = [];
    }
    
    // Check if address already exists
    const existingIndex = wallet.addressBook.findIndex(entry => entry.address === address);
    if (existingIndex >= 0) {
      throw new Error('Address already exists in address book');
    }
    
    // Add new entry
    const newEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
      address: address.trim(),
      label: label.trim(),
      category: category.trim() || 'General',
      addedAt: Date.now()
    };
    
    wallet.addressBook.push(newEntry);
    writeWallet(wallet);
    
    return newEntry;
  } catch (err) {
    throw new Error(`Failed to add address to book: ${err.message}`);
  }
}

// Update address in address book
function updateAddressInBook(id, updates) {
  try {
    const wallet = readWallet();
    if (!wallet || !wallet.addressBook) {
      throw new Error('Address book is empty');
    }
    
    const index = wallet.addressBook.findIndex(entry => entry.id === id);
    if (index < 0) {
      throw new Error('Address not found in address book');
    }
    
    // Validate updates
    if (updates.label !== undefined) {
      if (typeof updates.label !== 'string' || !updates.label.trim()) {
        throw new Error('Label cannot be empty');
      }
      wallet.addressBook[index].label = updates.label.trim();
    }
    
    if (updates.category !== undefined) {
      wallet.addressBook[index].category = typeof updates.category === 'string' 
        ? updates.category.trim() || 'General' 
        : 'General';
    }
    
    if (updates.address !== undefined) {
      // Validate new address format
      if (!kaspa.Address.validate(updates.address)) {
        throw new Error(`Invalid Kaspa address: ${updates.address}`);
      }
      
      // Check if new address already exists (excluding current entry)
      const duplicate = wallet.addressBook.find(entry => 
        entry.id !== id && entry.address === updates.address.trim()
      );
      if (duplicate) {
        throw new Error('Address already exists in address book');
      }
      
      wallet.addressBook[index].address = updates.address.trim();
    }
    
    wallet.addressBook[index].updatedAt = Date.now();
    writeWallet(wallet);
    
    return wallet.addressBook[index];
  } catch (err) {
    throw new Error(`Failed to update address: ${err.message}`);
  }
}

// Remove address from address book
function removeAddressFromBook(id) {
  try {
    const wallet = readWallet();
    if (!wallet || !wallet.addressBook) {
      throw new Error('Address book is empty');
    }
    
    const index = wallet.addressBook.findIndex(entry => entry.id === id);
    if (index < 0) {
      throw new Error('Address not found in address book');
    }
    
    const removed = wallet.addressBook.splice(index, 1)[0];
    writeWallet(wallet);
    
    return removed;
  } catch (err) {
    throw new Error(`Failed to remove address: ${err.message}`);
  }
}

module.exports = {
  importPrivateKey,
  importMnemonic,
  generateAddressesFromKPUB,
  detectKPUBFormat,
  detectWalletType,
  getWalletInfo,
  getWalletPrivateKey,
  getWalletBalance,
  getWalletTransactionHistory,
  estimateTransactionFee,
  sendFromWallet,
  removeWallet,
  // Address Book
  getAddressBook,
  addAddressToBook,
  updateAddressInBook,
  removeAddressFromBook,
};

