// Session management and address generation

const crypto = require('crypto');
const { kaspa, KASPA_NETWORK } = require('./config');
const { getSession: dbGetSession, setSession: dbSetSession, getAllSessions: dbGetAllSessions } = require('./database');
const { validateDestinations, validateTotalAmount } = require('./utils/validation');

// Generate random keypair and address
function generateKeypairAndAddress() {
  const keypair = kaspa.Keypair.random();
  const address = keypair.toAddress(KASPA_NETWORK).toString();
  const privateKey = keypair.privateKey;
  return { address, privateKey };
}

// Generate deposit address
async function generateDepositAddress() {
  return generateKeypairAndAddress();
}

// Generate intermediate address
async function generateIntermediateAddress() {
  return generateKeypairAndAddress();
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

// Create session object
function createSessionObject(sessionId, depositAddress, depositPrivateKey, destinations, amount) {
  return {
    id: sessionId,
    amount: Number(amount),
    destinations: destinations.map(d => ({
      address: d.address,
      amount: Number(d.amount)
    })),
    depositAddress: depositAddress,
    depositPrivateKey: depositPrivateKey,
    status: 'waiting_deposit',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// Create a new mixing session
async function createSession(destinations, amount) {
  const MAX_DESTINATIONS = 10;
  
  // Validate destinations
  const destinationValidation = validateDestinations(destinations, MAX_DESTINATIONS);
  if (!destinationValidation.valid) {
    throw new Error(destinationValidation.error);
  }
  
  // Validate total amount matches
  const amountValidation = validateTotalAmount(destinationValidation.destinations, amount);
  if (!amountValidation.valid) {
    throw new Error(amountValidation.error);
  }
  
  // Generate deposit address and session ID
  const { address, privateKey } = await generateDepositAddress();
  const sessionId = crypto.randomBytes(16).toString('hex');
  
  // Create and save session
  const session = createSessionObject(sessionId, address, privateKey, destinations, amount);
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

