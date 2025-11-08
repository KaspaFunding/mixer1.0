// Fee calculation service

const { kaspa } = require('../config');
const { getRpcClient } = require('../rpc-client');

const MIN_FEE = 10000n; // Minimum fee in sompi

// Estimate fee for a transaction
async function estimateFee(utxos, outputs, defaultFeeRate = 1) {
  try {
    const txPreview = kaspa.createTransaction(utxos, outputs, 0n);
    let feerate = defaultFeeRate;
    
    try {
      const rpc = await getRpcClient();
      const feeEstimateResp = await rpc.getFeeEstimate({});
      feerate = feeEstimateResp.estimate.priorityBucket.feerate;
    } catch (err) {
      // Use default if fee estimate fails
    }
    
    const fee = BigInt(feerate) * BigInt(txPreview.mass);
    return fee < MIN_FEE ? MIN_FEE : fee;
  } catch (err) {
    return MIN_FEE;
  }
}

// Recalculate fee with actual outputs
async function recalculateFee(utxos, outputs) {
  return await estimateFee(utxos, outputs);
}

// Calculate available amount after fee
function calculateAvailableAfterFee(totalAmount, fee) {
  return totalAmount - fee;
}

// Calculate change amount
function calculateChange(availableAfterFee, sendAmount) {
  return availableAfterFee - sendAmount;
}

// Check if change is above dust threshold
function isChangeAboveDust(change, dustThreshold = 1000n) {
  return change > dustThreshold;
}

module.exports = {
  estimateFee,
  recalculateFee,
  calculateAvailableAfterFee,
  calculateChange,
  isChangeAboveDust,
  MIN_FEE,
};

