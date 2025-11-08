// Transaction history processing service

const { getRpcClient } = require('../rpc-client');
const { getConfirmedUtxos } = require('../utils/utxo-helpers');

// Load stored transactions from wallet
function loadStoredTransactions(wallet, seenTxIds) {
  const storedTransactions = wallet.transactionHistory || [];
  const transactions = [];
  
  for (const storedTx of storedTransactions) {
    if (storedTx.txId && !seenTxIds.has(storedTx.txId)) {
      seenTxIds.add(storedTx.txId);
      transactions.push({
        ...storedTx,
        timestamp: storedTx.timestamp || Date.now(),
        status: storedTx.status || 'pending',
        confirmations: storedTx.confirmations || 0,
        isConfirmed: storedTx.isConfirmed || false
      });
    }
  }
  
  return transactions;
}

// Calculate confirmations from DAA score
async function calculateConfirmations(blockDaaScore, rpc) {
  if (blockDaaScore === null || blockDaaScore === undefined) {
    return { confirmations: 0, isConfirmed: false };
  }
  
  try {
    const dagInfo = await rpc.getBlockDagInfo({});
    const currentDaaScore = typeof dagInfo.virtualDaaScore === 'bigint' 
      ? Number(dagInfo.virtualDaaScore) 
      : (dagInfo.virtualDaaScore || 0);
    const txScore = typeof blockDaaScore === 'bigint' 
      ? Number(blockDaaScore) 
      : blockDaaScore;
    const confirmations = Math.max(0, currentDaaScore - txScore);
    const isConfirmed = confirmations >= 6;
    
    return { confirmations, isConfirmed };
  } catch (err) {
    return { confirmations: 0, isConfirmed: false };
  }
}

// Create transaction from UTXO
async function createTransactionFromUtxo(utxo, wallet, rpc, seenTxIds) {
  if (!utxo.outpoint || !utxo.outpoint.transactionId || seenTxIds.has(utxo.outpoint.transactionId)) {
    return null;
  }
  
  const txId = utxo.outpoint.transactionId;
  const incomingAmount = BigInt(utxo.amount || 0);
  const { confirmations, isConfirmed } = await calculateConfirmations(utxo.blockDaaScore, rpc);
  
  seenTxIds.add(txId);
  
  return {
    txId: txId,
    type: 'received',
    amount: Number(incomingAmount) / 1e8,
    incomingAmount: Number(incomingAmount) / 1e8,
    outgoingAmount: 0,
    fee: 0,
    confirmations: confirmations,
    isConfirmed: isConfirmed,
    blockHash: null,
    blockTime: Date.now(),
    timestamp: Date.now(),
    status: isConfirmed ? 'confirmed' : 'pending'
  };
}

// Determine transaction type and amounts
function determineTransactionType(ourInputs, ourOutputs, txOutputs, wallet) {
  const incomingAmount = ourOutputs.reduce((sum, out) => sum + BigInt(out.amount || 0), 0n);
  const outgoingAmount = ourInputs.reduce((sum, inp) => sum + BigInt(inp.amount || 0), 0n);
  const totalSent = txOutputs
    .filter(out => out.address !== wallet.address)
    .reduce((sum, out) => sum + BigInt(out.amount || 0), 0n);
  
  let type = 'unknown';
  let netAmount = 0;
  
  if (incomingAmount > 0n && outgoingAmount === 0n) {
    type = 'received';
    netAmount = Number(incomingAmount) / 1e8;
  } else if (outgoingAmount > 0n) {
    type = 'sent';
    netAmount = -Number(totalSent) / 1e8;
  }
  
  return { type, netAmount, incomingAmount, outgoingAmount };
}

// Get full transaction details
async function getFullTransactionDetails(txId, rpc) {
  if (typeof rpc.getTransaction !== 'function') {
    return null;
  }
  
  try {
    const txResult = await rpc.getTransaction({
      transactionId: txId,
      includeBlockInfo: true
    });
    
    if (!txResult || !txResult.transaction) {
      return null;
    }
    
    const tx = txResult.transaction;
    return {
      transaction: tx,
      inputs: tx.inputs || [],
      outputs: tx.outputs || [],
      fee: BigInt(tx.fee || 0),
      blockHash: tx.blockHash || null,
      blockDaaScore: tx.blockDaaScore || null
    };
  } catch (err) {
    return null;
  }
}

// Create transaction from full transaction data
async function createTransactionFromFullTx(txData, utxo, wallet, rpc, seenTxIds) {
  if (!txData || !txData.transaction) {
    return null;
  }
  
  const tx = txData.transaction;
  const txId = tx.transactionId || utxo.outpoint?.transactionId;
  
  if (!txId || seenTxIds.has(txId)) {
    return null;
  }
  
  const ourOutputs = txData.outputs.filter(out => out.address === wallet.address);
  const ourInputs = txData.inputs.filter(inp => inp.address === wallet.address);
  const { type, netAmount, incomingAmount, outgoingAmount } = determineTransactionType(
    ourInputs, ourOutputs, txData.outputs, wallet
  );
  
  if (type === 'unknown') {
    return null;
  }
  
  const { confirmations, isConfirmed } = await calculateConfirmations(txData.blockDaaScore, rpc);
  
  let blockTime = Date.now();
  if (txData.blockHash && typeof rpc.getBlock === 'function') {
    try {
      const blockResult = await rpc.getBlock({ hash: txData.blockHash, includeTransactions: false });
      if (blockResult && blockResult.block && blockResult.block.header) {
        const timestamp = blockResult.block.header.timestamp;
        blockTime = typeof timestamp === 'bigint' ? Number(timestamp) * 1000 : timestamp * 1000;
      }
    } catch (err) {
      // Use current time as fallback
    }
  }
  
  seenTxIds.add(txId);
  
  return {
    txId: txId,
    type: type,
    amount: netAmount,
    incomingAmount: Number(incomingAmount) / 1e8,
    outgoingAmount: Number(outgoingAmount) / 1e8,
    fee: Number(txData.fee) / 1e8,
    confirmations: confirmations,
    isConfirmed: isConfirmed,
    blockHash: txData.blockHash,
    blockTime: blockTime,
    timestamp: blockTime || Date.now(),
    status: isConfirmed ? 'confirmed' : 'pending'
  };
}

// Process mempool entries
async function processMempoolEntries(wallet, rpc, seenTxIds) {
  if (!rpc.getMempoolEntriesByAddresses || typeof rpc.getMempoolEntriesByAddresses !== 'function') {
    return [];
  }
  
  try {
    const mempoolResult = await rpc.getMempoolEntriesByAddresses({ addresses: [wallet.address] });
    const mempoolEntries = mempoolResult.entries || [];
    const transactions = [];
    
    for (const entry of mempoolEntries) {
      if (!entry.transactionId || seenTxIds.has(entry.transactionId)) {
        continue;
      }
      
      const txData = await getFullTransactionDetails(entry.transactionId, rpc);
      if (!txData) {
        continue;
      }
      
      const ourInputs = txData.inputs.filter(inp => inp.address === wallet.address);
      const ourOutputs = txData.outputs.filter(out => out.address === wallet.address);
      const incomingAmount = ourOutputs.reduce((sum, out) => sum + BigInt(out.amount || 0), 0n);
      const outgoingAmount = ourInputs.reduce((sum, inp) => sum + BigInt(inp.amount || 0), 0n);
      const totalSent = txData.outputs
        .filter(out => out.address !== wallet.address)
        .reduce((sum, out) => sum + BigInt(out.amount || 0), 0n);
      
      seenTxIds.add(entry.transactionId);
      
      if (outgoingAmount > 0n) {
        transactions.push({
          txId: entry.transactionId,
          type: 'sent',
          amount: -Number(totalSent) / 1e8,
          incomingAmount: Number(incomingAmount) / 1e8,
          outgoingAmount: Number(outgoingAmount) / 1e8,
          fee: Number(txData.fee) / 1e8,
          confirmations: 0,
          isConfirmed: false,
          blockHash: null,
          blockTime: Date.now(),
          timestamp: Date.now(),
          status: 'pending'
        });
      } else if (incomingAmount > 0n) {
        transactions.push({
          txId: entry.transactionId,
          type: 'received',
          amount: Number(incomingAmount) / 1e8,
          incomingAmount: Number(incomingAmount) / 1e8,
          outgoingAmount: 0,
          fee: Number(txData.fee) / 1e8,
          confirmations: 0,
          isConfirmed: false,
          blockHash: null,
          blockTime: Date.now(),
          timestamp: Date.now(),
          status: 'pending'
        });
      }
    }
    
    return transactions;
  } catch (err) {
    return [];
  }
}

// Update stored transaction confirmations
async function updateStoredTransactionConfirmations(wallet, utxos, rpc) {
  if (!wallet.transactionHistory || wallet.transactionHistory.length === 0) {
    return false;
  }
  
  try {
    const dagInfo = await rpc.getBlockDagInfo({});
    const currentDaaScore = typeof dagInfo.virtualDaaScore === 'bigint' 
      ? Number(dagInfo.virtualDaaScore) 
      : (dagInfo.virtualDaaScore || 0);
    
    let updated = false;
    
    for (const storedTx of wallet.transactionHistory) {
      if (storedTx.status !== 'pending' || !storedTx.txId) {
        continue;
      }
      
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
        const timeSinceSent = Date.now() - (storedTx.timestamp || Date.now());
        const TWO_MINUTES = 2 * 60 * 1000;
        
        if (timeSinceSent > TWO_MINUTES && storedTx.confirmations === 0) {
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
    
    return updated;
  } catch (err) {
    return false;
  }
}

module.exports = {
  loadStoredTransactions,
  createTransactionFromUtxo,
  createTransactionFromFullTx,
  processMempoolEntries,
  updateStoredTransactionConfirmations,
  getFullTransactionDetails,
};

