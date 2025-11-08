// Service for sending funds to intermediate address

const { kaspa } = require('../config');
const { getRpcClient } = require('../rpc-client');
const { getConfirmedUtxos } = require('../utils/utxo-helpers');
const { estimateFee } = require('./fee-calculator');
const { createSignAndSubmit } = require('./transaction-builder');
const { setSession } = require('../session-manager');

// Validate session data for intermediate send
function validateIntermediateSend(session) {
  if (!session.intermediatePrivateKey) {
    throw new Error('Intermediate private key missing');
  }
  if (!session.depositPrivateKey) {
    throw new Error('Deposit private key missing');
  }
  return true;
}

// Prepare transaction for intermediate send
async function prepareIntermediateTransaction(session) {
  const { entries: confirmedUtxos, total: totalUtxoAmount } = await getConfirmedUtxos(session.depositAddress);
  
  if (confirmedUtxos.length === 0) {
    throw new Error('No confirmed UTXOs found');
  }
  
  if (totalUtxoAmount < BigInt(session.amount)) {
    throw new Error(`Insufficient UTXO amount: ${totalUtxoAmount} < ${session.amount}`);
  }
  
  // Estimate fee
  const tempOutputs = [{ address: session.intermediateAddress, amount: BigInt(session.amount) }];
  let fee = await estimateFee(confirmedUtxos, tempOutputs);
  
  // Calculate amount after fee
  const sendAmount = BigInt(session.amount) - fee;
  const outputs = [{ address: session.intermediateAddress, amount: sendAmount }];
  
  return { utxos: confirmedUtxos, outputs, fee };
}

// Send to intermediate address
async function sendToIntermediate(sessionId, session) {
  validateIntermediateSend(session);
  
  const { utxos, outputs, fee } = await prepareIntermediateTransaction(session);
  
  // Create, sign, and submit
  const privateKey = session.depositPrivateKey;
  const { txId } = await createSignAndSubmit(utxos, outputs, fee, [privateKey]);
  
  // Update session
  session.intermediateTxId = txId;
  session.status = 'sent_to_intermediate';
  session.updatedAt = Date.now();
  
  return { txId };
}

module.exports = {
  validateIntermediateSend,
  prepareIntermediateTransaction,
  sendToIntermediate,
};

