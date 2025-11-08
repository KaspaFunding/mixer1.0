// Deposit monitoring service

const { getConfirmedUtxos } = require('../utils/utxo-helpers');
const { generateIntermediateAddress } = require('../session-manager');
const { setSession } = require('../session-manager');

// Check if deposit is confirmed
async function checkDepositConfirmed(depositAddress, requiredAmount) {
  const { entries, total } = await getConfirmedUtxos(depositAddress);
  
  if (entries.length === 0) {
    return { confirmed: false, hasUnconfirmed: false };
  }
  
  const hasUnconfirmed = entries.length > 0;
  const confirmed = total >= BigInt(requiredAmount);
  
  return { confirmed, hasUnconfirmed, total, entries };
}

// Handle deposit detection
async function handleDepositDetected(sessionId, session, totalAmount) {
  const { address, privateKey } = await generateIntermediateAddress();
  
  session.intermediateAddress = address;
  session.intermediatePrivateKey = privateKey;
  session.depositDetected = true;
  session.receivedAmount = totalAmount.toString();
  session.status = 'deposit_received';
  session.updatedAt = Date.now();
  
  await setSession(sessionId, session);
  
  return { address, privateKey };
}

// Save session with error handling
async function saveSessionSafely(sessionId, session, errorMessage) {
  try {
    await setSession(sessionId, session);
    return { success: true };
  } catch (saveErr) {
    console.error(`✗ Failed to save session state: ${saveErr.message}`);
    session.status = 'error';
    session.error = errorMessage;
    try {
      await setSession(sessionId, session);
    } catch (e) {
      console.error(`✗ Failed to save error state: ${e.message}`);
    }
    return { success: false, error: saveErr.message };
  }
}

module.exports = {
  checkDepositConfirmed,
  handleDepositDetected,
  saveSessionSafely,
};

