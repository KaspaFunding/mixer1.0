// Transaction building service

const { kaspa } = require('../config');
const { getRpcClient } = require('../rpc-client');

// Create transaction outputs with change
function createOutputsWithChange(toAddress, sendAmount, changeAddress, changeAmount, dustThreshold = 1000n) {
  const outputs = [{ address: toAddress, amount: sendAmount }];
  
  if (changeAmount > dustThreshold) {
    outputs.push({ address: changeAddress, amount: changeAmount });
  } else if (changeAmount > 0n) {
    // Small change goes to recipient
    outputs[0].amount += changeAmount;
  }
  
  return outputs;
}

// Adjust outputs when fee increases
function adjustOutputsForFeeIncrease(outputs, newAvailable, sendAmount, changeAddress, dustThreshold = 1000n) {
  if (newAvailable < sendAmount) {
    // Can't send full amount - adjust to available
    outputs[0].amount = newAvailable > dustThreshold ? newAvailable : dustThreshold;
    if (outputs.length > 1) {
      outputs.pop(); // Remove change output
    }
  } else {
    outputs[0].amount = sendAmount;
    const newChange = newAvailable - sendAmount;
    
    if (newChange > dustThreshold && outputs.length === 1) {
      outputs.push({ address: changeAddress, amount: newChange });
    } else if (newChange > 0n && outputs.length === 1) {
      outputs[0].amount += newChange;
    }
  }
  
  return outputs;
}

// Balance transaction (ensure inputs = outputs + fee)
function balanceTransaction(inputSum, outputs, fee) {
  const outputSum = outputs.reduce((sum, o) => sum + o.amount, 0n);
  const diff = inputSum - outputSum - fee;
  
  if (diff !== 0n && outputs.length > 0) {
    outputs[0].amount += diff;
  }
  
  return outputs;
}

// Create and sign transaction
function createSignedTransaction(utxos, outputs, fee, privateKeys) {
  const tx = kaspa.createTransaction(utxos, outputs, fee);
  const signedTx = kaspa.signTransaction(tx, privateKeys, true);
  return signedTx;
}

// Submit transaction
async function submitTransaction(signedTx) {
  const rpc = await getRpcClient();
  const result = await rpc.submitTransaction({ transaction: signedTx });
  return result.transactionId;
}

// Create, sign, and submit transaction in one call
async function createSignAndSubmit(utxos, outputs, fee, privateKeys) {
  const signedTx = createSignedTransaction(utxos, outputs, fee, privateKeys);
  const txId = await submitTransaction(signedTx);
  return { txId, signedTx };
}

module.exports = {
  createOutputsWithChange,
  adjustOutputsForFeeIncrease,
  balanceTransaction,
  createSignedTransaction,
  submitTransaction,
  createSignAndSubmit,
};

