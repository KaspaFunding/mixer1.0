// Session recovery service

const { getConfirmedUtxos } = require('../utils/utxo-helpers');
const { generateIntermediateAddress, setSession } = require('../session-manager');
const { MIN_CONFIRMATIONS, MIN_INTERMEDIATE_DELAY_MS, MAX_INTERMEDIATE_DELAY_MS } = require('../config');
const { processFinalPayout } = require('../payout');

// Recover deposit address state
async function recoverDepositAddress(sessionId, session) {
  if (!session.depositAddress) {
    return { recovered: false };
  }
  
  const { entries: confirmedUtxos, total } = await getConfirmedUtxos(session.depositAddress);
  
  if (confirmedUtxos.length === 0) {
    console.log('⚠ No UTXOs at deposit address. Checking intermediate address...');
    return { recovered: false };
  }
  
  const totalAmount = total;
  if (totalAmount < BigInt(session.amount)) {
    console.log('⏳ Deposit detected but not yet confirmed (waiting for confirmations)');
    return { recovered: false };
  }
  
  if (!session.intermediateAddress) {
    console.log('✓ Deposit confirmed. Generating intermediate address...');
    const { address, privateKey } = await generateIntermediateAddress();
    session.intermediateAddress = address;
    session.intermediatePrivateKey = privateKey;
    session.depositUtxos = confirmedUtxos;
    session.receivedAmount = totalAmount.toString();
    session.status = 'deposit_received';
    session.updatedAt = Date.now();
    await setSession(sessionId, session);
    console.log(`✓ Recovered to: deposit_received`);
    return { recovered: true };
  }
  
  return { recovered: false };
}

// Recover intermediate address state
async function recoverIntermediateAddress(sessionId, session, intAddr) {
  const { entries: confirmedUtxos } = await getConfirmedUtxos(intAddr);
  
  if (confirmedUtxos.length === 0) {
    return { recovered: false };
  }
  
  console.log(`✓ Found ${confirmedUtxos.length} confirmed UTXO(s) at intermediate address`);
  
  // Update to intermediate_confirmed if needed
  if (!session.intermediateUtxos || session.status !== 'intermediate_confirmed') {
    session.intermediateUtxos = confirmedUtxos;
    session.intermediateConfirmed = true;
    const delay = Math.floor(Math.random() * (MAX_INTERMEDIATE_DELAY_MS - MIN_INTERMEDIATE_DELAY_MS + 1)) + MIN_INTERMEDIATE_DELAY_MS;
    session.intermediateDelayUntil = Date.now() + delay;
    session.status = 'intermediate_confirmed';
    session.updatedAt = Date.now();
    await setSession(sessionId, session);
    console.log(`✓ Recovered to: intermediate_confirmed (will payout after ${Math.floor(delay / 1000)}s)`);
    return { recovered: true };
  }
  
  // Check if delay passed but payout wasn't sent
  if (session.status === 'intermediate_confirmed') {
    if (session.intermediateDelayUntil && Date.now() >= session.intermediateDelayUntil) {
      if (!session.payoutTxIds) {
        console.log('✓ Intermediate confirmed and delay passed. Triggering payout...');
        try {
          await processFinalPayout(sessionId, session);
          return { recovered: true };
        } catch (err) {
          console.error(`✗ Payout error: ${err.message}`);
        }
      }
    } else {
      const remainingDelay = Math.max(0, session.intermediateDelayUntil - Date.now());
      console.log(`⏳ Waiting ${Math.floor(remainingDelay / 1000)}s before payout (delay timer)`);
    }
  }
  
  // Handle missing private key scenario
  if (confirmedUtxos.length > 0 && !session.intermediatePrivateKey) {
    return handleMissingPrivateKey(sessionId, session, intAddr, confirmedUtxos);
  }
  
  // Save intermediate address if missing
  if (confirmedUtxos.length > 0 && session.intermediatePrivateKey && !session.intermediateAddress && intAddr) {
    session.intermediateAddress = intAddr;
    await setSession(sessionId, session);
    console.log(`✓ Saved intermediate address: ${intAddr}`);
  }
  
  return { recovered: false };
}

// Handle missing private key error
function handleMissingPrivateKey(sessionId, session, intAddr, confirmedUtxos) {
  console.log('\n⚠⚠⚠ CRITICAL ISSUE FOUND ⚠⚠⚠');
  console.log(`⚠ Funds found at intermediate address: ${intAddr}`);
  const totalAmount = confirmedUtxos.reduce((sum, u) => sum + BigInt(u.amount), 0n);
  console.log(`⚠ Amount: ${(Number(totalAmount) / 1e8).toFixed(8)} KAS`);
  console.log('⚠ BUT: The intermediate private key is missing from session data!');
  console.log('⚠ This means the funds cannot be moved without the private key.');
  console.log('\n💡 Possible causes:');
  console.log('   - Mixer was closed before session state was fully saved');
  console.log('   - Session data was corrupted or deleted');
  console.log('   - The intermediate key was never stored');
  console.log('\n❌ Recovery is not possible without the intermediate private key.');
  console.log('   The funds are effectively stuck at that address.');
  
  session.status = 'error';
  session.error = '[E_RECOVERY] Funds found at intermediate address but private key missing - funds stuck';
  session.intermediateAddress = intAddr;
  setSession(sessionId, session);
  
  return { recovered: false, error: true };
}

// Get intermediate addresses to check
function getIntermediateAddresses(session) {
  if (session.intermediateAddress) {
    return [session.intermediateAddress];
  }
  
  console.log('⚠ No intermediate address in session data.');
  console.log('⚠ If funds are at an intermediate address, the private key may be lost.');
  console.log('⚠ Recovery is only possible if the intermediate address/private key pair is still in the session.');
  return [];
}

module.exports = {
  recoverDepositAddress,
  recoverIntermediateAddress,
  getIntermediateAddresses,
};

