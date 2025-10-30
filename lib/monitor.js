// Monitoring loops for deposits and intermediate addresses

const { getRpcClient } = require('./rpc-client');
const { getAllSessions, setSession, generateIntermediateAddress } = require('./session-manager');
const { kaspa, MIN_CONFIRMATIONS } = require('./config');

let currentDaaScore = 0;

async function updateDaaScore() {
  try {
    const rpc = await getRpcClient();
    const dagInfo = await rpc.getBlockDagInfo({});
    currentDaaScore = dagInfo.virtualDaaScore || 0;
    return currentDaaScore;
  } catch (e) {
    console.error('Error fetching DAA score:', e);
    return 0;
  }
}

// Monitoring loop for deposits
function startMonitoring() {
  setInterval(async () => {
    const rpc = await getRpcClient();
    const allSessions = await getAllSessions();
    await updateDaaScore();
    
    for (const { sessionId, session } of allSessions) {
      if (session.status === 'waiting_deposit') {
        try {
          const result = await rpc.getUtxosByAddresses({ addresses: [session.depositAddress] });
          
          // Log if there are any UTXOs (even unconfirmed)
          if (result && result.entries && result.entries.length > 0) {
            const allUtxos = result.entries;
            const confirmedUtxos = allUtxos.filter(utxo => 
              utxo.blockDaaScore && (currentDaaScore - utxo.blockDaaScore >= MIN_CONFIRMATIONS)
            );
            
            if (confirmedUtxos.length > 0) {
              const total = confirmedUtxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
              if (total >= BigInt(session.amount)) {
                const { address, privateKey } = await generateIntermediateAddress();
                session.intermediateAddress = address;
                session.intermediatePrivateKey = privateKey;
                // Don't store UTXOs - we'll refetch them from RPC when needed
                // This avoids serialization issues with outpoint structure
                // Just mark that deposit was received
                session.depositDetected = true;
                session.receivedAmount = total.toString();
                session.status = 'deposit_received';
                session.updatedAt = Date.now();
                
                // CRITICAL: Save session BEFORE any transaction operations
                try {
                  await setSession(sessionId, session);
                  console.log(`✓ Deposit detected for session ${sessionId}: ${(Number(total) / 1e8).toFixed(8)} KAS`);
                  console.log(`✓ Session state saved (intermediate address: ${address})`);
                } catch (saveErr) {
                  console.error(`✗ CRITICAL: Failed to save session state: ${saveErr.message}`);
                  console.error(`✗ Cannot proceed - session state not saved. Fix error and retry.`);
                  session.status = 'error';
                  session.error = '[E_SAVE_FAILED] Failed to save session after deposit detection';
                  // Try to save error state
                  try {
                    await setSession(sessionId, session);
                  } catch (e) {
                    console.error(`✗ Failed to save error state: ${e.message}`);
                  }
                  continue; // Skip processing this session
                }
              } else {
                console.log(`⚠ Session ${sessionId}: Deposit amount ${(Number(total) / 1e8).toFixed(8)} KAS is less than required ${(Number(session.amount) / 1e8).toFixed(8)} KAS`);
              }
            } else if (allUtxos.length > 0) {
              // There are UTXOs but not yet confirmed
              const unconfirmedTotal = allUtxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
              console.log(`⏳ Session ${sessionId}: Deposit detected but waiting for confirmations (${allUtxos.length} UTXO(s), ${(Number(unconfirmedTotal) / 1e8).toFixed(8)} KAS)`);
            }
          }
        } catch (err) {
          console.error(`✗ Error checking deposit for ${sessionId}:`, err.message);
        }
      }
      
      // Send to intermediate address
      if (session.status === 'deposit_received' && session.intermediateAddress && session.depositDetected) {
        try {
          // Validate we have all required data
          if (!session.intermediatePrivateKey) {
            throw new Error('Intermediate private key missing');
          }
          if (!session.depositPrivateKey) {
            throw new Error('Deposit private key missing');
          }
          
          // CRITICAL: Refetch UTXOs directly from RPC instead of using stored ones
          // This ensures we have the correct structure with outpoint intact
          const utxoResult = await rpc.getUtxosByAddresses({ addresses: [session.depositAddress] });
          if (!utxoResult || !utxoResult.entries || utxoResult.entries.length === 0) {
            throw new Error('No UTXOs found at deposit address');
          }
          
          const confirmedUtxos = utxoResult.entries.filter(utxo => 
            utxo.blockDaaScore && (currentDaaScore - utxo.blockDaaScore >= MIN_CONFIRMATIONS)
          );
          
          if (confirmedUtxos.length === 0) {
            throw new Error('No confirmed UTXOs found');
          }
          
          const totalUtxoAmount = confirmedUtxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
          if (totalUtxoAmount < BigInt(session.amount)) {
            throw new Error(`Insufficient UTXO amount: ${totalUtxoAmount} < ${session.amount}`);
          }
          
          // Use UTXOs directly from RPC - no serialization issues
          const restoredUtxos = confirmedUtxos;
          
          let fee = 10000n;
          try {
            const txPreview = kaspa.createTransaction(
              restoredUtxos,
              [{ address: session.intermediateAddress, amount: BigInt(session.amount) }],
              0n
            );
            let feerate = 1;
            try {
              const feeEstimateResp = await rpc.getFeeEstimate({});
              feerate = feeEstimateResp.estimate.priorityBucket.feerate;
            } catch (err) {}
            fee = BigInt(feerate) * BigInt(txPreview.mass);
            if (fee < 10000n) fee = 10000n;
          } catch (err) {}
          
          const tx = kaspa.createTransaction(
            restoredUtxos,
            [{ address: session.intermediateAddress, amount: BigInt(session.amount) - fee }],
            fee
          );
          const signedTx = kaspa.signTransaction(tx, [session.depositPrivateKey], true);
          const result = await rpc.submitTransaction({ transaction: signedTx });
          
          // CRITICAL: Save session state BEFORE confirming transaction was successful
          session.intermediateTxId = result.transactionId;
          session.status = 'sent_to_intermediate';
          session.updatedAt = Date.now();
          
          try {
            await setSession(sessionId, session);
            console.log(`✓ Sent to intermediate address. TX: ${result.transactionId}`);
            console.log(`✓ Session state saved with intermediate transaction ID`);
          } catch (saveErr) {
            console.error(`✗ CRITICAL: Transaction sent but failed to save session state: ${saveErr.message}`);
            console.error(`✗ Transaction ID: ${result.transactionId}`);
            console.error(`✗ Intermediate address: ${session.intermediateAddress}`);
            console.error(`✗ WARNING: Session data may be out of sync!`);
            // Try to save error state
            session.error = '[E_SAVE_FAILED] Transaction sent but session save failed';
            try {
              await setSession(sessionId, session);
            } catch (e) {
              console.error(`✗ Failed to save error state: ${e.message}`);
            }
          }
        } catch (err) {
          session.status = 'error';
          session.error = '[E_INTERMEDIATE_SEND] ' + (err.message || String(err));
          session.updatedAt = Date.now();
          try {
            await setSession(sessionId, session);
            console.error(`✗ Error sending to intermediate: ${session.error}`);
          } catch (saveErr) {
            console.error(`✗ CRITICAL: Failed to save error state: ${saveErr.message}`);
          }
        }
      }
    }
  }, 10000); // Check every 10 seconds
}

// Intermediate monitoring - accepts processFinalPayout callback to avoid circular dependency
function startIntermediateMonitoring(processFinalPayoutCallback) {
  setInterval(async () => {
    const rpc = await getRpcClient();
    const allSessions = await getAllSessions();
    await updateDaaScore();
    
    for (const { sessionId, session } of allSessions) {
      if (session.status === 'sent_to_intermediate' && session.intermediateAddress && session.intermediateTxId) {
        try {
          const result = await rpc.getUtxosByAddresses({ addresses: [session.intermediateAddress] });
          if (result && result.entries && result.entries.length > 0) {
            const confirmedUtxos = result.entries.filter(utxo => 
              utxo.blockDaaScore && (currentDaaScore - utxo.blockDaaScore >= MIN_CONFIRMATIONS)
            );
            if (confirmedUtxos.length > 0) {
              // Don't store UTXOs - we'll refetch them from RPC when needed
              // This avoids serialization issues with outpoint structure
              session.intermediateConfirmed = true;
              const { MIN_INTERMEDIATE_DELAY_MS, MAX_INTERMEDIATE_DELAY_MS } = require('./config');
              const delay = Math.floor(Math.random() * (MAX_INTERMEDIATE_DELAY_MS - MIN_INTERMEDIATE_DELAY_MS + 1)) + MIN_INTERMEDIATE_DELAY_MS;
              session.intermediateDelayUntil = Date.now() + delay;
              session.status = 'intermediate_confirmed';
              session.updatedAt = Date.now();
              try {
                await setSession(sessionId, session);
                console.log(`✓ Intermediate confirmed. Will payout after ${delay / 1000}s`);
                console.log(`✓ Session state saved`);
              } catch (saveErr) {
                console.error(`✗ CRITICAL: Failed to save intermediate confirmation: ${saveErr.message}`);
                session.error = '[E_SAVE_FAILED] Failed to save intermediate confirmation';
                try {
                  await setSession(sessionId, session);
                } catch (e) {
                  console.error(`✗ Failed to save error state: ${e.message}`);
                }
              }
            }
          }
        } catch (err) {}
      }
      
      if (session.status === 'intermediate_confirmed' && session.intermediateDelayUntil && Date.now() >= session.intermediateDelayUntil) {
        // Prevent multiple payout attempts
        if (session.payoutTxIds && session.payoutTxIds.length > 0) {
          // Already paid out
          continue;
        }
        
        // Intermediate address must exist for payout
        if (!session.intermediateAddress) {
          console.error(`✗ Session ${sessionId}: Intermediate address missing, cannot process payout`);
          session.status = 'error';
          session.error = '[E_PAYOUT] Intermediate address not found';
          session.updatedAt = Date.now();
          await setSession(sessionId, session);
          continue;
        }
        
        // Ensure destinations exist
        if (!session.destinations || session.destinations.length === 0) {
          console.error(`✗ Session ${sessionId}: No destinations found, cannot process payout`);
          session.status = 'error';
          session.error = '[E_PAYOUT] No destinations specified';
          session.updatedAt = Date.now();
          await setSession(sessionId, session);
          continue;
        }
        
        // Process final payout
        console.log(`\n[${sessionId}] Processing final payout...`);
        console.log(`  Destinations: ${session.destinations.length}`);
        try {
          await processFinalPayoutCallback(sessionId, session);
        } catch (err) {
          console.error(`✗ Error calling payout callback for ${sessionId}:`, err.message);
        }
      }
    }
  }, 10000);
}

module.exports = {
  startMonitoring,
  startIntermediateMonitoring,
};

