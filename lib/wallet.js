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

// Get wallet info
function getWalletInfo() {
  const wallet = readWallet();
  if (!wallet) {
    return null;
  }
  
  return {
    address: wallet.address,
    importedAt: new Date(wallet.importedAt).toISOString()
  };
}

// Get wallet private key
function getWalletPrivateKey() {
  const wallet = readWallet();
  if (!wallet || !wallet.privateKeyHex) {
    return null;
  }
  return wallet.privateKeyHex;
}

// Get wallet balance
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
        total: 0n,
        confirmed: 0n,
        unconfirmed: 0n,
        utxoCount: 0
      };
    }
    
    const { MIN_CONFIRMATIONS } = require('./config');
    let currentDaaScore = 0;
    try {
      const dagInfo = await rpc.getBlockDagInfo({});
      currentDaaScore = dagInfo.virtualDaaScore || 0;
    } catch (err) {}
    
    let confirmed = 0n;
    let unconfirmed = 0n;
    
    for (const utxo of result.entries) {
      const amount = BigInt(utxo.amount);
      if (utxo.blockDaaScore && (currentDaaScore - utxo.blockDaaScore >= MIN_CONFIRMATIONS)) {
        confirmed += amount;
      } else {
        unconfirmed += amount;
      }
    }
    
    return {
      total: confirmed + unconfirmed,
      confirmed,
      unconfirmed,
      utxoCount: result.entries.length
    };
  } catch (err) {
    throw new Error(`Failed to get wallet balance: ${err.message}`);
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
    
    return {
      txId: result.transactionId,
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

module.exports = {
  importPrivateKey,
  getWalletInfo,
  getWalletPrivateKey,
  getWalletBalance,
  sendFromWallet,
  removeWallet,
};

