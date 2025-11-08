// Mining calculator service

const { formatHashrate, formatNumber } = require('../utils/formatting');

// Convert hashrate to hashes per second
function convertHashrateToHashes(value, unit) {
  const multipliers = {
    'H/s': 1,
    'KH/s': 1000,
    'MH/s': 1000000,
    'GH/s': 1000000000,
    'TH/s': 1000000000000,
  };
  
  const multiplier = multipliers[unit] || 1;
  return value * multiplier;
}

// Fetch network info from pool API
async function fetchNetworkInfo() {
  try {
    const networkResponse = await fetch('http://127.0.0.1:8080/network-info', { cache: 'no-store' });
    if (!networkResponse.ok) {
      throw new Error('Pool API not available. Make sure the pool is running.');
    }
    const networkInfo = await networkResponse.json();
    
    const difficultyStr = networkInfo.difficulty || '0';
    const networkDifficulty = parseFloat(difficultyStr);
    const daaScore = networkInfo.virtualDaaScore ? parseFloat(networkInfo.virtualDaaScore) : null;
    
    if (networkDifficulty <= 0 || !isFinite(networkDifficulty)) {
      throw new Error('Unable to get network difficulty. Node may not be synced.');
    }
    
    // For Kaspa: difficulty represents the target hashrate needed
    // Post-Crescendo: 10 blocks/second, so difficulty ≈ network hashrate in hashes/second
    const networkHashrate = networkDifficulty;
    
    return { networkDifficulty, networkHashrate, daaScore };
  } catch (apiError) {
    throw new Error(`Failed to fetch network data: ${apiError.message}. Ensure the pool and node are running.`);
  }
}

// Fetch block reward from pool API
async function getBlockReward() {
  try {
    const response = await fetch('http://127.0.0.1:8080/block-reward', { cache: 'no-store' });
    if (response.ok) {
      const data = await response.json();
      if (data.reward && data.reward > 0) {
        return data.reward;
      }
    }
    throw new Error('Block reward not available');
  } catch (err) {
    console.warn('[Calculator] Could not fetch block reward:', err);
    return null;
  }
}

// Calculate mining earnings
function calculateEarnings(userHashrateHashes, networkHashrate, blockReward, poolFeePercent) {
  // Kaspa post-Crescendo: 10 blocks per second (0.1 seconds per block)
  const blockTimeSeconds = 0.1;
  const blocksPerDay = 86400 / blockTimeSeconds; // 864,000 blocks per day at 10 BPS
  const poolFeeMultiplier = 1 - (poolFeePercent / 100);
  
  // Your share of the network
  const yourShareOfNetwork = userHashrateHashes / networkHashrate;
  
  // Blocks you expect to find per day
  const yourBlocksPerDay = blocksPerDay * yourShareOfNetwork;
  
  // Daily earnings (after pool fee)
  const dailyKAS = yourBlocksPerDay * blockReward * poolFeeMultiplier;
  
  // Calculate for different periods
  const earnings24h = dailyKAS;
  const earnings7d = dailyKAS * 7;
  const earnings30d = dailyKAS * 30;
  
  return {
    yourShareOfNetwork,
    yourBlocksPerDay,
    dailyKAS,
    earnings24h,
    earnings7d,
    earnings30d,
  };
}

// Update calculator display
function updateCalculatorDisplay(networkHashrate, networkDifficulty, share, blockReward, earnings) {
  const networkHashrateEl = document.getElementById('calculator-network-hashrate');
  const networkDiffEl = document.getElementById('calculator-network-difficulty');
  const shareEl = document.getElementById('calculator-your-share');
  const blockRewardEl = document.getElementById('calculator-block-reward');
  const earnings24hKasEl = document.getElementById('calculator-24h-kas');
  const earnings24hUsdEl = document.getElementById('calculator-24h-usd');
  const earnings7dKasEl = document.getElementById('calculator-7d-kas');
  const earnings7dUsdEl = document.getElementById('calculator-7d-usd');
  const earnings30dKasEl = document.getElementById('calculator-30d-kas');
  const earnings30dUsdEl = document.getElementById('calculator-30d-usd');
  
  if (networkHashrateEl) networkHashrateEl.textContent = formatHashrate(networkHashrate);
  if (networkDiffEl) networkDiffEl.textContent = formatNumber(networkDifficulty);
  if (shareEl) shareEl.textContent = `${(share * 100).toFixed(6)}%`;
  if (blockRewardEl) blockRewardEl.textContent = `${blockReward.toFixed(4)} KAS`;
  
  if (earnings24hKasEl) {
    earnings24hKasEl.textContent = earnings.earnings24h >= 0.01 ? earnings.earnings24h.toFixed(2) + ' KAS' : '<0.01 KAS';
  }
  if (earnings24hUsdEl) earnings24hUsdEl.textContent = 'Price data unavailable';
  
  if (earnings7dKasEl) {
    earnings7dKasEl.textContent = earnings.earnings7d >= 0.01 ? earnings.earnings7d.toFixed(2) + ' KAS' : '<0.01 KAS';
  }
  if (earnings7dUsdEl) earnings7dUsdEl.textContent = 'Price data unavailable';
  
  if (earnings30dKasEl) {
    earnings30dKasEl.textContent = earnings.earnings30d >= 0.01 ? earnings.earnings30d.toFixed(2) + ' KAS' : '<0.01 KAS';
  }
  if (earnings30dUsdEl) earnings30dUsdEl.textContent = 'Price data unavailable';
}

module.exports = {
  convertHashrateToHashes,
  fetchNetworkInfo,
  getBlockReward,
  calculateEarnings,
  updateCalculatorDisplay,
};

