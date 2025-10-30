// Final payout processing

const { getRpcClient } = require('./rpc-client');
const { setSession } = require('./session-manager');
const { kaspa } = require('./config');

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
    
    // CRITICAL: Refetch UTXOs directly from RPC instead of using stored ones
    // This ensures we have the correct structure with outpoint intact
    if (!session.intermediateAddress) {
      throw new Error('Intermediate address not found');
    }
    
    const utxoResult = await rpc.getUtxosByAddresses({ addresses: [session.intermediateAddress] });
    if (!utxoResult || !utxoResult.entries || utxoResult.entries.length === 0) {
      throw new Error('No UTXOs found at intermediate address');
    }
    
    const { MIN_CONFIRMATIONS } = require('./config');
    let currentDaaScore = 0;
    try {
      const dagInfo = await rpc.getBlockDagInfo({});
      currentDaaScore = dagInfo.virtualDaaScore || 0;
    } catch (err) {
      throw new Error(`Failed to get DAA score: ${err.message}`);
    }
    
    const confirmedUtxos = utxoResult.entries.filter(utxo => 
      utxo.blockDaaScore && (currentDaaScore - utxo.blockDaaScore >= MIN_CONFIRMATIONS)
    );
    
    if (confirmedUtxos.length === 0) {
      throw new Error('No confirmed UTXOs found at intermediate address');
    }
    
    // Use UTXOs directly from RPC - no serialization issues
    const restoredUtxos = confirmedUtxos;
    
    // Calculate total available from UTXOs (this is what we actually have)
    const inputSum = restoredUtxos.reduce((sum, u) => sum + BigInt(u.amount), 0n);
    
    console.log(`Available from intermediate UTXOs: ${(Number(inputSum) / 1e8).toFixed(8)} KAS`);
    
    // Create initial outputs based on destination proportions
    // But we'll adjust based on what we actually have available
    const totalRequested = session.destinations.reduce((sum, d) => sum + BigInt(d.amount), 0n);
    
    let outputs = session.destinations.map(d => {
      // Calculate proportional amount based on what we have available
      const proportion = Number(BigInt(d.amount)) / Number(totalRequested);
      return {
        address: d.address,
        proportion: proportion,
        requestedAmount: BigInt(d.amount)
      };
    });
    
    // Estimate fee first (we'll recalculate after adjusting outputs)
    let fee = 10000n;
    try {
      // Create a temporary transaction to estimate fee
      const tempOutputs = outputs.map(o => ({ address: o.address, amount: o.requestedAmount }));
      const txPreview = kaspa.createTransaction(restoredUtxos, tempOutputs, 0n);
      let feerate = 1;
      try {
        const feeEstimateResp = await rpc.getFeeEstimate({});
        feerate = feeEstimateResp.estimate.priorityBucket.feerate;
      } catch (err) {}
      fee = BigInt(feerate) * BigInt(txPreview.mass);
      if (fee < 10000n) fee = 10000n;
    } catch (err) {
      console.log(`Warning: Could not estimate fee, using default: ${fee}`);
    }
    
    // Calculate available amount after fee
    const availableAfterFee = inputSum - fee;
    
    if (availableAfterFee <= 0n) {
      throw new Error(`Insufficient funds: Available ${(Number(inputSum) / 1e8).toFixed(8)} KAS, Fee ${(Number(fee) / 1e8).toFixed(8)} KAS`);
    }
    
    // Distribute available amount proportionally to destinations
    // Use simpler integer division to avoid rounding errors
    let outputsWithAmounts = [];
    let remaining = availableAfterFee;
    
    for (let i = 0; i < outputs.length; i++) {
      const o = outputs[i];
      let amount;
      
      if (i === outputs.length - 1) {
        // Last destination gets all remaining (after fees and previous outputs)
        amount = remaining;
      } else {
        // Calculate proportional amount using integer math
        // proportion is 0-1, multiply by availableAfterFee and round down
        amount = (availableAfterFee * BigInt(Math.floor(o.proportion * 1000000000))) / 1000000000n;
        remaining -= amount;
      }
      
      // Ensure amount is at least 1000 sompi (dust threshold)
      if (amount < 1000n) {
        amount = 1000n;
      }
      
      outputsWithAmounts.push({
        address: o.address,
        amount: amount
      });
    }
    
    // Recalculate remaining after all outputs
    const totalOutputAmount = outputsWithAmounts.reduce((sum, o) => sum + o.amount, 0n);
    remaining = availableAfterFee - totalOutputAmount;
    
    // If there's a small remainder due to rounding, add it to the last output
    if (remaining > 0n && outputsWithAmounts.length > 0) {
      outputsWithAmounts[outputsWithAmounts.length - 1].amount += remaining;
    }
    
    // Recalculate fee with actual outputs
    try {
      const txPreview = kaspa.createTransaction(restoredUtxos, outputsWithAmounts, 0n);
      let feerate = 1;
      try {
        const feeEstimateResp = await rpc.getFeeEstimate({});
        feerate = feeEstimateResp.estimate.priorityBucket.feerate;
      } catch (err) {}
      const recalculatedFee = BigInt(feerate) * BigInt(txPreview.mass);
      if (recalculatedFee > fee) fee = recalculatedFee;
      if (fee < 10000n) fee = 10000n;
      
      // Recalculate available after final fee
      const newAvailableAfterFee = inputSum - fee;
      
      // If fee increased, we need to reduce outputs
      if (newAvailableAfterFee < availableAfterFee) {
        // Recalculate outputs with new available amount
        const totalOutputAmount = outputsWithAmounts.reduce((sum, o) => sum + o.amount, 0n);
        const reduction = totalOutputAmount - newAvailableAfterFee;
        
        // Reduce proportionally, ensuring last output gets remainder
        let newRemaining = newAvailableAfterFee;
        
        outputsWithAmounts = outputsWithAmounts.map((o, idx) => {
          if (idx === outputsWithAmounts.length - 1) {
            // Last output gets remainder
            return { address: o.address, amount: newRemaining >= 1000n ? newRemaining : 1000n };
          }
          
          // Calculate proportional reduction
          const proportion = Number(o.amount) / Number(totalOutputAmount);
          const newAmount = (newAvailableAfterFee * BigInt(Math.floor(proportion * 1000000000))) / 1000000000n;
          newRemaining -= newAmount;
          
          return { address: o.address, amount: newAmount >= 1000n ? newAmount : 1000n };
        });
        
        // Adjust for rounding errors - ensure we don't exceed available
        const finalTotal = outputsWithAmounts.reduce((sum, o) => sum + o.amount, 0n);
        if (finalTotal > newAvailableAfterFee && outputsWithAmounts.length > 0) {
          const excess = finalTotal - newAvailableAfterFee;
          outputsWithAmounts[outputsWithAmounts.length - 1].amount -= excess;
          if (outputsWithAmounts[outputsWithAmounts.length - 1].amount < 1000n) {
            outputsWithAmounts[outputsWithAmounts.length - 1].amount = 1000n;
          }
        } else if (finalTotal < newAvailableAfterFee && outputsWithAmounts.length > 0) {
          outputsWithAmounts[outputsWithAmounts.length - 1].amount += (newAvailableAfterFee - finalTotal);
        }
        
        availableAfterFee = newAvailableAfterFee;
      }
      
      // Final verification: ensure inputs == outputs + fee (exactly)
      const finalOutputSum = outputsWithAmounts.reduce((sum, o) => sum + o.amount, 0n);
      if (inputSum < finalOutputSum + fee) {
        throw new Error(`Math error: Inputs ${inputSum} < Outputs ${finalOutputSum} + Fee ${fee} (diff: ${inputSum - finalOutputSum - fee})`);
      }
    } catch (err) {
      if (err.message && err.message.includes('Math error')) {
        throw err;
      }
      console.log(`Warning: Could not recalculate fee: ${err.message}`);
    }
    
    // Final verification before creating transaction
    const finalOutputSum = outputsWithAmounts.reduce((sum, o) => sum + o.amount, 0n);
    const totalRequired = finalOutputSum + fee;
    
    console.log(`Preparing payout for ${outputsWithAmounts.length} destination(s)...`);
    console.log(`  Available: ${(Number(inputSum) / 1e8).toFixed(8)} KAS`);
    console.log(`  Outputs: ${(Number(finalOutputSum) / 1e8).toFixed(8)} KAS`);
    console.log(`  Fee: ${(Number(fee) / 1e8).toFixed(8)} KAS`);
    console.log(`  Total: ${(Number(totalRequired) / 1e8).toFixed(8)} KAS`);
    console.log(`Destinations: ${outputsWithAmounts.map(o => `${o.address}: ${Number(o.amount) / 1e8} KAS`).join(', ')}`);
    
    // Double-check math: inputs must exactly equal outputs + fee
    if (inputSum !== totalRequired) {
      // If there's a discrepancy, add/subtract to last output
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
    
    // Final outputs for transaction
    const finalOutputs = outputsWithAmounts;
    
    console.log(`Creating transaction: ${finalOutputs.length} outputs, fee: ${Number(fee) / 1e8} KAS`);
    const tx = kaspa.createTransaction(restoredUtxos, finalOutputs, fee);
    
    if (!session.intermediatePrivateKey) {
      throw new Error('Intermediate private key not found');
    }
    
    const signedTx = kaspa.signTransaction(tx, [session.intermediatePrivateKey], true);
    const result = await rpc.submitTransaction({ transaction: signedTx });
    
    // CRITICAL: Save session state immediately after transaction submission
    session.payoutTxIds = [result.transactionId];
    session.status = 'confirmed';
    session.updatedAt = Date.now();
    
    try {
      await setSession(sessionId, session);
          console.log(`✓ Final payout sent! TX: ${result.transactionId}`);
          console.log(`✓ Session state saved`);
          console.log(`  Sent to ${finalOutputs.length} destination(s):`);
          finalOutputs.forEach((o, i) => {
            console.log(`    ${i + 1}. ${o.address} - ${Number(o.amount) / 1e8} KAS`);
          });
    } catch (saveErr) {
      console.error(`✗ CRITICAL: Payout sent but failed to save session state: ${saveErr.message}`);
      console.error(`✗ Transaction ID: ${result.transactionId}`);
      console.error(`✗ WARNING: Session data may be out of sync!`);
      // Transaction was sent successfully, but we couldn't save - this is less critical
      // since funds already reached destination, but log it for awareness
    }
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

