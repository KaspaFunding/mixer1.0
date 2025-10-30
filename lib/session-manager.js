// Session management and address generation

const crypto = require('crypto');
const { kaspa, KASPA_NETWORK } = require('./config');
const { getSession: dbGetSession, setSession: dbSetSession, getAllSessions: dbGetAllSessions } = require('./database');

// Generate deposit address
async function generateDepositAddress() {
  const keypair = kaspa.Keypair.random();
  const address = keypair.toAddress(KASPA_NETWORK).toString();
  const privateKey = keypair.privateKey;
  return { address, privateKey };
}

async function generateIntermediateAddress() {
  const keypair = kaspa.Keypair.random();
  const address = keypair.toAddress(KASPA_NETWORK).toString();
  const privateKey = keypair.privateKey;
  return { address, privateKey };
}

// Session CRUD operations
async function getSession(sessionId) {
  return await dbGetSession(sessionId);
}

async function setSession(sessionId, session) {
  await dbSetSession(sessionId, session);
}

async function getAllSessions() {
  return await dbGetAllSessions();
}

// Create a new mixing session
async function createSession(destinations, amount) {
  const MAX_DESTINATIONS = 10;
  const { kaspa, KASPA_NETWORK } = require('./config');
  
  // Validate destinations
  if (!Array.isArray(destinations) || destinations.length === 0) {
    throw new Error('At least one destination address is required');
  }
  
  if (destinations.length > MAX_DESTINATIONS) {
    throw new Error(`Maximum ${MAX_DESTINATIONS} destinations allowed per mix`);
  }
  
  // Validate each destination
  let totalAmount = 0n;
  for (const d of destinations) {
    if (!d.address || typeof d.address !== 'string') {
      throw new Error('Invalid destination address');
    }
    if (!kaspa.Address.validate(d.address)) {
      throw new Error(`Invalid Kaspa address: ${d.address}`);
    }
    const destAmount = BigInt(d.amount || 0);
    if (destAmount <= 0n) {
      throw new Error(`Invalid destination amount: ${d.amount}`);
    }
    totalAmount += destAmount;
  }
  
  // Validate total amount matches
  const expectedAmount = BigInt(amount);
  if (totalAmount !== expectedAmount) {
    throw new Error(`Sum of destination amounts (${totalAmount}) does not equal total amount (${expectedAmount})`);
  }
  
  const { address, privateKey } = await generateDepositAddress();
  const sessionId = crypto.randomBytes(16).toString('hex');
  
  const session = {
    id: sessionId,
    amount: Number(amount),
    destinations: destinations.map(d => ({
      address: d.address,
      amount: Number(d.amount)
    })),
    depositAddress: address,
    depositPrivateKey: privateKey,
    status: 'waiting_deposit',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  
  await setSession(sessionId, session);
  return session;
}

module.exports = {
  generateDepositAddress,
  generateIntermediateAddress,
  getSession,
  setSession,
  getAllSessions,
  createSession,
};

