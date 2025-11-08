// UTXO fetching and filtering utilities

const { getRpcClient } = require('../rpc-client');
const { MIN_CONFIRMATIONS } = require('../config');

let cachedDaaScore = 0;
let lastDaaScoreUpdate = 0;
const DAA_SCORE_CACHE_TTL = 5000; // 5 seconds

// Update current DAA score
async function updateDaaScore() {
  const now = Date.now();
  if (now - lastDaaScoreUpdate < DAA_SCORE_CACHE_TTL && cachedDaaScore > 0) {
    return cachedDaaScore;
  }
  
  try {
    const rpc = await getRpcClient();
    const dagInfo = await rpc.getBlockDagInfo({});
    cachedDaaScore = dagInfo.virtualDaaScore || 0;
    lastDaaScoreUpdate = now;
    return cachedDaaScore;
  } catch (err) {
    throw new Error(`Failed to get DAA score: ${err.message}`);
  }
}

// Get current DAA score (cached)
function getCurrentDaaScore() {
  return cachedDaaScore;
}

// Fetch UTXOs for an address
async function fetchUtxos(address) {
  const rpc = await getRpcClient();
  const result = await rpc.getUtxosByAddresses({ addresses: [address] });
  
  if (!result || !result.entries || result.entries.length === 0) {
    return { entries: [], total: 0n };
  }
  
  return { entries: result.entries, total: 0n };
}

// Filter confirmed UTXOs based on DAA score
function filterConfirmedUtxos(utxos, currentDaaScore, minConfirmations = null) {
  const requiredConfirmations = minConfirmations !== null ? minConfirmations : MIN_CONFIRMATIONS;
  return utxos.filter(utxo => {
    if (!utxo.blockDaaScore || utxo.blockDaaScore === 0n) {
      return false; // Unconfirmed UTXO
    }
    const utxoDaaScore = typeof utxo.blockDaaScore === 'bigint' 
      ? utxo.blockDaaScore 
      : BigInt(String(utxo.blockDaaScore || '0'));
    const confirmations = currentDaaScore - utxoDaaScore;
    return confirmations >= requiredConfirmations;
  });
}

// Get confirmed UTXOs for an address
async function getConfirmedUtxos(address) {
  await updateDaaScore();
  const { entries } = await fetchUtxos(address);
  const confirmed = filterConfirmedUtxos(entries, cachedDaaScore);
  
  const total = confirmed.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
  
  return { entries: confirmed, total };
}

// Check if address has sufficient balance
async function hasSufficientBalance(address, requiredAmount) {
  const { total } = await getConfirmedUtxos(address);
  return { sufficient: total >= BigInt(requiredAmount), balance: total };
}

// Get UTXO count for an address
async function getUtxoCount(address) {
  const { entries } = await getConfirmedUtxos(address);
  return entries.length;
}

module.exports = {
  updateDaaScore,
  getCurrentDaaScore,
  fetchUtxos,
  filterConfirmedUtxos,
  getConfirmedUtxos,
  hasSufficientBalance,
  getUtxoCount,
};

