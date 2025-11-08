// Wallet management - import private key and send funds

const { kaspa, KASPA_NETWORK } = require('./config');
const { getRpcClient } = require('./rpc-client');
const path = require('path');
const fs = require('fs');
const { DB_PATH } = require('./config');
const { validateAddress, validateAndConvertAmount } = require('./utils/validation');
const { getConfirmedUtxos } = require('./utils/utxo-helpers');
const { estimateFee, recalculateFee, calculateAvailableAfterFee, calculateChange, isChangeAboveDust } = require('./services/fee-calculator');
const { createOutputsWithChange, adjustOutputsForFeeIncrease, balanceTransaction, createSignAndSubmit } = require('./services/transaction-builder');

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
    
    // Create PrivateKey from hex string
    const privateKey = new kaspa.PrivateKey(privateKeyHex.trim());
    
    // Create keypair from private key
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
    
    // Derive account key using BIP44 path: m/44'/111111'/0'
    const accountKey = xprv.derivePath("m/44'/111111'/0'");
    
    // Derive address key from account key
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
  
  const {
    loadStoredTransactions,
    createTransactionFromUtxo,
    createTransactionFromFullTx,
    processMempoolEntries,
    updateStoredTransactionConfirmations,
    getFullTransactionDetails
  } = require('./services/transaction-history');
  
  try {
    const rpc = await getRpcClient();
    const transactions = [];
    const seenTxIds = new Set();
    
    console.log(`[TX History] Fetching transactions for address: ${wallet.address}`);
    
    // Load stored transactions
    const storedTxs = loadStoredTransactions(wallet, seenTxIds);
    transactions.push(...storedTxs);
    console.log(`[TX History] Found ${storedTxs.length} stored transactions`);
    
    // Get UTXOs to find incoming transactions
    const { entries: utxos } = await getConfirmedUtxos(wallet.address);
    console.log(`[TX History] Found ${utxos.length} UTXOs`);
    
    // Process UTXOs to find transactions
    for (const utxo of utxos) {
      try {
        const txId = utxo.outpoint?.transactionId;
        if (!txId) {
          continue;
        }
        
        const txData = await getFullTransactionDetails(txId, rpc);
        
        if (txData) {
          const tx = await createTransactionFromFullTx(txData, utxo, wallet, rpc, seenTxIds);
          if (tx) {
            transactions.push(tx);
          }
        } else {
          const tx = await createTransactionFromUtxo(utxo, wallet, rpc, seenTxIds);
          if (tx) {
            transactions.push(tx);
          }
        }
      } catch (err) {
        console.log(`[TX History] Error processing UTXO ${utxo.outpoint?.transactionId}: ${err.message}`);
      }
    }
    
    // Process mempool entries
    const mempoolTxs = await processMempoolEntries(wallet, rpc, seenTxIds);
    transactions.push(...mempoolTxs);
    console.log(`[TX History] Found ${mempoolTxs.length} mempool entries`);
    
    console.log(`[TX History] Total transactions found: ${transactions.length} (${storedTxs.length} stored, ${transactions.length - storedTxs.length} from UTXOs)`);
    
    // Update stored transaction confirmations
    const updated = await updateStoredTransactionConfirmations(wallet, utxos, rpc);
    if (updated) {
      writeWallet(wallet);
    }
    
    // Sort and paginate
    transactions.sort((a, b) => b.timestamp - a.timestamp);
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

// Validate wallet and inputs for sending
function validateWalletAndInputs(wallet, toAddress, amountKAS) {
  if (!wallet) {
    throw new Error('No wallet imported. Use "wallet import" to import your private key.');
  }
  
  const addressValidation = validateAddress(toAddress);
  if (!addressValidation.valid) {
    throw new Error(addressValidation.error);
  }
  
  const amountValidation = validateAndConvertAmount(amountKAS);
  if (!amountValidation.valid) {
    throw new Error(amountValidation.error);
  }
  
  return { amountSompi: amountValidation.amountSompi };
}

// Check wallet balance
async function checkWalletBalance(walletAddress, requiredAmount) {
  const { entries, total } = await getConfirmedUtxos(walletAddress);
  
  if (entries.length === 0) {
    throw new Error('No confirmed UTXOs found. Please wait for confirmations.');
  }
  
  if (total < BigInt(requiredAmount)) {
    throw new Error(`Insufficient balance. Available: ${(Number(total) / 1e8).toFixed(8)} KAS, Required: ${(requiredAmount / 1e8).toFixed(8)} KAS`);
  }
  
  return { utxos: entries, total };
}

// Calculate initial outputs with change
function calculateInitialOutputs(toAddress, sendAmount, changeAddress, availableAfterFee, requiredAmount) {
  const send = availableAfterFee >= requiredAmount ? requiredAmount : availableAfterFee;
  const change = calculateChange(availableAfterFee, send);
  
  return createOutputsWithChange(toAddress, send, changeAddress, change);
}

// Adjust outputs when fee increases
function adjustOutputsForIncreasedFee(outputs, totalAvailable, newFee, sendAmount, changeAddress) {
  const newAvailable = totalAvailable - newFee;
  return adjustOutputsForFeeIncrease(outputs, newAvailable, sendAmount, changeAddress);
}

// Log transaction details
function logTransactionDetails(walletAddress, toAddress, outputs, fee) {
  console.log(`\nSending transaction:`);
  console.log(`  From: ${walletAddress}`);
  console.log(`  To: ${toAddress}`);
  console.log(`  Amount: ${(Number(outputs[0].amount) / 1e8).toFixed(8)} KAS`);
  if (outputs.length > 1) {
    console.log(`  Change: ${(Number(outputs[1].amount) / 1e8).toFixed(8)} KAS`);
  }
  console.log(`  Fee: ${(Number(fee) / 1e8).toFixed(8)} KAS`);
}

// Create transaction record for history
function createTransactionRecord(txId, outputs, walletAddress, toAddress, totalAvailable, fee) {
  const totalSent = outputs
    .filter(out => out.address !== walletAddress)
    .reduce((sum, out) => sum + out.amount, 0n);
  
  const changeAmount = outputs
    .filter(out => out.address === walletAddress)
    .reduce((sum, out) => sum + out.amount, 0n);
  
  return {
    txId: txId,
    type: 'sent',
    amount: -Number(totalSent) / 1e8,
    incomingAmount: Number(changeAmount) / 1e8,
    outgoingAmount: Number(totalAvailable) / 1e8,
    fee: Number(fee) / 1e8,
    toAddress: toAddress,
    timestamp: Date.now(),
    status: 'pending',
    confirmations: 0,
    isConfirmed: false,
    storedBy: 'sendTransaction'
  };
}

// Save transaction to wallet history
function saveTransactionToHistory(walletData, txRecord) {
  if (!walletData.transactionHistory) {
    walletData.transactionHistory = [];
  }
  
  walletData.transactionHistory.push(txRecord);
  
  // Keep only last 1000 transactions
  if (walletData.transactionHistory.length > 1000) {
    walletData.transactionHistory = walletData.transactionHistory
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 1000);
  }
  
  writeWallet(walletData);
}

// Send funds from wallet
async function sendFromWallet(toAddress, amountKAS) {
  const wallet = readWallet();
  const { amountSompi } = validateWalletAndInputs(wallet, toAddress, amountKAS);
  
  try {
    const requiredAmount = BigInt(amountSompi);
    const { utxos: confirmedUtxos, total: totalAvailable } = await checkWalletBalance(wallet.address, requiredAmount);
    
    // Estimate initial fee
    const tempOutputs = [{ address: toAddress, amount: requiredAmount }];
    let fee = await estimateFee(confirmedUtxos, tempOutputs);
    
    // Calculate initial outputs
    const availableAfterFee = calculateAvailableAfterFee(totalAvailable, fee);
    let outputs = calculateInitialOutputs(toAddress, availableAfterFee, wallet.address, availableAfterFee, requiredAmount);
    
    // Recalculate fee with actual outputs
    // IMPORTANT: When creating a UTXO for a specific amount, we must preserve output[0].amount = requiredAmount
    // If fees increase, we should reduce the change output, not the send amount
    try {
      const recalculatedFee = await recalculateFee(confirmedUtxos, outputs);
      if (recalculatedFee > fee) {
        fee = recalculatedFee;
        // Adjust outputs, but ensure output[0] (the send amount) stays at requiredAmount
        const newAvailable = totalAvailable - fee;
        const currentSendAmount = outputs[0].amount;
        
        // If we have enough for the required amount, keep it at requiredAmount
        if (newAvailable >= requiredAmount && currentSendAmount === requiredAmount) {
          // Keep send amount at requiredAmount, adjust change only
          const changeAmount = newAvailable - requiredAmount;
          outputs = createOutputsWithChange(toAddress, requiredAmount, wallet.address, changeAmount);
        } else {
          // Fallback to proportional adjustment if we can't preserve exact amount
          outputs = adjustOutputsForIncreasedFee(outputs, totalAvailable, fee, requiredAmount, wallet.address);
        }
      }
    } catch (err) {
      console.log(`Warning: Could not recalculate fee: ${err.message}`);
    }
    
    // Final balance check
    // IMPORTANT: When sending to self (creating UTXO), preserve output[0].amount = requiredAmount
    // Only adjust change output to balance the transaction
    const outputSum = outputs.reduce((sum, o) => sum + o.amount, 0n);
    const diff = totalAvailable - outputSum - fee;
    
    if (diff !== 0n) {
      // If sending to self, preserve the exact send amount and adjust change
      if (toAddress === wallet.address && outputs[0].amount === requiredAmount) {
        // Adjust change output (or create/add to it)
        if (outputs.length > 1) {
          // Change output exists, adjust it
          outputs[1].amount += diff;
        } else if (diff > 0n) {
          // Add change output
          outputs.push({ address: wallet.address, amount: diff });
        } else {
          // Negative diff means we're short - this shouldn't happen if we calculated correctly
          console.warn(`[Wallet] Transaction balance issue: diff = ${diff}, but trying to preserve exact amount`);
          // Fallback: adjust output[0] slightly (this is a last resort)
          outputs[0].amount += diff;
        }
      } else {
        // Normal transaction - use standard balancing
        outputs = balanceTransaction(totalAvailable, outputs, fee);
      }
    }
    
    // Log transaction
    logTransactionDetails(wallet.address, toAddress, outputs, fee);
    
    // Create, sign, and submit
    const privateKey = new kaspa.PrivateKey(wallet.privateKeyHex);
    const { txId } = await createSignAndSubmit(confirmedUtxos, outputs, fee, [privateKey]);
    
    // Save to history
    const walletData = readWallet();
    if (walletData) {
      const txRecord = createTransactionRecord(txId, outputs, wallet.address, toAddress, totalAvailable, fee);
      saveTransactionToHistory(walletData, txRecord);
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

// Check if wallet has a UTXO matching target amount (within tolerance)
// Excludes UTXOs that are already committed/revealed in other sessions
async function hasMatchingUtxo(targetAmountSompi, tolerancePercent = 10, excludeUtxos = []) {
  const wallet = readWallet();
  if (!wallet) {
    throw new Error('No wallet imported');
  }
  
  const { entries: utxos } = await getConfirmedUtxos(wallet.address);
  if (utxos.length === 0) {
    return { hasMatch: false, utxo: null };
  }
  
  // Create a set of excluded UTXO keys (transactionId:index) for quick lookup
  const excludedKeys = new Set();
  for (const excludedUtxo of excludeUtxos) {
    const txId = excludedUtxo.transactionId || excludedUtxo.txId || excludedUtxo.outpoint?.transactionId || '';
    const index = excludedUtxo.index !== undefined ? excludedUtxo.index : 
                  (excludedUtxo.outputIndex !== undefined ? excludedUtxo.outputIndex :
                  (excludedUtxo.outpoint?.index !== undefined ? excludedUtxo.outpoint.index : 0));
    excludedKeys.add(`${txId}:${index}`);
  }
  
  // Filter out excluded UTXOs
  const availableUtxos = utxos.filter(utxo => {
    const txId = utxo.outpoint?.transactionId || utxo.transactionId || '';
    const index = utxo.outpoint?.index !== undefined ? utxo.outpoint.index : (utxo.index !== undefined ? utxo.index : 0);
    const key = `${txId}:${index}`;
    return !excludedKeys.has(key);
  });
  
  if (availableUtxos.length === 0) {
    return { hasMatch: false, utxo: null };
  }
  
  const tolerance = (targetAmountSompi * BigInt(tolerancePercent)) / 100n;
  const minAmount = targetAmountSompi - tolerance;
  const maxAmount = targetAmountSompi + tolerance;
  
  // Look for exact match first
  for (const utxo of availableUtxos) {
    const amount = BigInt(String(utxo.amount || '0'));
    if (amount === targetAmountSompi) {
      return { hasMatch: true, utxo, exact: true };
    }
  }
  
  // Look for match within tolerance
  for (const utxo of availableUtxos) {
    const amount = BigInt(String(utxo.amount || '0'));
    if (amount >= minAmount && amount <= maxAmount) {
      return { hasMatch: true, utxo, exact: false };
    }
  }
  
  return { hasMatch: false, utxo: null };
}

// Create a matching UTXO by sending target amount to self
// Excludes UTXOs that are already committed/revealed in other sessions
async function createMatchingUtxo(targetAmountSompi, excludeUtxos = [], retryCount = 0, maxRetries = 3) {
  const wallet = readWallet();
  if (!wallet) {
    throw new Error('No wallet imported');
  }
  
  // Check if we already have a matching UTXO (excluding already used ones)
  const { hasMatch } = await hasMatchingUtxo(targetAmountSompi, 10, excludeUtxos);
  if (hasMatch) {
    return { created: false, message: 'Matching UTXO already exists' };
  }
  
  // Convert to KAS for sendFromWallet
  const amountKAS = Number(targetAmountSompi) / 1e8;
  
  try {
    // Send to self (wallet address)
    const result = await sendFromWallet(wallet.address, amountKAS);
    
    // Return the transaction ID so we can track the specific UTXO created
    return {
      created: true,
      txId: result.txId,
      message: `Created matching UTXO via transaction ${result.txId}. Waiting for confirmation...`,
      amount: result.amount,
      excludeUtxos: excludeUtxos // Pass along so waitForUtxoConfirmation can exclude old UTXOs
    };
  } catch (err) {
    const errorMessage = err.message || String(err);
    
    // Check if error is "already in mempool" - this means the transaction was already submitted
    const mempoolMatch = errorMessage.match(/transaction\s+([a-f0-9]+)\s+is\s+already\s+in\s+the\s+mempool/i);
    
    if (mempoolMatch && mempoolMatch[1]) {
      // Transaction is already in mempool - this is actually a success case
      const txId = mempoolMatch[1];
      console.log(`[Wallet] Transaction ${txId} is already in mempool, treating as success`);
      
      return {
        created: true,
        txId: txId,
        outputIndex: 0, // The exact amount UTXO is at index 0
        message: `Transaction ${txId} is already in mempool. Waiting for confirmation...`,
        amount: amountKAS,
        targetAmount: Number(targetAmountSompi) / 1e8, // Store target for verification
        alreadyInMempool: true
      };
    }
    
    // Check if error is "already spent by transaction in mempool" - retry after delay
    const alreadySpentMatch = errorMessage.match(/output\s+\([^)]+\)\s+already\s+spent\s+by\s+transaction\s+([a-f0-9]+)\s+in\s+the\s+mempool/i);
    
    if (alreadySpentMatch && retryCount < maxRetries) {
      // UTXO is locked in a pending transaction - wait and retry
      const pendingTxId = alreadySpentMatch[1];
      const retryDelay = 3000 * (retryCount + 1); // 3s, 6s, 9s
      
      console.log(`[Wallet] UTXO locked by pending transaction ${pendingTxId}. Retrying in ${retryDelay}ms (attempt ${retryCount + 1}/${maxRetries})...`);
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      
      // Retry
      return createMatchingUtxo(targetAmountSompi, excludeUtxos, retryCount + 1, maxRetries);
    }
    
    // Re-throw other errors or if max retries reached
    throw err;
  }
}

// Wait for UTXO to be confirmed (poll until found)
// Optionally track a specific transaction ID to wait for a NEW UTXO from that transaction
async function waitForUtxoConfirmation(targetAmountSompi, timeoutMs = 60000, pollIntervalMs = 2000, createdTxId = null, excludeUtxos = []) {
  const startTime = Date.now();
  
  // Track which UTXOs existed before we created the new one
  const existingUtxoKeys = new Set();
  if (excludeUtxos && excludeUtxos.length > 0) {
    for (const utxo of excludeUtxos) {
      const txId = utxo.transactionId || utxo.txId || utxo.outpoint?.transactionId || '';
      const index = utxo.index !== undefined ? utxo.index : 
                    (utxo.outputIndex !== undefined ? utxo.outputIndex :
                    (utxo.outpoint?.index !== undefined ? utxo.outpoint.index : 0));
      existingUtxoKeys.add(`${txId}:${index}`);
    }
  }
  
  // If we know the transaction ID that created the UTXO, we can check for it specifically
  if (createdTxId) {
    const rpc = await getRpcClient();
    const wallet = readWallet();
    if (!wallet) {
      return { confirmed: false, message: 'No wallet found' };
    }
    
    // Poll for UTXO from the specific transaction
    while (Date.now() - startTime < timeoutMs) {
      try {
        const utxoResult = await rpc.getUtxosByAddresses({ addresses: [wallet.address] });
        if (utxoResult && utxoResult.entries) {
          // Look for UTXO from the created transaction
          // When sending to self, we create two outputs: [targetAmount, change]
          // We MUST get the first output (index 0) which is exactly targetAmountSompi
          // CRITICAL: First, try to find index 0 with exact match (no tolerance)
          let newUtxo = utxoResult.entries.find(utxo => {
            const txId = utxo.outpoint?.transactionId || utxo.transactionId || '';
            const index = utxo.outpoint?.index !== undefined ? utxo.outpoint.index : (utxo.index !== undefined ? utxo.index : 0);
            
            // Must be from our transaction AND be index 0 with exact amount match
            if (txId === createdTxId && index === 0) {
              const amount = BigInt(String(utxo.amount || '0'));
              // EXACT match required for index 0 (no tolerance)
              return amount === targetAmountSompi;
            }
            return false;
          });
          
          // If we didn't find index 0 with exact match, look for any output from this transaction
          // This is a fallback - but we should always find index 0
          if (!newUtxo) {
            console.warn(`[Wallet] Warning: Could not find index 0 UTXO with exact amount ${targetAmountSompi} from transaction ${createdTxId}. Looking for any output from this transaction...`);
            newUtxo = utxoResult.entries.find(utxo => {
              const txId = utxo.outpoint?.transactionId || utxo.transactionId || '';
              const index = utxo.outpoint?.index !== undefined ? utxo.outpoint.index : (utxo.index !== undefined ? utxo.index : 0);
              
              // Must be from our transaction
              if (txId === createdTxId) {
                const amount = BigInt(String(utxo.amount || '0'));
                // For fallback, still prefer index 0 with 1% tolerance
                if (index === 0) {
                  const tolerance = targetAmountSompi / 100n;
                  return amount >= (targetAmountSompi - tolerance) && amount <= (targetAmountSompi + tolerance);
                }
                // For other indices, only accept if they match exactly (shouldn't happen)
                return amount === targetAmountSompi;
              }
              return false;
            });
          }
          
          if (newUtxo) {
            // Found the new UTXO from our transaction
            // CRITICAL: Serialize the UTXO amount properly before returning (WASM objects need conversion)
            let serializedAmount = '0';
            try {
              // Handle WASM Sompi objects (they have toString() method)
              // First, try to get the raw amount value
              const rawAmount = newUtxo.amount;
              console.log(`[Wallet] Serializing UTXO amount. Raw type: ${typeof rawAmount}, value: ${rawAmount}`);
              
              if (rawAmount) {
                if (typeof rawAmount === 'bigint') {
                  serializedAmount = rawAmount.toString();
                } else if (typeof rawAmount.toString === 'function') {
                  serializedAmount = rawAmount.toString();
                } else if (typeof rawAmount === 'string') {
                  serializedAmount = rawAmount;
                } else if (typeof rawAmount === 'number') {
                  serializedAmount = String(rawAmount);
                } else {
                  // For WASM objects, try toJSON() first, then toString()
                  if (typeof rawAmount.toJSON === 'function') {
                    const json = rawAmount.toJSON();
                    serializedAmount = json ? String(json) : '0';
                  } else {
                    // Last resort: try String conversion
                    serializedAmount = String(rawAmount);
                  }
                }
              }
              
              // Verify the serialized amount is valid
              const amountBigInt = BigInt(serializedAmount || '0');
              console.log(`[Wallet] Serialized UTXO amount: ${serializedAmount} (${Number(amountBigInt) / 1e8} KAS)`);
            } catch (err) {
              console.error(`[Wallet] Error serializing UTXO amount:`, err);
              console.error(`[Wallet] UTXO object:`, newUtxo);
              serializedAmount = '0';
            }
            
            // Return serialized UTXO with proper amount
            const serializedUtxo = {
              confirmed: true,
              utxo: {
                transactionId: newUtxo.outpoint?.transactionId || newUtxo.transactionId || '',
                index: newUtxo.outpoint?.index !== undefined ? newUtxo.outpoint.index : (newUtxo.index !== undefined ? newUtxo.index : 0),
                amount: serializedAmount,
                scriptPublicKey: newUtxo.scriptPublicKey ? {
                  version: newUtxo.scriptPublicKey.version,
                  script: newUtxo.scriptPublicKey.script ? String(newUtxo.scriptPublicKey.script) : ''
                } : null
              }
            };
            
            console.log(`[Wallet] Returning serialized UTXO:`, JSON.stringify(serializedUtxo, null, 2));
            return serializedUtxo;
          }
        }
      } catch (err) {
        console.warn(`[Wallet] Error checking for UTXO from transaction ${createdTxId}:`, err.message);
      }
      
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  } else {
    // Fallback: check for any new matching UTXO (not in excludeUtxos)
    while (Date.now() - startTime < timeoutMs) {
      const { hasMatch, utxo } = await hasMatchingUtxo(targetAmountSompi, 10, excludeUtxos);
      if (hasMatch && utxo) {
        // Verify this UTXO wasn't in our exclusion list
        const txId = utxo.outpoint?.transactionId || utxo.transactionId || '';
        const index = utxo.outpoint?.index !== undefined ? utxo.outpoint.index : (utxo.index !== undefined ? utxo.index : 0);
        const key = `${txId}:${index}`;
        
        if (!existingUtxoKeys.has(key)) {
          // This is a new UTXO, not one we excluded
          // CRITICAL: Serialize the UTXO amount properly before returning (WASM objects need conversion)
          let serializedAmount = '0';
          try {
            // Handle WASM Sompi objects (they have toString() method)
            if (utxo.amount) {
              if (typeof utxo.amount === 'bigint') {
                serializedAmount = utxo.amount.toString();
              } else if (typeof utxo.amount.toString === 'function') {
                serializedAmount = utxo.amount.toString();
              } else if (typeof utxo.amount === 'string') {
                serializedAmount = utxo.amount;
              } else if (typeof utxo.amount === 'number') {
                serializedAmount = String(utxo.amount);
              } else {
                // Try to convert to string
                serializedAmount = String(utxo.amount);
              }
            }
          } catch (err) {
            console.warn(`[Wallet] Error serializing UTXO amount:`, err);
            serializedAmount = '0';
          }
          
          // Return serialized UTXO with proper amount
          return {
            confirmed: true,
            utxo: {
              transactionId: utxo.outpoint?.transactionId || utxo.transactionId || '',
              index: utxo.outpoint?.index !== undefined ? utxo.outpoint.index : (utxo.index !== undefined ? utxo.index : 0),
              amount: serializedAmount,
              scriptPublicKey: utxo.scriptPublicKey ? {
                version: utxo.scriptPublicKey.version,
                script: utxo.scriptPublicKey.script ? String(utxo.scriptPublicKey.script) : ''
              } : null
            }
          };
        }
      }
      
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }
  
  return { confirmed: false, message: 'Timeout waiting for UTXO confirmation' };
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
  // UTXO Preparation
  hasMatchingUtxo,
  createMatchingUtxo,
  waitForUtxoConfirmation,
};

