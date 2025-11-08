// Monitoring loops for deposits and intermediate addresses

const { getAllSessions, setSession } = require('./session-manager');
const { updateDaaScore, getConfirmedUtxos } = require('./utils/utxo-helpers');
const { checkDepositConfirmed, handleDepositDetected, saveSessionSafely } = require('./services/deposit-monitor');
const { sendToIntermediate } = require('./services/intermediate-sender');
const { MIN_CONFIRMATIONS } = require('./config');

let currentDaaScore = 0;

// Update current DAA score (wrapper for compatibility)
async function updateDaaScoreLocal() {
  currentDaaScore = await updateDaaScore();
  return currentDaaScore;
}

// Process deposit detection
async function processDepositDetection(sessionId, session) {
  const depositCheck = await checkDepositConfirmed(session.depositAddress, session.amount);
  
  if (!depositCheck.hasUnconfirmed) {
    return;
  }
  
  if (depositCheck.confirmed) {
    const { address } = await handleDepositDetected(sessionId, session, depositCheck.total.toString());
    const saveResult = await saveSessionSafely(sessionId, session, '[E_SAVE_FAILED] Failed to save session after deposit detection');
    
    if (saveResult.success) {
      console.log(`✓ Deposit detected for session ${sessionId}: ${(Number(depositCheck.total) / 1e8).toFixed(8)} KAS`);
      console.log(`✓ Session state saved (intermediate address: ${address})`);
    } else {
      console.log(`⚠ Session ${sessionId}: Deposit amount ${(Number(depositCheck.total) / 1e8).toFixed(8)} KAS is less than required ${(Number(session.amount) / 1e8).toFixed(8)} KAS`);
    }
  } else {
    console.log(`⏳ Session ${sessionId}: Deposit detected but waiting for confirmations`);
  }
}

// Process intermediate send
async function processIntermediateSend(sessionId, session) {
  try {
    const { txId } = await sendToIntermediate(sessionId, session);
    const saveResult = await saveSessionSafely(sessionId, session, '[E_SAVE_FAILED] Transaction sent but session save failed');
    
    if (saveResult.success) {
      console.log(`✓ Sent to intermediate address. TX: ${txId}`);
      console.log(`✓ Session state saved with intermediate transaction ID`);
    } else {
      console.error(`✗ Transaction sent but failed to save session state`);
      console.error(`✗ Transaction ID: ${txId}`);
      console.error(`✗ Intermediate address: ${session.intermediateAddress}`);
      console.error(`✗ WARNING: Session data may be out of sync!`);
    }
  } catch (err) {
    session.status = 'error';
    session.error = '[E_INTERMEDIATE_SEND] ' + (err.message || String(err));
    session.updatedAt = Date.now();
    await saveSessionSafely(sessionId, session, '[E_INTERMEDIATE_SEND] Error sending to intermediate');
    console.error(`✗ Error sending to intermediate: ${session.error}`);
  }
}

// Monitoring loop for deposits
function startMonitoring() {
  setInterval(async () => {
    const allSessions = await getAllSessions();
    await updateDaaScoreLocal();
    
    for (const { sessionId, session } of allSessions) {
      if (session.status === 'waiting_deposit') {
        try {
          await processDepositDetection(sessionId, session);
        } catch (err) {
          console.error(`✗ Error checking deposit for ${sessionId}:`, err.message);
        }
      }
      
      if (session.status === 'deposit_received' && session.intermediateAddress && session.depositDetected) {
        await processIntermediateSend(sessionId, session);
      }
    }
  }, 10000); // Check every 10 seconds
}

// Intermediate monitoring - accepts processFinalPayout callback to avoid circular dependency
function startIntermediateMonitoring(processFinalPayoutCallback) {
  setInterval(async () => {
    const allSessions = await getAllSessions();
    await updateDaaScoreLocal();
    
    for (const { sessionId, session } of allSessions) {
      if (session.status === 'sent_to_intermediate' && session.intermediateAddress && session.intermediateTxId) {
        try {
          const { entries: confirmedUtxos } = await getConfirmedUtxos(session.intermediateAddress);
          if (confirmedUtxos.length > 0) {
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
              console.error(`✗ Failed to save intermediate confirmation: ${saveErr.message}`);
              session.error = '[E_SAVE_FAILED] Failed to save intermediate confirmation';
              try {
                await setSession(sessionId, session);
              } catch (e) {
                console.error(`✗ Failed to save error state: ${e.message}`);
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

