// Final payout processing

const { getRpcClient } = require('./rpc-client');
const { setSession } = require('./session-manager');
const { kaspa } = require('./config');
const { getConfirmedUtxos } = require('./utils/utxo-helpers');
const { estimateFee, recalculateFee } = require('./services/fee-calculator');
const { createSignAndSubmit } = require('./services/transaction-builder');
const { createProportionalOutputs, adjustOutputsForFeeIncrease } = require('./services/proportional-outputs');

// Fetch and filter confirmed UTXOs from intermediate address
async function fetchConfirmedUtxosForPayout(intermediateAddress) {
  const { entries } = await getConfirmedUtxos(intermediateAddress);
  if (entries.length === 0) {
    throw new Error('No confirmed UTXOs found at intermediate address');
  }
  return entries;
}

// Estimate transaction fee for payout
async function estimatePayoutFee(utxos, outputs) {
  const tempOutputs = outputs.map(o => ({ address: o.address, amount: o.requestedAmount || o.amount }));
  return await estimateFee(utxos, tempOutputs);
}

// Create proportional output amounts (re-exported from service)

// Recalculate fee and adjust outputs if needed
async function recalculateFeeAndAdjustOutputs(rpc, utxos, outputsWithAmounts, currentFee, inputSum) {
  try {
    const recalculatedFee = await recalculateFee(utxos, outputsWithAmounts);
    let fee = recalculatedFee > currentFee ? recalculatedFee : currentFee;
    
    const newAvailableAfterFee = inputSum - fee;
    const availableAfterFee = inputSum - currentFee;

    // If fee increased, reduce outputs proportionally
    if (newAvailableAfterFee < availableAfterFee) {
      outputsWithAmounts = adjustOutputsForFeeIncrease(outputsWithAmounts, newAvailableAfterFee);
    } else if (newAvailableAfterFee > availableAfterFee) {
      // Fee decreased, we can redistribute, but let's be conservative and keep current outputs
      // Just verify they still fit
      const currentOutputSum = outputsWithAmounts.reduce((sum, o) => sum + o.amount, 0n);
      if (currentOutputSum > newAvailableAfterFee) {
        // Still need to reduce
        outputsWithAmounts = adjustOutputsForFeeIncrease(outputsWithAmounts, newAvailableAfterFee);
      }
    }

    // Verify inputs == outputs + fee
    const finalOutputSum = outputsWithAmounts.reduce((sum, o) => sum + o.amount, 0n);
    if (inputSum < finalOutputSum + fee) {
      throw new Error(`Math error: Inputs ${inputSum} < Outputs ${finalOutputSum} + Fee ${fee} (diff: ${inputSum - finalOutputSum - fee})`);
    }

    // Double-check: outputs should not exceed availableAfterFee
    if (finalOutputSum > newAvailableAfterFee) {
      throw new Error(`Math error: Outputs ${finalOutputSum} > AvailableAfterFee ${newAvailableAfterFee} (diff: ${finalOutputSum - newAvailableAfterFee})`);
    }

    return { fee, outputsWithAmounts };
  } catch (err) {
    if (err.message && err.message.includes('Math error')) {
      throw err;
    }
    console.log(`Warning: Could not recalculate fee: ${err.message}`);
    return { fee: currentFee, outputsWithAmounts };
  }
}

// Balance transaction to ensure inputs exactly equal outputs + fee
function balanceTransaction(inputSum, outputsWithAmounts, fee) {
  const finalOutputSum = outputsWithAmounts.reduce((sum, o) => sum + o.amount, 0n);
  const totalRequired = finalOutputSum + fee;

  if (inputSum !== totalRequired) {
    const diff = inputSum - totalRequired;
    if (diff !== 0n && outputsWithAmounts.length > 0) {
      outputsWithAmounts[outputsWithAmounts.length - 1].amount += diff;
      console.log(`  Adjusted last output by ${(Number(diff) / 1e8).toFixed(8)} KAS to balance transaction`);

      // Final verification
      const newOutputSum = outputsWithAmounts.reduce((sum, o) => sum + o.amount, 0n);
      const newTotal = newOutputSum + fee;
      if (inputSum !== newTotal) {
        throw new Error(`Cannot balance transaction: Inputs ${inputSum} != Outputs ${newOutputSum} + Fee ${fee} (diff: ${inputSum - newTotal})`);
      }
    }
  }
}

// Validate private key exists
function validatePrivateKey(privateKey) {
  if (!privateKey) {
    throw new Error('Intermediate private key not found');
  }
}

// Create, sign, and submit transaction
async function createAndSubmitTransaction(rpc, utxos, outputs, fee, privateKey) {
  validatePrivateKey(privateKey);
  const { txId } = await createSignAndSubmit(utxos, outputs, fee, [privateKey]);
  return txId;
}

// Save session state after successful transaction
async function saveSessionState(sessionId, session, txId, outputs) {
  session.payoutTxIds = [txId];
  session.status = 'confirmed';
  session.updatedAt = Date.now();

  try {
    await setSession(sessionId, session);
    console.log(`✓ Final payout sent! TX: ${txId}`);
    console.log(`✓ Session state saved`);
    console.log(`  Sent to ${outputs.length} destination(s):`);
    outputs.forEach((o, i) => {
      console.log(`    ${i + 1}. ${o.address} - ${Number(o.amount) / 1e8} KAS`);
    });
  } catch (saveErr) {
    console.error(`✗ Payout sent but failed to save session state: ${saveErr.message}`);
    console.error(`✗ Transaction ID: ${txId}`);
    console.error(`✗ WARNING: Session data may be out of sync!`);
  }
}

// Final payout
async function processFinalPayout(sessionId, session) {
  // Prevent duplicate payouts
  if (session.status === 'confirmed' || session.payoutTxIds) {
    console.log(`Session ${sessionId} already paid out, skipping`);
    return;
  }
  
  try {
    const rpc = await getRpcClient();
    
    // Validate we have destinations
    if (!session.destinations || session.destinations.length === 0) {
      throw new Error('No destinations specified for session');
    }
    
    if (!session.intermediateAddress) {
      throw new Error('Intermediate address not found');
    }
    
    // Fetch confirmed UTXOs
    const confirmedUtxos = await fetchConfirmedUtxosForPayout(session.intermediateAddress);
    const inputSum = confirmedUtxos.reduce((sum, u) => sum + BigInt(u.amount), 0n);
    console.log(`Available from intermediate UTXOs: ${(Number(inputSum) / 1e8).toFixed(8)} KAS`);
    
    // Create initial outputs with proportions
    const initialOutputs = session.destinations.map(d => ({
      address: d.address,
      requestedAmount: BigInt(d.amount)
    }));
    
    // Estimate initial fee
    let fee = await estimatePayoutFee(confirmedUtxos, initialOutputs);
    const availableAfterFee = inputSum - fee;
    
    if (availableAfterFee <= 0n) {
      throw new Error(`Insufficient funds: Available ${(Number(inputSum) / 1e8).toFixed(8)} KAS, Fee ${(Number(fee) / 1e8).toFixed(8)} KAS`);
    }
    
    // Create proportional outputs
    let outputsWithAmounts = createProportionalOutputs(session.destinations, availableAfterFee);
    
    // Recalculate fee and adjust outputs if needed
    const { fee: finalFee, outputsWithAmounts: adjustedOutputs } = await recalculateFeeAndAdjustOutputs(
      rpc, confirmedUtxos, outputsWithAmounts, fee, inputSum
    );
    fee = finalFee;
    outputsWithAmounts = adjustedOutputs;
    
    // Balance transaction
    balanceTransaction(inputSum, outputsWithAmounts, fee);
    
    // Log transaction details
    const finalOutputSum = outputsWithAmounts.reduce((sum, o) => sum + o.amount, 0n);
    const totalRequired = finalOutputSum + fee;
    console.log(`Preparing payout for ${outputsWithAmounts.length} destination(s)...`);
    console.log(`  Available: ${(Number(inputSum) / 1e8).toFixed(8)} KAS`);
    console.log(`  Outputs: ${(Number(finalOutputSum) / 1e8).toFixed(8)} KAS`);
    console.log(`  Fee: ${(Number(fee) / 1e8).toFixed(8)} KAS`);
    console.log(`  Total: ${(Number(totalRequired) / 1e8).toFixed(8)} KAS`);
    console.log(`Destinations: ${outputsWithAmounts.map(o => `${o.address}: ${Number(o.amount) / 1e8} KAS`).join(', ')}`);
    
    // Create, sign, and submit transaction
    console.log(`Creating transaction: ${outputsWithAmounts.length} outputs, fee: ${Number(fee) / 1e8} KAS`);
    const txId = await createAndSubmitTransaction(rpc, confirmedUtxos, outputsWithAmounts, fee, session.intermediatePrivateKey);
    
    // Save session state
    await saveSessionState(sessionId, session, txId, outputsWithAmounts);
  } catch (err) {
    session.status = 'error';
    session.error = '[E_PAYOUT] ' + (err.message || String(err));
    session.updatedAt = Date.now();
    await setSession(sessionId, session);
    console.error(`✗ Payout error for session ${sessionId}: ${session.error}`);
    console.error(`  Error details:`, err);
    console.error(`  Session state:`, {
      status: session.status,
      hasDestinations: !!session.destinations && session.destinations.length > 0,
      hasIntermediateUtxos: !!session.intermediateUtxos && session.intermediateUtxos.length > 0,
      hasIntermediatePrivateKey: !!session.intermediatePrivateKey
    });
  }
}

module.exports = {
  processFinalPayout,
};

