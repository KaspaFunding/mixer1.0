// Coinjoin service for standalone-mixer
// zero-trust coinjoin modes

const crypto = require('crypto');
const { kaspa, KASPA_NETWORK } = require('../config');
const { getSession, setSession, getAllSessions } = require('../session-manager');
const { getRpcClient } = require('../rpc-client');
const { validateAddress } = require('../utils/validation');

// Constants
const FIXED_ENTRY_AMOUNT = 100_000_000n; // 1 KAS in sompi
const ENTRY_TOLERANCE = 10_000n; // 0.0001 KAS in sompi
const KASJOIN_FEE_PERCENTAGE = 0.01; // 1% coinjoin fee
const MIN_ENTRY_AMOUNT = 100_000_000n; // 1 KAS minimum
const MAX_OUTPUTS_PER_TX = 20;
const MIN_ZERO_TRUST_PARTICIPANTS = 10;
const MIN_TRUSTED_PARTICIPANTS = 20;

// Coinjoin session prefix for database
const COINJOIN_SESSION_PREFIX = 'coinjoin_';

// Helper: Generate hash commitment for UTXO
function createUtxoCommitment(utxo, salt) {
  const utxoString = JSON.stringify({
    transactionId: utxo.outpoint?.transactionId || utxo.transactionId || utxo.txId,
    index: utxo.outpoint?.index !== undefined ? utxo.outpoint.index : (utxo.index || utxo.outputIndex),
    amount: utxo.amount?.toString() || utxo.amount
  });
  const commitment = crypto.createHash('sha256')
    .update(utxoString + salt)
    .digest('hex');
  return commitment;
}

// Helper: Verify UTXO commitment
function verifyUtxoCommitment(commitment, salt, utxo) {
  const calculatedCommitment = createUtxoCommitment(utxo, salt);
  return calculatedCommitment === commitment;
}

// Helper: Hash destination address (anonymize)
function hashDestination(address, salt) {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.createHash('sha256')
    .update(address + salt)
    .digest('hex');
  return { hash, salt };
}

// Helper: Verify destination hash
function verifyDestinationHash(destinationHash, salt, address) {
  const calculated = hashDestination(address, salt);
  return calculated.hash === destinationHash;
}

// Helper: Generate deposit address for trusted mode
function generateDepositAddress() {
  const keypair = kaspa.Keypair.random();
  const address = keypair.toAddress(KASPA_NETWORK).toString();
  const privateKey = keypair.privateKey;
  return { address, privateKey };
}

// Helper: Calculate optimal fee
async function calculateOptimalFee(utxos, outputs, rpc) {
  try {
    const txPreview = kaspa.createTransaction(utxos, outputs, 0n);
    let feerate = 1;
    
    try {
      const feeEstimateResp = await rpc.getFeeEstimate({});
      feerate = Math.max(feeEstimateResp.estimate.priorityBucket.feerate, 1);
    } catch (err) {
      console.warn('[Coinjoin] Error getting fee estimate:', err.message);
    }
    
    const fee = BigInt(Math.ceil(Number(feerate) * Number(txPreview.mass)));
    const minimumFee = 35000n;
    
    return fee > minimumFee ? fee : minimumFee;
  } catch (err) {
    console.error('[Coinjoin] Error calculating fee:', err);
    return 35000n;
  }
}

// Create coinjoin session
async function createCoinjoinSession(destinationAddress, options = {}) {
  const {
    zeroTrustMode = false,
    userUtxos = null,
    poolWalletAddress = null,
    poolPrivateKey = null,
    amount = null
  } = options;
  
  // Determine entry amount
  let entryAmount = FIXED_ENTRY_AMOUNT; // Default 1 KAS
  if (amount) {
    const amountBigInt = typeof amount === 'bigint' ? amount : BigInt(String(amount));
    if (amountBigInt >= MIN_ENTRY_AMOUNT) {
      entryAmount = amountBigInt;
    } else {
      throw new Error(`Amount must be at least ${Number(MIN_ENTRY_AMOUNT) / 1e8} KAS`);
    }
  }
  
  // Validate destination address
  if (!validateAddress(destinationAddress)) {
    throw new Error('Invalid destination address');
  }
  
  const sessionId = COINJOIN_SESSION_PREFIX + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
  
  if (zeroTrustMode && userUtxos) {
    // Zero-trust mode: user provides UTXOs directly
    if (!Array.isArray(userUtxos) || userUtxos.length === 0) {
      throw new Error('Zero-trust mode requires userUtxos array');
    }
    
    // Validate UTXOs
    for (const utxo of userUtxos) {
      const hasOutpoint = (utxo.outpoint && utxo.outpoint.transactionId) || 
                         (utxo.entry && utxo.entry.outpoint && utxo.entry.outpoint.transactionId) ||
                         utxo.transactionId || utxo.txId;
      if (!hasOutpoint || !utxo.amount) {
        throw new Error('Invalid UTXO format');
      }
    }
    
    // Create UTXO commitments
    const commitments = [];
    const salts = [];
    
    for (const utxo of userUtxos) {
      const salt = crypto.randomBytes(16).toString('hex');
      salts.push(salt);
      const commitment = createUtxoCommitment(utxo, salt);
      commitments.push({ commitment, salt });
    }
    
    // Hash destination address
    const destinationHash = hashDestination(destinationAddress);
    
    // Calculate total UTXO amount
    const totalUtxoAmount = userUtxos.reduce((sum, utxo) => {
      const amount = BigInt(String(utxo.amount || utxo.entry?.amount || '0'));
      return sum + amount;
    }, 0n);
    
    const session = {
      id: sessionId,
      type: 'coinjoin',
      zeroTrustMode: true,
      utxoCommitments: commitments,
      utxoSalts: salts,
      destinationHash: destinationHash.hash,
      destinationSalt: destinationHash.salt,
      // Store original UTXOs for easy reveal - user doesn't need to re-enter them
      originalUtxos: userUtxos.map(utxo => ({
        transactionId: utxo.outpoint?.transactionId || utxo.transactionId || utxo.txId || utxo.entry?.outpoint?.transactionId,
        index: utxo.outpoint?.index !== undefined ? utxo.outpoint.index : (utxo.index !== undefined ? utxo.index : (utxo.outputIndex !== undefined ? utxo.outputIndex : utxo.entry?.outpoint?.index)),
        amount: String(utxo.amount || utxo.entry?.amount || '0')
      })),
      originalDestination: destinationAddress, // Store for easy reveal
      // Store amount if provided (for reference/warning purposes)
      amount: amount ? String(entryAmount) : null,
      // Store actual UTXO total for validation
      utxoTotalAmount: String(totalUtxoAmount),
      status: 'committed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    await setSession(sessionId, session);
    return session;
  } else {
    // Trusted mode: generate deposit address
    if (!poolWalletAddress || !poolPrivateKey) {
      throw new Error('Trusted mode requires poolWalletAddress and poolPrivateKey');
    }
    
    const { address, privateKey } = generateDepositAddress();
    
    // In trusted mode, store destination for payout
    const destinationHash = hashDestination(destinationAddress);
    
    const session = {
      id: sessionId,
      type: 'coinjoin',
      depositAddress: address,
      depositPrivateKey: privateKey.toString(),
      destinationAddress: destinationAddress,
      destinationHash: destinationHash.hash,
      destinationSalt: destinationHash.salt,
      amount: entryAmount.toString(),
      poolWalletAddress: poolWalletAddress,
      zeroTrustMode: false,
      status: 'waiting_deposit',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    await setSession(sessionId, session);
    return session;
  }
}

// Get all coinjoin sessions
async function getAllCoinjoinSessions() {
  const allSessions = await getAllSessions();
  return allSessions.filter(({ sessionId, session }) => {
    // Check if session is a coinjoin session
    return session && (session.type === 'coinjoin' || sessionId.startsWith(COINJOIN_SESSION_PREFIX));
  });
}

// Get coinjoin sessions by status
async function getCoinjoinSessionsByStatus(status) {
  const allSessions = await getAllCoinjoinSessions();
  return allSessions.filter(({ session }) => session.status === status);
}

// Reveal UTXOs for zero-trust coinjoin
async function revealUtxosForCoinjoin(sessionId, revealedUtxos, destinationAddress, sourceAddress = null) {
  const session = await getSession(sessionId);
  
  if (!session) {
    throw new Error('Session not found');
  }
  
  if (!session.zeroTrustMode) {
    throw new Error('Session is not in zero-trust mode');
  }
  
  if (session.status === 'revealed') {
    const existingUtxos = session.revealedUtxos || [];

    const sameLength = existingUtxos.length === revealedUtxos.length;
    const sameDestination = session.destinationAddress === destinationAddress;
    const utxosMatch = sameLength && existingUtxos.every((existing, idx) => {
      const provided = revealedUtxos[idx];
      if (!provided) return false;
      return (
        String(existing.transactionId ?? existing.txId ?? existing.outpoint?.transactionId ?? '') ===
          String(provided.transactionId ?? provided.txId ?? provided.outpoint?.transactionId ?? '') &&
        Number(existing.index ?? existing.outpoint?.index ?? existing.entry?.outpoint?.index ?? -1) ===
          Number(provided.index ?? provided.outpoint?.index ?? provided.entry?.outpoint?.index ?? -1) &&
        String(existing.amount ?? existing.entry?.amount ?? '') ===
          String(provided.amount ?? provided.entry?.amount ?? '')
      );
    });

    if (sameDestination && utxosMatch) {
      return {
        success: true,
        sessionId,
        message: 'UTXOs already revealed. Waiting for other participants.'
      };
    }

    throw new Error('Session already revealed with different UTXO data');
  }

  if (session.status !== 'waiting_reveal' && session.status !== 'committed') {
    throw new Error(`Session status is ${session.status}, cannot reveal UTXOs`);
  }
  
  // Verify destination hash
  const destinationValid = verifyDestinationHash(
    session.destinationHash,
    session.destinationSalt,
    destinationAddress
  );
  
  if (!destinationValid) {
    throw new Error('Destination address does not match commitment');
  }
  
  // Verify UTXO commitments
  if (revealedUtxos.length !== session.utxoCommitments.length) {
    throw new Error('Number of revealed UTXOs does not match commitments');
  }
  
  for (let i = 0; i < revealedUtxos.length; i++) {
    const utxo = revealedUtxos[i];
    const commitment = session.utxoCommitments[i];
    const salt = session.utxoSalts[i];
    
    const isValid = verifyUtxoCommitment(commitment.commitment, salt, utxo);
    if (!isValid) {
      throw new Error(`UTXO commitment ${i} verification failed`);
    }
  }
  
  // Calculate total amount for this participant
  const participantTotal = revealedUtxos.reduce((sum, utxo) => {
    const amount = BigInt(String(utxo.amount || '0'));
    return sum + amount;
  }, 0n);
  
  // Check if amount matches other revealed participants (EXACT match required)
  // Only check sessions that are revealed but not yet completed (still in the same batch)
  // Exclude completed sessions and sessions that don't match the current batch
  // Use a time window to only check recent sessions (within last 5 minutes) to avoid old test sessions
  const allCoinjoinSessions = await getAllCoinjoinSessions();
  const currentTime = Date.now();
  const timeWindow = 5 * 60 * 1000; // 5 minutes
  
  const revealedSessions = allCoinjoinSessions.filter(({ session: s }) => {
    // Must be zero-trust mode, revealed status, not completed, and different session
    if (!s.zeroTrustMode || s.status !== 'revealed' || s.sessionId === sessionId) {
      return false;
    }
    // Exclude completed sessions
    if (s.status === 'completed' || s.completedAt || s.coinjoinTxId) {
      return false;
    }
    // Must have revealed UTXOs
    if (!s.revealedUtxos || s.revealedUtxos.length === 0) {
      return false;
    }
    // Only check sessions revealed within the time window (same test run)
    if (s.revealedAt && (currentTime - s.revealedAt) > timeWindow) {
      return false;
    }
    return true;
  });
  
  if (revealedSessions.length > 0) {
    // Get amounts from other revealed participants
    const otherAmounts = revealedSessions.map(({ session: s }) => {
      if (!s.revealedUtxos || s.revealedUtxos.length === 0) return null;
      return s.revealedUtxos.reduce((sum, utxo) => {
        const amount = BigInt(String(utxo.amount || '0'));
        return sum + amount;
      }, 0n);
    }).filter(amt => amt !== null);
    
    if (otherAmounts.length > 0) {
      // Find the most common amount (or first one if all should match)
      const referenceAmount = otherAmounts[0];
      
      console.log(`[Coinjoin] Amount validation: participantTotal=${(Number(participantTotal) / 1e8).toFixed(8)} KAS, referenceAmount=${(Number(referenceAmount) / 1e8).toFixed(8)} KAS, revealedSessions=${revealedSessions.length}`);
      
      // CRITICAL: For fairness and security, inputs must be EXACTLY equal
      // No tolerance allowed - prevents gaming where participants contribute less/more
      if (participantTotal !== referenceAmount) {
        const referenceKAS = (Number(referenceAmount) / 1e8).toFixed(8);
        const participantKAS = (Number(participantTotal) / 1e8).toFixed(8);
        const diff = participantTotal > referenceAmount 
          ? (Number(participantTotal - referenceAmount) / 1e8).toFixed(8)
          : (Number(referenceAmount - participantTotal) / 1e8).toFixed(8);
        throw new Error(
          `UTXO amount mismatch. Other participants have exactly ${referenceKAS} KAS, but you have ${participantKAS} KAS (difference: ${diff} KAS). ` +
          `All participants must contribute the EXACT same amount for fairness and security. No tolerance allowed.`
        );
      }
    }
  }
  
  // Store revealed UTXOs
  session.revealedUtxos = revealedUtxos;
  session.destinationAddress = destinationAddress;
  session.status = 'revealed';
  session.revealedAt = Date.now();
  session.updatedAt = Date.now();
  
  // Store source address for UTXOs (where the UTXOs actually exist)
  // This helps when building the transaction to know which addresses to query
  if (sourceAddress) {
    session.utxoSourceAddress = sourceAddress;
  }
  if (!session.utxoSourceAddresses) {
    session.utxoSourceAddresses = [];
  }
  if (sourceAddress && !session.utxoSourceAddresses.includes(sourceAddress)) {
    session.utxoSourceAddresses.push(sourceAddress);
  }
  
  await setSession(sessionId, session);
  
  return {
    success: true,
    sessionId,
    message: 'UTXOs revealed successfully. Waiting for other participants.'
  };
}

// Build zero-trust coinjoin transaction
async function buildZeroTrustCoinjoinTransaction(sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length < MIN_ZERO_TRUST_PARTICIPANTS) {
    throw new Error(`Need at least ${MIN_ZERO_TRUST_PARTICIPANTS} sessions for zero-trust coinjoin`);
  }
  
  // Get all sessions
  const sessions = [];
  for (const sessionId of sessionIds) {
    const session = await getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (!session.zeroTrustMode) {
      throw new Error(`Session ${sessionId} is not in zero-trust mode`);
    }
    if (session.status !== 'revealed') {
      throw new Error(`Session ${sessionId} has not revealed UTXOs (status: ${session.status})`);
    }
    sessions.push({ sessionId, session });
  }
  
  // Collect all UTXOs and destinations
  // Use a Map to deduplicate inputs by outpoint (transactionId:index)
  // This prevents duplicate inputs when multiple sessions reference the same UTXO
  const uniqueInputsMap = new Map(); // key: "txId:index", value: formattedUtxo
  const allDestinations = [];
  const rpc = await getRpcClient();
  
  // Track which sessions reference which UTXOs (for inputOwners mapping)
  const utxoSessionMap = new Map(); // key: "txId:index", value: Array of {sessionId, session}
  
  for (const { sessionId, session } of sessions) {
    if (!session.revealedUtxos || session.revealedUtxos.length === 0) {
      throw new Error(`Session ${session.sessionId} has no revealed UTXOs`);
    }
    
    // Validate UTXO total against specified amount (if provided)
    // Note: In zero-trust mode, the specified amount is informational only - all UTXOs are used
    const revealedTotal = session.revealedUtxos.reduce((sum, utxo) => {
      const amount = BigInt(String(utxo.amount || '0'));
      return sum + amount;
    }, 0n);
    
    if (session.amount) {
      const specifiedAmount = BigInt(String(session.amount));
      const tolerance = BigInt('10000000'); // 0.1 KAS tolerance
      
      // Calculate difference
      const difference = revealedTotal > specifiedAmount 
        ? revealedTotal - specifiedAmount 
        : specifiedAmount - revealedTotal;
      
      if (difference > tolerance) {
        const specifiedKAS = (Number(specifiedAmount) / 1e8).toFixed(8);
        const actualKAS = (Number(revealedTotal) / 1e8).toFixed(8);
        const diffKAS = (Number(difference) / 1e8).toFixed(8);
        console.warn(`[Coinjoin] Session ${session.id}: Specified amount ${specifiedKAS} KAS, but UTXOs total ${actualKAS} KAS (difference: ${diffKAS} KAS). In zero-trust mode, all provided UTXOs will be used regardless of the specified amount.`);
      }
    }
    
    // Collect ALL unique addresses from ALL sessions first
    // This ensures we query all possible addresses where UTXOs might be
    const allAddresses = new Set();
    for (const { session: s } of sessions) {
      if (s.destinationAddress) {
        allAddresses.add(s.destinationAddress);
      }
      if (s.originalDestination && s.originalDestination !== s.destinationAddress) {
        allAddresses.add(s.originalDestination);
      }
      // IMPORTANT: Add source address where UTXOs actually exist
      if (s.utxoSourceAddress) {
        allAddresses.add(s.utxoSourceAddress);
      }
      // Also check if we have stored source addresses for UTXOs (legacy/backup)
      if (s.utxoSourceAddresses && Array.isArray(s.utxoSourceAddresses)) {
        s.utxoSourceAddresses.forEach(addr => {
          if (addr) allAddresses.add(addr);
        });
      }
    }
    
    // Also add all addresses from the wallet if available (in case UTXOs were created there)
    try {
      const { readWallet } = require('../wallet');
      const wallet = readWallet();
      if (wallet && wallet.address) {
        allAddresses.add(wallet.address);
      }
    } catch (err) {
      // Wallet not imported, that's okay
    }
    
    // Also add wallet address if available
    try {
      const { readWallet } = require('../wallet');
      const wallet = readWallet();
      if (wallet && wallet.address) {
        allAddresses.add(wallet.address);
      }
    } catch (err) {
      // Wallet not imported, that's okay
    }
    
    // IMPORTANT: Also query UTXOs from revealed transactions to find which addresses they're at
    // When UTXOs are revealed, we have transactionId and index, but we need to find which address owns them
    // We'll query all addresses we know about, and if a UTXO isn't found, we'll try to get it from the transaction
    // For now, we query all known addresses - if UTXO is still not found, we'll try querying the transaction
    
    // Fetch UTXOs from ALL addresses at once for efficiency
    const allAddressesArray = Array.from(allAddresses);
    console.log(`[Coinjoin] Querying ${allAddressesArray.length} address(es) for UTXOs:`, allAddressesArray);
    
    let allUtxosFromRpc = [];
    if (allAddressesArray.length > 0) {
      try {
        const utxoResult = await rpc.getUtxosByAddresses({ addresses: allAddressesArray });
        if (utxoResult && utxoResult.entries) {
          allUtxosFromRpc = utxoResult.entries;
          console.log(`[Coinjoin] Found ${allUtxosFromRpc.length} UTXO(s) across all addresses`);
        }
      } catch (err) {
        console.error(`[Coinjoin] Error fetching UTXOs from all addresses:`, err);
        // Continue - we'll try per-UTXO lookup below
      }
    }
    
    // Create a map of UTXOs by transactionId:index for quick lookup
    const utxoMap = new Map();
    for (const utxo of allUtxosFromRpc) {
      const txId = utxo.outpoint?.transactionId || utxo.transactionId || '';
      const index = utxo.outpoint?.index !== undefined ? utxo.outpoint.index : (utxo.index !== undefined ? utxo.index : 0);
      const key = `${txId}:${index}`;
      if (!utxoMap.has(key)) {
        utxoMap.set(key, utxo);
      }
    }
    
    // Fetch full UTXO details from RPC for each revealed UTXO
    // This ensures we have scriptPublicKey, blockDaaScore, and isCoinbase
    for (const utxo of session.revealedUtxos) {
      try {
        const txId = utxo.transactionId || utxo.txId || '';
        const index = typeof utxo.index === 'number' ? utxo.index : (utxo.outputIndex !== undefined ? utxo.outputIndex : 0);
        const utxoKey = `${txId}:${index}`;
        
        // Track that this session references this UTXO
        if (!utxoSessionMap.has(utxoKey)) {
          utxoSessionMap.set(utxoKey, []);
        }
        utxoSessionMap.get(utxoKey).push({ sessionId, session });
        
        // Only fetch and format UTXO if we haven't seen it before
        if (uniqueInputsMap.has(utxoKey)) {
          continue; // Already processed this UTXO
        }
        
        // First, try to find UTXO in our pre-fetched map
        let foundUtxo = utxoMap.get(utxoKey);
        
        // If not found in pre-fetched map, try re-querying all addresses (UTXO might have been just created/confirmed)
        if (!foundUtxo && allAddressesArray.length > 0) {
          try {
            const utxoResult = await rpc.getUtxosByAddresses({ addresses: allAddressesArray });
            if (utxoResult && utxoResult.entries) {
              foundUtxo = utxoResult.entries.find(entry => {
                const entryTxId = entry.outpoint?.transactionId || entry.transactionId || '';
                const entryIndex = entry.outpoint?.index !== undefined ? entry.outpoint.index : (entry.index !== undefined ? entry.index : 0);
                return entryTxId === txId && entryIndex === index;
              });
              
              // If found, add to map
              if (foundUtxo) {
                utxoMap.set(utxoKey, foundUtxo);
              }
            }
          } catch (err) {
            console.warn(`[Coinjoin] Error re-querying addresses for UTXO ${txId}:${index}:`, err.message);
          }
        }
        
        // If still not found, try to get the transaction and find the output address
        if (!foundUtxo && txId) {
          try {
            // Try to get transaction details to find which address the output belongs to
            console.log(`[Coinjoin] UTXO ${txId}:${index} not found in address queries, attempting to get transaction details...`);
            if (rpc.getTransaction) {
              const txResult = await rpc.getTransaction({ transactionId: txId, includeTransactionData: true });
              if (txResult && txResult.transaction && txResult.transaction.outputs) {
                console.log(`[Coinjoin] Transaction ${txId} has ${txResult.transaction.outputs.length} output(s)`);
                const output = txResult.transaction.outputs[index];
                if (output && output.scriptPublicKey) {
                  console.log(`[Coinjoin] Output ${index} has scriptPublicKey:`, JSON.stringify(output.scriptPublicKey, null, 2));
                  // Try to derive address from scriptPublicKey
                  try {
                    // Handle different scriptPublicKey formats
                    let scriptBytes;
                    if (typeof output.scriptPublicKey.script === 'string') {
                      // Hex string
                      scriptBytes = Buffer.from(output.scriptPublicKey.script, 'hex');
                    } else if (Buffer.isBuffer(output.scriptPublicKey.script)) {
                      scriptBytes = output.scriptPublicKey.script;
                    } else if (output.scriptPublicKey.scriptHex) {
                      scriptBytes = Buffer.from(output.scriptPublicKey.scriptHex, 'hex');
                    } else if (Array.isArray(output.scriptPublicKey.script)) {
                      scriptBytes = Buffer.from(output.scriptPublicKey.script);
                    } else {
                      throw new Error(`Unknown scriptPublicKey.script format: ${typeof output.scriptPublicKey.script}`);
                    }
                    
                    const scriptPubKey = kaspa.ScriptPublicKey.fromBytes(scriptBytes);
                    const outputAddress = scriptPubKey.toAddress(KASPA_NETWORK).toString();
                    console.log(`[Coinjoin] Derived address from scriptPublicKey: ${outputAddress}`);
                    
                    // Query this address for the UTXO
                    const utxoResult = await rpc.getUtxosByAddresses({ addresses: [outputAddress] });
                    console.log(`[Coinjoin] Found ${utxoResult?.entries?.length || 0} UTXO(s) at derived address ${outputAddress}`);
                    if (utxoResult && utxoResult.entries) {
                      foundUtxo = utxoResult.entries.find(entry => {
                        const entryTxId = entry.outpoint?.transactionId || entry.transactionId || '';
                        const entryIndex = entry.outpoint?.index !== undefined ? entry.outpoint.index : (entry.index !== undefined ? entry.index : 0);
                        return entryTxId === txId && entryIndex === index;
                      });
                      
                      // If found, add to map and address list
                      if (foundUtxo) {
                        console.log(`[Coinjoin] ✅ Found UTXO ${txId}:${index} at address ${outputAddress}`);
                        utxoMap.set(utxoKey, foundUtxo);
                        allAddresses.add(outputAddress);
                      } else {
                        console.warn(`[Coinjoin] ⚠️  UTXO ${txId}:${index} not found at derived address ${outputAddress}`);
                      }
                    }
                  } catch (err) {
                    // Could not derive address from scriptPublicKey
                    console.error(`[Coinjoin] ❌ Could not derive address from scriptPublicKey for UTXO ${txId}:${index}:`, err.message);
                    console.error(`[Coinjoin] scriptPublicKey structure:`, JSON.stringify(output.scriptPublicKey, null, 2));
                  }
                } else {
                  console.warn(`[Coinjoin] Output ${index} missing scriptPublicKey`);
                }
              } else {
                console.warn(`[Coinjoin] Transaction ${txId} not found or missing outputs`);
              }
            } else {
              console.warn(`[Coinjoin] rpc.getTransaction is not available`);
            }
          } catch (err) {
            // getTransaction might not be available or transaction might not be found
            console.error(`[Coinjoin] ❌ Error getting transaction ${txId} to find output address:`, err.message);
          }
        }
        
        // If still not found, try querying specific addresses for this session
        let addressesToCheck = [];
        if (!foundUtxo) {
          addressesToCheck = [session.destinationAddress];
          if (session.originalDestination && session.originalDestination !== session.destinationAddress) {
            addressesToCheck.push(session.originalDestination);
          }
          
          // Also try wallet address if available
          try {
            const { readWallet } = require('../wallet');
            const wallet = readWallet();
            if (wallet && wallet.address && !addressesToCheck.includes(wallet.address)) {
              addressesToCheck.push(wallet.address);
            }
          } catch (err) {
            // Wallet not imported, that's okay
          }
          
          // Remove addresses we've already checked
          addressesToCheck = addressesToCheck.filter(addr => !allAddressesArray.includes(addr));
          
          if (addressesToCheck.length > 0) {
            const utxoResult = await rpc.getUtxosByAddresses({ addresses: addressesToCheck });
            
            // Find matching UTXO in RPC response
            if (utxoResult && utxoResult.entries) {
              foundUtxo = utxoResult.entries.find(entry => {
                const entryTxId = entry.outpoint?.transactionId || entry.transactionId || '';
                const entryIndex = entry.outpoint?.index !== undefined ? entry.outpoint.index : (entry.index !== undefined ? entry.index : 0);
                return entryTxId === txId && entryIndex === index;
              });
            }
          }
        }
        
        let formattedUtxo;
        if (foundUtxo) {
          // Extract scriptPublicKey properly (handle WASM object serialization)
          let scriptPublicKey = foundUtxo.scriptPublicKey;
          if (scriptPublicKey && typeof scriptPublicKey.toJSON === 'function') {
            scriptPublicKey = scriptPublicKey.toJSON();
          }
          
          // Ensure scriptPublicKey is properly formatted
          if (!scriptPublicKey || !scriptPublicKey.script) {
            // Try to get script from scriptHex if available
            if (foundUtxo.scriptPublicKey && foundUtxo.scriptPublicKey.scriptHex) {
              scriptPublicKey = {
                version: foundUtxo.scriptPublicKey.version || 0,
                script: foundUtxo.scriptPublicKey.scriptHex
              };
            } else {
              throw new Error(`UTXO ${txId}:${index} missing scriptPublicKey in RPC response. Cannot build transaction without proper UTXO data.`);
            }
          }
          
          // Use full UTXO from RPC
          formattedUtxo = {
            outpoint: {
              transactionId: foundUtxo.outpoint?.transactionId || foundUtxo.transactionId || txId,
              index: foundUtxo.outpoint?.index !== undefined ? foundUtxo.outpoint.index : (foundUtxo.index !== undefined ? foundUtxo.index : index)
            },
            amount: typeof foundUtxo.amount === 'bigint' ? foundUtxo.amount : BigInt(String(foundUtxo.amount || utxo.amount || '0')),
            scriptPublicKey: {
              version: typeof scriptPublicKey.version === 'number' ? scriptPublicKey.version : Number(scriptPublicKey.version || 0),
              script: String(scriptPublicKey.script || scriptPublicKey.scriptHex || '')
            },
            blockDaaScore: foundUtxo.blockDaaScore !== undefined 
              ? (typeof foundUtxo.blockDaaScore === 'bigint' ? foundUtxo.blockDaaScore : BigInt(String(foundUtxo.blockDaaScore || '0')))
              : 0n,
            isCoinbase: foundUtxo.isCoinbase !== undefined ? Boolean(foundUtxo.isCoinbase) : false
          };
        } else {
          // CRITICAL: Cannot build transaction without proper UTXO data
          // The UTXO must exist in the node's view for the transaction to be valid
          const checkedAddresses = addressesToCheck.length > 0 ? addressesToCheck.join(', ') : allAddressesArray.join(', ');
          throw new Error(
            `UTXO ${txId}:${index} not found in RPC response for addresses: ${checkedAddresses}. ` +
            `This UTXO may not exist, may have been spent, or may be at a different address. ` +
            `Please ensure the UTXO is valid and accessible before building the transaction.`
          );
        }
        
        uniqueInputsMap.set(utxoKey, formattedUtxo);
      } catch (err) {
        // CRITICAL: Do not use fallback minimal format - this causes orphan errors
        // If we can't fetch proper UTXO data, we cannot build the transaction
        const txId = utxo.transactionId || utxo.txId || '';
        const index = typeof utxo.index === 'number' ? utxo.index : (utxo.outputIndex !== undefined ? utxo.outputIndex : 0);
        
        console.error(`[Coinjoin] Error fetching UTXO details for ${txId}:${index}:`, err);
        
        // Re-throw the error so it's handled properly
        throw new Error(
          `Failed to fetch UTXO ${txId}:${index} details: ${err.message || String(err)}. ` +
          `Cannot build transaction without proper UTXO data. Please ensure the UTXO exists and is accessible.`
        );
      }
    }
    
    allDestinations.push({
      address: session.destinationAddress,
      sessionId: session.id
    });
  }
  
  // Convert Map to Array for allInputs (now deduplicated)
  const allInputs = Array.from(uniqueInputsMap.values());
  
  // Log if we detected and deduplicated any UTXOs
  const totalRevealedUtxos = sessions.reduce((sum, { session }) => sum + (session.revealedUtxos?.length || 0), 0);
  if (totalRevealedUtxos > allInputs.length) {
    console.log(`[Coinjoin] Deduplicated ${totalRevealedUtxos - allInputs.length} duplicate UTXO(s). Transaction will have ${allInputs.length} unique inputs.`);
  }
  
  // Validate that all participant contributions match (required for coinjoin batches)
  // Calculate each session's total contribution
  const sessionContributions = sessions.map(({ sessionId, session }) => {
    const contribution = session.revealedUtxos.reduce((sum, utxo) => {
      const amount = BigInt(String(utxo.amount || '0'));
      return sum + amount;
    }, 0n);
    return { sessionId, contribution };
  });
  
  // Find min and max contributions
  const contributions = sessionContributions.map(s => s.contribution);
  const minContribution = contributions.reduce((min, val) => val < min ? val : min, contributions[0] || 0n);
  const maxContribution = contributions.reduce((max, val) => val > max ? val : max, contributions[0] || 0n);
  
  // CRITICAL: Enforce EXACT matching for fairness and security
  // All participants must contribute the EXACT same amount - no tolerance
  // This prevents gaming where participants contribute less/more to gain advantage
  if (minContribution > 0n && maxContribution !== minContribution) {
    const minKAS = (Number(minContribution) / 1e8).toFixed(8);
    const maxKAS = (Number(maxContribution) / 1e8).toFixed(8);
    const difference = maxContribution - minContribution;
    const diffKAS = (Number(difference) / 1e8).toFixed(8);
    
    // Find participants with mismatched amounts
    const mismatchedParticipants = sessionContributions.filter(s => {
      return s.contribution !== minContribution;
    });
    
    throw new Error(
      `Cannot build coinjoin: Participant amounts are not exactly equal. ` +
      `Min: ${minKAS} KAS, Max: ${maxKAS} KAS (difference: ${diffKAS} KAS). ` +
      `All participants must contribute the EXACT same amount for fairness and security. No tolerance allowed. ` +
      `${mismatchedParticipants.length} participant(s) have mismatched amounts.`
    );
  }
  
  // Calculate total input amount
  const totalInput = allInputs.reduce((sum, utxo) => {
    const amount = typeof utxo.amount === 'bigint' ? utxo.amount : BigInt(String(utxo.amount || '0'));
    return sum + amount;
  }, 0n);
  
  // Calculate equal output amount (after fees)
  const tempOutputs = allDestinations.map(d => ({ 
    address: d.address, 
    amount: totalInput / BigInt(allDestinations.length) 
  }));
  const estimatedFee = await calculateOptimalFee(allInputs, tempOutputs, rpc);
  
  const availableAfterFee = totalInput - estimatedFee;
  const equalOutputAmount = availableAfterFee / BigInt(allDestinations.length);
  
  // Create outputs
  const outputs = allDestinations.map(d => ({
    address: d.address,
    amount: equalOutputAmount
  }));
  
  // Recalculate fee with actual outputs
  const finalFee = await calculateOptimalFee(allInputs, outputs, rpc);
  const finalAvailable = totalInput - finalFee;
  const finalEqualAmount = finalAvailable / BigInt(allDestinations.length);
  const remainder = finalAvailable % BigInt(allDestinations.length);
  
  // CRITICAL: For CoinJoin privacy, all outputs MUST be exactly equal
  // Any remainder from division goes to fees (miner gets it) to maintain perfect equality
  // This ensures no privacy leak from output amount differences
  outputs.forEach((output) => {
    output.amount = finalEqualAmount; // All outputs exactly equal
  });
  
  // The remainder (0 to participantCount-1 sompi) is effectively added to fees
  // This maintains perfect output equality required for CoinJoin privacy
  if (remainder > 0n) {
    console.log(`[Coinjoin] Remainder of ${Number(remainder)} sompi will go to transaction fees to maintain equal outputs`);
  }
  
  // Verify: total outputs should equal (finalAvailable - remainder)
  // The remainder is included in fees to maintain exact output equality
  const totalOutputs = outputs.reduce((sum, o) => sum + o.amount, 0n);
  const expectedOutputs = finalEqualAmount * BigInt(allDestinations.length);
  
  if (totalOutputs !== expectedOutputs) {
    console.error(`[Coinjoin] Math error: Outputs ${totalOutputs} != Expected ${expectedOutputs} (diff: ${totalOutputs - expectedOutputs})`);
    throw new Error(`Output calculation error: outputs don't match expected amount`);
  }
  
  // The actual fee includes the remainder (which goes to miners)
  // This ensures: totalInput - (finalFee + remainder) = totalOutputs
  // Transaction balances correctly: inputs = outputs + fees (where fees include remainder)
  
  // Map inputs to their session owners for signing
  // Since inputs are now deduplicated, we need to map each unique input to all sessions that reference it
  const inputOwners = [];
  for (let inputIndex = 0; inputIndex < allInputs.length; inputIndex++) {
    const utxo = allInputs[inputIndex];
    const txId = utxo.outpoint?.transactionId || utxo.transactionId || '';
    const index = utxo.outpoint?.index !== undefined ? utxo.outpoint.index : (utxo.index !== undefined ? utxo.index : 0);
    const utxoKey = `${txId}:${index}`;
    
    // Get all sessions that reference this UTXO
    const referencingSessions = utxoSessionMap.get(utxoKey) || [];
    for (const { sessionId, session } of referencingSessions) {
      inputOwners.push({
        sessionId,
        destinationAddress: session.destinationAddress,
        inputIndex: inputIndex
      });
    }
  }
  
  // Check transaction mass before building
  // Based on actual measurements: signature scripts add significant mass per input
  // With 3 inputs and 8 outputs, we observed ~550k mass (well over the 100k limit)
  // This suggests signature scripts are extremely large (~180k per input)
  // Due to this constraint, we can only support very small transactions
  // Note: This check provides early warning, but actual mass validation happens at submission
  const MAX_TRANSACTION_MASS = 100000;
  const MASS_PER_OUTPUT = 500;
  
  // Very conservative estimate: assume each input adds significant mass
  // With signature scripts, even 1 input may approach the limit
  // For safety, we'll warn if there are more than 1-2 inputs
  if (allInputs.length > 2) {
    console.warn(
      `[Coinjoin] Warning: Transaction has ${allInputs.length} inputs and ${outputs.length} outputs. ` +
      `Signature scripts add significant mass (~180k per input), which may cause the transaction to exceed the ${MAX_TRANSACTION_MASS} limit. ` +
      `If the transaction is rejected for being too large, consider using fewer UTXOs per participant or reducing the number of participants. ` +
      `Current participants: ${sessions.length}.`
    );
  }
  
  if (allInputs.length > 1 && outputs.length > 3) {
    console.warn(
      `[Coinjoin] Warning: Transaction with ${allInputs.length} inputs and ${outputs.length} outputs may exceed mass limit. ` +
      `Consider reducing participants or UTXOs per participant if transaction is rejected.`
    );
  }
  
  // Calculate contribution statistics for UI display
  const contributionStats = {
    min: Number(minContribution) / 1e8,
    max: Number(maxContribution) / 1e8,
    ratio: minContribution > 0n ? Number(maxContribution) / Number(minContribution) : 1,
    contributions: sessionContributions.map(s => ({
      sessionId: s.sessionId,
      amount: Number(s.contribution) / 1e8
    }))
  };
  
  // Calculate actual total output (sum of all output amounts - should be equal outputs)
  const actualTotalOutput = totalOutputs; // This is the sum of all equal outputs
  
  return {
    inputs: allInputs,
    outputs,
    fee: finalFee + remainder, // Fee includes remainder (which goes to miner)
    totalInput,
    totalOutput: actualTotalOutput, // Actual total of all outputs (all equal)
    participants: sessions.length,
    sessionIds: sessionIds,
    inputOwners, // Maps each input to its owner session
    contributionStats, // Contribution statistics for UI warnings
    message: 'Users must sign their own inputs. Each user signs the UTXOs they provided.'
  };
}

// Monitor coinjoin deposits (trusted mode)
async function monitorCoinjoinDeposits(intervalMs = 10000) {
  setInterval(async () => {
    try {
      const rpc = await getRpcClient();
      const sessions = await getAllCoinjoinSessions();
      
      // Only process trusted mode sessions
      const trustedSessions = sessions.filter(({ session }) => 
        !session.zeroTrustMode && session.status === 'waiting_deposit'
      );
      
      if (trustedSessions.length === 0) return;
      
      let currentDaaScore = 0;
      try {
        const dagInfo = await rpc.getBlockDagInfo({});
        currentDaaScore = dagInfo.virtualDaaScore || 0;
      } catch (e) {
        console.error('[Coinjoin] Error fetching DAA score:', e);
        return;
      }
      
      const MIN_CONFIRMATIONS = 20;
      
      for (const { sessionId, session } of trustedSessions) {
        try {
          const result = await rpc.getUtxosByAddresses({ addresses: [session.depositAddress] });
          
          if (result && result.entries && result.entries.length > 0) {
            const confirmedUtxos = result.entries.filter(utxo => 
              utxo.blockDaaScore && (currentDaaScore - utxo.blockDaaScore >= MIN_CONFIRMATIONS)
            );
            
            if (confirmedUtxos.length > 0) {
              const total = confirmedUtxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
              
              if (total >= FIXED_ENTRY_AMOUNT - ENTRY_TOLERANCE && total <= FIXED_ENTRY_AMOUNT + ENTRY_TOLERANCE) {
                // Forward to pool wallet
                let fee = 35000n;
                try {
                  fee = await calculateOptimalFee(confirmedUtxos, [{ address: session.poolWalletAddress, amount: total }], rpc);
                } catch (err) {
                  console.error('[Coinjoin] Error calculating fee:', err);
                }
                
                const tx = kaspa.createTransaction(
                  confirmedUtxos,
                  [{ address: session.poolWalletAddress, amount: total - fee }],
                  fee
                );
                
                const privateKey = new kaspa.PrivateKey(session.depositPrivateKey);
                const signedTx = kaspa.signTransaction(tx, [privateKey], true);
                
                try {
                  const resultSend = await rpc.submitTransaction({ transaction: signedTx });
                  session.status = 'entered';
                  session.amount = total.toString();
                  session.txId = resultSend.transactionId;
                  session.updatedAt = Date.now();
                  
                  await setSession(sessionId, session);
                  console.log(`[Coinjoin] Deposit detected and forwarded for session ${sessionId}: ${total.toString()}`);
                } catch (err) {
                  if (err.message && err.message.includes('already in the mempool')) {
                    session.status = 'entered';
                    session.amount = total.toString();
                    session.updatedAt = Date.now();
                    await setSession(sessionId, session);
                  } else {
                    throw err;
                  }
                }
              } else {
                session.status = 'error';
                session.error = `Deposit must be 1 KAS (tolerance: 0.0001 KAS). Received: ${total.toString()} sompi.`;
                session.updatedAt = Date.now();
                await setSession(sessionId, session);
              }
            }
          }
        } catch (err) {
          session.status = 'error';
          session.error = '[E_COINJOIN_DEPOSIT] ' + (err.message || String(err));
          session.updatedAt = Date.now();
          await setSession(sessionId, session);
          console.error(`[E_COINJOIN_DEPOSIT] Session ${sessionId} error: ${session.error}`);
        }
      }
      
      // Check if batch should be processed
      await checkAndTriggerCoinjoinBatch();
    } catch (err) {
      console.error('[Coinjoin] Error in deposit monitoring:', err);
    }
  }, intervalMs);
}

// Check and trigger coinjoin batch
async function checkAndTriggerCoinjoinBatch() {
  try {
    // Check trusted mode sessions
    const trustedSessions = await getCoinjoinSessionsByStatus('entered');
    const trustedFiltered = trustedSessions.filter(({ session }) => !session.zeroTrustMode);
    
    if (trustedFiltered.length >= MIN_TRUSTED_PARTICIPANTS) {
      console.log(`[Coinjoin] Auto-triggering trusted batch with ${trustedFiltered.length} entries`);
      await processTrustedCoinjoinBatch(trustedFiltered);
    }
    
    // Check zero-trust mode sessions
    const zeroTrustSessions = await getCoinjoinSessionsByStatus('revealed');
    const zeroTrustFiltered = zeroTrustSessions.filter(({ session }) => session.zeroTrustMode);
    
    if (zeroTrustFiltered.length >= MIN_ZERO_TRUST_PARTICIPANTS) {
      console.log(`[Coinjoin] Zero-trust sessions ready: ${zeroTrustFiltered.length}`);
      // For zero-trust, users build and sign transaction themselves
      // This just indicates readiness
    }
  } catch (err) {
    console.error('[Coinjoin] Error in batch trigger check:', err);
  }
}

// Process trusted coinjoin batch
async function processTrustedCoinjoinBatch(sessions) {
  if (sessions.length < MIN_TRUSTED_PARTICIPANTS) {
    throw new Error(`Not enough entries (need ${MIN_TRUSTED_PARTICIPANTS}, got ${sessions.length})`);
  }
  
  // Get pool wallet from first session
  const firstSession = sessions[0].session;
  const poolWalletAddress = firstSession.poolWalletAddress;
  
  if (!poolWalletAddress) {
    throw new Error('Pool wallet address not configured');
  }
  
  // Calculate total amount
  const totalBatchAmount = sessions.reduce((sum, { session }) => 
    sum + BigInt(session.amount || 0), 0n
  );
  
  // Calculate coinjoin fee (1%)
  const coinjoinFee = (totalBatchAmount * BigInt(Math.floor(KASJOIN_FEE_PERCENTAGE * 100))) / 100n;
  const remainingPool = totalBatchAmount - coinjoinFee;
  const payoutPerUser = remainingPool / BigInt(sessions.length);
  
  // Get UTXOs from pool wallet
  const rpc = await getRpcClient();
  const utxoRes = await rpc.getUtxosByAddresses({ addresses: [poolWalletAddress] });
  const allUtxos = utxoRes.entries || [];
  
  if (allUtxos.length === 0) {
    throw new Error('No UTXOs found for pool wallet');
  }
  
  const totalAvailable = allUtxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
  
  if (totalAvailable < totalBatchAmount) {
    throw new Error('Insufficient funds in pool wallet');
  }
  
  // Split into batches if needed
  const batches = [];
  for (let i = 0; i < sessions.length; i += MAX_OUTPUTS_PER_TX) {
    batches.push(sessions.slice(i, i + MAX_OUTPUTS_PER_TX));
  }
  
  const feePerBatch = coinjoinFee / BigInt(batches.length);
  let usedUtxoIds = new Set();
  
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batchSessions = batches[batchIndex];
    const batchAmount = BigInt(batchSessions.length) * payoutPerUser + feePerBatch;
    
    // Get available UTXOs
    const utxoRes = await rpc.getUtxosByAddresses({ addresses: [poolWalletAddress] });
    const allUtxos = utxoRes.entries || [];
    
    const availableUtxos = allUtxos.filter(utxo => {
      let txId, index;
      if (utxo.outpoint && utxo.outpoint.transactionId && utxo.outpoint.index !== undefined) {
        txId = utxo.outpoint.transactionId;
        index = utxo.outpoint.index;
      } else {
        txId = utxo.transactionId || utxo.txId;
        index = utxo.index || utxo.outputIndex;
      }
      if (!txId || index === undefined) return false;
      const utxoId = `${txId}:${index}`;
      return !usedUtxoIds.has(utxoId);
    });
    
    // Select UTXOs (simple - use first ones that cover amount)
    let selectedUtxos = [];
    let selectedAmount = 0n;
    
    for (const utxo of availableUtxos) {
      selectedUtxos.push(utxo);
      selectedAmount += BigInt(utxo.amount);
      if (selectedAmount >= batchAmount) break;
    }
    
    if (selectedAmount < batchAmount) {
      throw new Error(`Insufficient UTXOs: selected ${selectedAmount} sompi, need ${batchAmount} sompi`);
    }
    
    // Mark UTXOs as used
    selectedUtxos.forEach(utxo => {
      let txId, index;
      if (utxo.outpoint && utxo.outpoint.transactionId && utxo.outpoint.index !== undefined) {
        txId = utxo.outpoint.transactionId;
        index = utxo.outpoint.index;
      } else {
        txId = utxo.transactionId || utxo.txId;
        index = utxo.index || utxo.outputIndex;
      }
      if (txId && index !== undefined) {
        usedUtxoIds.add(`${txId}:${index}`);
      }
    });
    
    // Create outputs
    const batchOutputs = batchSessions.map(({ session }) => ({
      address: session.destinationAddress,
      amount: payoutPerUser
    }));
    
    batchOutputs.push({ address: poolWalletAddress, amount: feePerBatch });
    
    const batchFee = await calculateOptimalFee(selectedUtxos, batchOutputs, rpc);
    const kasjoinFeeOutputIndex = batchOutputs.length - 1;
    batchOutputs[kasjoinFeeOutputIndex].amount -= batchFee;
    
    // Create and sign transaction
    // Note: In trusted mode, we need pool private key - this should be provided by user
    // For now, this is a placeholder - actual implementation would require pool key
    console.log(`[Coinjoin] Batch ${batchIndex + 1} ready: ${batchSessions.length} participants, fee: ${batchFee} sompi`);
    console.log(`[Coinjoin] Note: Transaction signing requires pool private key`);
    
    // Update session statuses
    for (const { sessionId, session } of batchSessions) {
      session.status = 'ready_for_batch';
      session.batchIndex = batchIndex;
      session.payoutAmount = payoutPerUser.toString();
      session.updatedAt = Date.now();
      await setSession(sessionId, session);
    }
  }
  
  return {
    success: true,
    batches: batches.length,
    totalParticipants: sessions.length,
    message: 'Batch ready. Requires pool private key to sign and submit.'
  };
}

// Get coinjoin statistics
async function getCoinjoinStats() {
  const allSessions = await getAllCoinjoinSessions();
  
  const trusted = allSessions.filter(({ session }) => !session.zeroTrustMode);
  const zeroTrust = allSessions.filter(({ session }) => session.zeroTrustMode);
  
  const stats = {
    total: allSessions.length,
    trusted: {
      total: trusted.length,
      waiting: trusted.filter(s => s.session.status === 'waiting_deposit').length,
      entered: trusted.filter(s => s.session.status === 'entered').length,
      ready: trusted.filter(s => s.session.status === 'ready_for_batch').length,
      completed: trusted.filter(s => s.session.status === 'completed').length
    },
    zeroTrust: {
      total: zeroTrust.length,
      committed: zeroTrust.filter(s => s.session.status === 'committed').length,
      revealed: zeroTrust.filter(s => s.session.status === 'revealed').length,
      completed: zeroTrust.filter(s => s.session.status === 'completed').length
    }
  };
  
  return stats;
}

// Sign zero-trust coinjoin transaction inputs for a specific session
async function signCoinjoinInputs(sessionId, transactionData, privateKeyHex) {
  if (!transactionData || !transactionData.inputs || !transactionData.outputs) {
    throw new Error('Invalid transaction data');
  }
  
  const session = await getSession(sessionId);
  if (!session || !session.zeroTrustMode || session.status !== 'revealed') {
    throw new Error('Session not found or not in revealed state');
  }
  
  // Find which inputs belong to this session
  const sessionInputIndices = [];
  transactionData.inputOwners.forEach((owner, idx) => {
    if (owner.sessionId === sessionId) {
      sessionInputIndices.push(owner.inputIndex);
    }
  });
  
  if (sessionInputIndices.length === 0) {
    throw new Error('No inputs found for this session');
  }
  
  // Validate private key
  if (!privateKeyHex || typeof privateKeyHex !== 'string') {
    throw new Error('Invalid private key: must be a hex string');
  }
  
  // Import private key
  let privateKey;
  try {
    privateKey = new kaspa.PrivateKey(privateKeyHex.trim());
  } catch (err) {
    throw new Error(`Failed to create PrivateKey: ${err.message || String(err)}`);
  }
  
  // Validate transaction data
  if (!transactionData.inputs || !Array.isArray(transactionData.inputs) || transactionData.inputs.length === 0) {
    throw new Error('Invalid transaction data: no inputs provided');
  }
  if (!transactionData.outputs || !Array.isArray(transactionData.outputs) || transactionData.outputs.length === 0) {
    throw new Error('Invalid transaction data: no outputs provided');
  }
  if (transactionData.fee === undefined || transactionData.fee === null) {
    throw new Error('Invalid transaction data: fee is required');
  }
  
  // Ensure UTXOs have proper scriptPublicKey format
  // After IPC serialization, scriptPublicKey might be lost or malformed
  // We'll fetch UTXOs by addresses from sessions to get scriptPublicKey
  const rpc = await getRpcClient();
  const formattedInputs = [];
  
  // Group inputs by session to fetch UTXOs efficiently
  // Try to get addresses from sessions (destination address) and wallet (if available)
  const sessionAddressMap = new Map();
  const addressesToQuery = new Set();
  
  for (const owner of transactionData.inputOwners || []) {
    if (!sessionAddressMap.has(owner.sessionId)) {
      const session = await getSession(owner.sessionId);
      if (session) {
        // CRITICAL: Query utxoSourceAddress first - this is where the UTXO actually exists
        // When a UTXO is created via sendFromWallet, it's sent to the source address (participant's own address)
        // The destination address is where the coinjoin output will go, not where the input UTXO exists
        if (session.utxoSourceAddress) {
          addressesToQuery.add(session.utxoSourceAddress);
          console.log(`[Coinjoin] Adding utxoSourceAddress ${session.utxoSourceAddress} for session ${owner.sessionId}`);
        }
        // Also try utxoSourceAddresses array if available
        if (session.utxoSourceAddresses && Array.isArray(session.utxoSourceAddresses)) {
          for (const addr of session.utxoSourceAddresses) {
            addressesToQuery.add(addr);
            console.log(`[Coinjoin] Adding utxoSourceAddress ${addr} from array for session ${owner.sessionId}`);
          }
        }
        // Try destination address (may be the same as source, but check anyway)
        if (session.destinationAddress) {
          sessionAddressMap.set(owner.sessionId, session.destinationAddress);
          addressesToQuery.add(session.destinationAddress);
        }
        // Also try original destination if different
        if (session.originalDestination && session.originalDestination !== session.destinationAddress) {
          addressesToQuery.add(session.originalDestination);
        }
      }
    }
  }
  
  // Also try to get wallet address if wallet is imported
  try {
    const { readWallet } = require('../wallet');
    const wallet = readWallet();
    if (wallet && wallet.address) {
      addressesToQuery.add(wallet.address);
    }
  } catch (err) {
    // Wallet not imported, that's okay
  }
  
  // Fetch UTXOs for all unique addresses
  const addressUtxoMap = new Map();
  for (const address of addressesToQuery) {
    try {
      const utxoResult = await rpc.getUtxosByAddresses({ addresses: [address] });
      if (utxoResult && utxoResult.entries) {
        for (const entry of utxoResult.entries) {
          const txId = entry.outpoint?.transactionId || entry.transactionId || '';
          const index = entry.outpoint?.index !== undefined ? entry.outpoint.index : (entry.index !== undefined ? entry.index : 0);
          const key = `${txId}:${index}`;
          if (!addressUtxoMap.has(key)) {
            addressUtxoMap.set(key, entry);
          }
        }
      }
    } catch (err) {
      console.warn(`[Coinjoin] Failed to fetch UTXOs for address ${address}:`, err.message);
    }
  }
  
  for (let i = 0; i < transactionData.inputs.length; i++) {
    const utxo = transactionData.inputs[i];
    const txId = utxo.outpoint?.transactionId || utxo.transactionId || '';
    const index = utxo.outpoint?.index !== undefined ? utxo.outpoint.index : (utxo.index !== undefined ? utxo.index : 0);
    const key = `${txId}:${index}`;
    
    // Check if scriptPublicKey exists and is valid
    const hasValidScriptPublicKey = utxo.scriptPublicKey && 
      typeof utxo.scriptPublicKey === 'object' && 
      utxo.scriptPublicKey.version !== undefined && 
      utxo.scriptPublicKey.script !== undefined &&
      utxo.scriptPublicKey.script !== null &&
      String(utxo.scriptPublicKey.script).length > 0;
    
    let scriptPublicKey = null;
    
    if (hasValidScriptPublicKey) {
      // Use existing scriptPublicKey
      scriptPublicKey = {
        version: typeof utxo.scriptPublicKey.version === 'number' ? utxo.scriptPublicKey.version : Number(utxo.scriptPublicKey.version || 0),
        script: String(utxo.scriptPublicKey.script || '')
      };
    } else if (addressUtxoMap.has(key)) {
      // Get scriptPublicKey from fetched UTXO
      const foundUtxo = addressUtxoMap.get(key);
      if (foundUtxo.scriptPublicKey) {
        // Handle WASM object serialization
        let spk = foundUtxo.scriptPublicKey;
        if (spk && typeof spk.toJSON === 'function') {
          spk = spk.toJSON();
        }
        scriptPublicKey = {
          version: typeof spk.version === 'number' ? spk.version : (spk.version !== undefined ? Number(spk.version) : 0),
          script: String(spk.script || spk.scriptHex || '')
        };
      }
    }
    
    // Fallback: use minimal scriptPublicKey (this might cause issues, but we need something)
    if (!scriptPublicKey || !scriptPublicKey.script || scriptPublicKey.script.length === 0) {
      console.warn(`[Coinjoin] UTXO ${txId}:${index} missing scriptPublicKey, using minimal format`);
      scriptPublicKey = {
        version: 0,
        script: ''
      };
    }
    
    // Format UTXO with proper scriptPublicKey
    formattedInputs.push({
      outpoint: {
        transactionId: txId,
        index: index
      },
      amount: typeof utxo.amount === 'bigint' ? utxo.amount : BigInt(String(utxo.amount || '0')),
      scriptPublicKey: scriptPublicKey,
      blockDaaScore: utxo.blockDaaScore !== undefined 
        ? (typeof utxo.blockDaaScore === 'bigint' ? utxo.blockDaaScore : BigInt(String(utxo.blockDaaScore))) 
        : 0n,
      isCoinbase: utxo.isCoinbase !== undefined ? Boolean(utxo.isCoinbase) : false
    });
  }
  
  // Create transaction with properly formatted inputs
  let tx;
  try {
    tx = kaspa.createTransaction(
      formattedInputs,
      transactionData.outputs,
      typeof transactionData.fee === 'bigint' ? transactionData.fee : BigInt(String(transactionData.fee))
    );
  } catch (err) {
    throw new Error(`Failed to create transaction: ${err.message || String(err)}`);
  }
  
  if (!tx) {
    throw new Error('Failed to create transaction: transaction object is null');
  }
  
  // CRITICAL: Use signTransaction approach (same as sendFromWallet) instead of createInputSignature
  // signTransaction properly formats signature scripts, while createInputSignature returns incomplete signatures
  // However, signTransaction signs all inputs. For zero-trust, we need to sign only specific inputs.
  // Solution: Use signTransaction with just this participant's private key - it will only sign matching inputs
  
  console.log(`[Coinjoin] Signing inputs for session ${sessionId} using signTransaction (same method as sendFromWallet)`);
  console.log(`[Coinjoin] Transaction type: ${typeof tx}, PrivateKey type: ${typeof privateKey}`);
  
  if (!tx || !privateKey) {
    throw new Error(`Transaction or private key is null/undefined. tx: ${!!tx}, privateKey: ${!!privateKey}`);
  }
  
  // Debug: Check what address this private key corresponds to
  try {
    const { KASPA_NETWORK } = require('../config');
    const publicKey = privateKey.toPublicKey();
    const address = publicKey.toAddress(KASPA_NETWORK).toString();
    console.log(`[Coinjoin] Participant's address from private key: ${address}`);
    
    // Debug: Check what addresses the UTXOs in sessionInputIndices belong to
    for (const inputIndex of sessionInputIndices) {
      if (inputIndex >= tx.inputs.length) continue;
      const input = tx.inputs[inputIndex];
      const utxo = formattedInputs[inputIndex];
      if (utxo && utxo.scriptPublicKey) {
        console.log(`[Coinjoin] Input ${inputIndex} UTXO scriptPublicKey: version=${utxo.scriptPublicKey.version}, script length=${utxo.scriptPublicKey.script?.length || 0}`);
      }
    }
  } catch (err) {
    console.warn(`[Coinjoin] Could not derive address from private key: ${err.message}`);
  }
  
  // Use signTransaction with this participant's private key
  // signTransaction will automatically match the private key to the correct inputs and sign them
  // This ensures the signature script format matches what works for UTXO creation (same as sendFromWallet)
  // Use verify_sig=false because we're signing incrementally (each participant signs separately)
  try {
    const signedTx = kaspa.signTransaction(tx, [privateKey], false);
    
    // Extract the signature scripts from the signed transaction
    // signTransaction signs ALL inputs that match the private key (not just sessionInputIndices)
    // We need to extract only the signatures for inputs that belong to this session
    const signedInputs = [];
    for (const inputIndex of sessionInputIndices) {
      if (inputIndex < 0 || inputIndex >= signedTx.inputs.length) {
        throw new Error(`Invalid input index: ${inputIndex} (transaction has ${signedTx.inputs.length} inputs)`);
      }
      
      const signatureScript = signedTx.inputs[inputIndex].signatureScript;
      
      // Check if this input was signed (signTransaction only signs inputs that match the private key)
      if (signatureScript && signatureScript.length > 0) {
        console.log(`[Coinjoin] Input ${inputIndex} signed for session ${sessionId}, signatureScript length: ${signatureScript.length} chars`);
        signedInputs.push({
          inputIndex,
          signature: signatureScript
        });
      } else {
        // Input wasn't signed - this means the private key doesn't match this UTXO
        // This could happen if:
        // 1. The UTXO address doesn't match the private key's address
        // 2. The transaction was created with incorrect UTXO data
        throw new Error(`Input ${inputIndex} was not signed. The private key for session ${sessionId} doesn't match the UTXO at input ${inputIndex}. This may indicate a mismatch between the UTXO's address and the participant's private key.`);
      }
    }
    
    if (signedInputs.length === 0) {
      throw new Error(`No inputs were signed for session ${sessionId}. This participant's private key doesn't match any inputs.`);
    }
    
    if (signedInputs.length !== sessionInputIndices.length) {
      throw new Error(`Only ${signedInputs.length} of ${sessionInputIndices.length} inputs were signed for session ${sessionId}. This indicates a mismatch between the UTXOs and the participant's private key.`);
    }
    
    console.log(`[Coinjoin] Successfully signed all ${signedInputs.length} inputs for session ${sessionId}`);
    
    return {
      sessionId,
      signedInputs,
      inputCount: signedInputs.length
    };
  } catch (err) {
    console.error(`[Coinjoin] Error signing with signTransaction:`, err);
    const errorMsg = err.message || err.toString() || String(err) || 'Unknown error';
    throw new Error(`Failed to sign inputs with signTransaction: ${errorMsg}`);
  }
  
  return {
    sessionId,
    signedInputs,
    inputCount: sessionInputIndices.length
  };
}

// Helper function to serialize BigInt values for JSON
function serializeForStorage(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => serializeForStorage(item));
  }
  
  if (typeof obj === 'object') {
    const serialized = {};
    for (const [key, value] of Object.entries(obj)) {
      serialized[key] = serializeForStorage(value);
    }
    return serialized;
  }
  
  return obj;
}

// Store signatures for a coinjoin transaction
// We'll use a hash of the transaction data to identify it
async function storeCoinjoinSignatures(transactionData, signatures) {
  const crypto = require('crypto');
  
  // Create a unique ID for this transaction based on its inputs and outputs
  // Serialize BigInt values for hashing
  const txHash = crypto.createHash('sha256').update(
    JSON.stringify({
      inputs: transactionData.inputs.map(i => ({
        txId: i.outpoint?.transactionId || i.transactionId,
        index: typeof i.outpoint?.index === 'bigint' ? i.outpoint.index.toString() : (typeof i.index === 'bigint' ? i.index.toString() : i.index)
      })),
      outputs: transactionData.outputs.map(o => ({
        address: o.address,
        amount: typeof o.amount === 'bigint' ? o.amount.toString() : String(o.amount || '0')
      })),
      fee: typeof transactionData.fee === 'bigint' ? transactionData.fee.toString() : String(transactionData.fee || '0'),
      sessionIds: transactionData.sessionIds
    })
  ).digest('hex');
  
  // Serialize transaction data and signatures before storing
  const serializedTransactionData = serializeForStorage(transactionData);
  const serializedSignatures = serializeForStorage(signatures);
  
  // Store in session data for each participant
  for (const sessionId of transactionData.sessionIds) {
    const session = await getSession(sessionId);
    if (session) {
      if (!session.pendingTransaction) {
        session.pendingTransaction = {};
      }
      session.pendingTransaction.txHash = txHash;
      session.pendingTransaction.transactionData = serializedTransactionData;
      session.pendingTransaction.signatures = serializedSignatures;
      session.pendingTransaction.updatedAt = Date.now();
      await setSession(sessionId, session);
    }
  }
  
  return txHash;
}

// Get stored signatures for a coinjoin transaction
async function getCoinjoinSignatures(transactionData) {
  if (!transactionData || !transactionData.sessionIds || transactionData.sessionIds.length === 0) {
    return null;
  }
  
  // Get signatures from the first session (they should be the same across all sessions)
  const firstSession = await getSession(transactionData.sessionIds[0]);
  if (!firstSession || !firstSession.pendingTransaction) {
    return null;
  }
  
  // Verify the transaction hash matches
  // Serialize BigInt values for hashing (same as in storeCoinjoinSignatures)
  const crypto = require('crypto');
  const txHash = crypto.createHash('sha256').update(
    JSON.stringify({
      inputs: transactionData.inputs.map(i => ({
        txId: i.outpoint?.transactionId || i.transactionId,
        index: typeof i.outpoint?.index === 'bigint' ? i.outpoint.index.toString() : (typeof i.index === 'bigint' ? i.index.toString() : i.index)
      })),
      outputs: transactionData.outputs.map(o => ({
        address: o.address,
        amount: typeof o.amount === 'bigint' ? o.amount.toString() : String(o.amount || '0')
      })),
      fee: typeof transactionData.fee === 'bigint' ? transactionData.fee.toString() : String(transactionData.fee || '0'),
      sessionIds: transactionData.sessionIds
    })
  ).digest('hex');
  
  if (firstSession.pendingTransaction.txHash !== txHash) {
    // Transaction data has changed, signatures are invalid
    return null;
  }
  
  // Return stored signatures (they're already serialized as strings)
  return firstSession.pendingTransaction.signatures || null;
}

// Submit fully signed zero-trust coinjoin transaction
async function submitSignedCoinjoinTransaction(transactionData, allSignatures) {
  if (!transactionData || !transactionData.inputs || !transactionData.outputs) {
    throw new Error('Invalid transaction data');
  }
  
  // allSignatures is an object with input indices as keys
  const signatureCount = allSignatures ? Object.keys(allSignatures).length : 0;
  if (!allSignatures || signatureCount !== transactionData.inputs.length) {
    throw new Error(`Not all inputs are signed. Expected ${transactionData.inputs.length}, got ${signatureCount}`);
  }
  
  // Use UTXOs directly from transactionData - they were already validated during build
  // This is simpler and more reliable than re-fetching via address queries
  const rpc = await getRpcClient();
  const formattedInputs = [];
  
  for (let i = 0; i < transactionData.inputs.length; i++) {
    const utxo = transactionData.inputs[i];
    const txId = utxo.outpoint?.transactionId || utxo.transactionId || '';
    const index = utxo.outpoint?.index !== undefined ? utxo.outpoint.index : (utxo.index !== undefined ? utxo.index : 0);
    
    // Use UTXO data from transactionData (already validated during buildZeroTrustCoinjoinTransaction)
    // Format scriptPublicKey
    let scriptPublicKey = null;
    
    if (utxo.scriptPublicKey && typeof utxo.scriptPublicKey === 'object') {
      scriptPublicKey = {
        version: typeof utxo.scriptPublicKey.version === 'number' ? utxo.scriptPublicKey.version : Number(utxo.scriptPublicKey.version || 0),
        script: String(utxo.scriptPublicKey.script || '')
      };
    }
    
    // If scriptPublicKey is missing or empty, use minimal format
    if (!scriptPublicKey || !scriptPublicKey.script || scriptPublicKey.script.length === 0) {
      scriptPublicKey = {
        version: 0,
        script: ''
      };
    }
    
    formattedInputs.push({
      outpoint: {
        transactionId: txId,
        index: index
      },
      amount: typeof utxo.amount === 'bigint' ? utxo.amount : BigInt(String(utxo.amount || '0')),
      scriptPublicKey: scriptPublicKey,
      blockDaaScore: utxo.blockDaaScore !== undefined 
        ? (typeof utxo.blockDaaScore === 'bigint' ? utxo.blockDaaScore : BigInt(String(utxo.blockDaaScore || '0'))) 
        : 0n,
      isCoinbase: utxo.isCoinbase !== undefined ? Boolean(utxo.isCoinbase) : false
    });
  }
  
  // Create transaction with properly formatted inputs
  let tx;
  try {
    tx = kaspa.createTransaction(
      formattedInputs,
      transactionData.outputs,
      typeof transactionData.fee === 'bigint' ? transactionData.fee : BigInt(String(transactionData.fee))
    );
  } catch (err) {
    throw new Error(`Failed to create transaction: ${err.message || String(err)}`);
  }
  
  if (!tx) {
    throw new Error('Failed to create transaction: transaction object is null');
  }
  
  // Log transaction details before applying signatures
  console.log(`[Coinjoin] Transaction details: ${tx.inputs.length} inputs, ${tx.outputs.length} outputs`);
  console.log(`[Coinjoin] Collected ${allSignatures.length} signatures from ${transactionData.sessionIds.length} sessions`);
  
  // CRITICAL: The signatures were created using signTransaction (same as sendFromWallet)
  // They should already be in the correct format with proper signature script encoding
  // Just apply them directly - they're already properly formatted
  
  // Sort signatures by inputIndex to ensure correct order
  const sortedSignatures = [...allSignatures].sort((a, b) => {
    const aIdx = a.inputIndex !== undefined ? a.inputIndex : (a.index !== undefined ? a.index : 0);
    const bIdx = b.inputIndex !== undefined ? b.inputIndex : (b.index !== undefined ? b.index : 0);
    return aIdx - bIdx;
  });
  
  console.log(`[Coinjoin] Applying ${sortedSignatures.length} signatures to transaction with ${tx.inputs.length} inputs`);
  
  // Apply signatures - they're already in the correct format from signTransaction
  for (let i = 0; i < sortedSignatures.length && i < tx.inputs.length; i++) {
    const signature = sortedSignatures[i];
    const signatureScript = signature.signature || signature.signatureScript || signature;
    const inputIndex = signature.inputIndex !== undefined ? signature.inputIndex : (signature.index !== undefined ? signature.index : i);
    
    if (inputIndex >= tx.inputs.length) {
      console.warn(`[Coinjoin] Signature input index ${inputIndex} out of range (transaction has ${tx.inputs.length} inputs)`);
      continue;
    }
    
    try {
      // Convert signature to hex string if needed
      let signatureHex = typeof signatureScript === 'string' ? signatureScript : String(signatureScript);
      
      if (!signatureHex || signatureHex.length === 0) {
        console.warn(`[Coinjoin] Signature for input ${inputIndex} is empty`);
        continue;
      }
      
      // Set signatureScript directly
      // These signatures were created using signTransaction, so they're in the correct format
      tx.inputs[inputIndex].signatureScript = signatureHex;
      console.log(`[Coinjoin] Applied signature to input ${inputIndex}, length: ${signatureHex.length} chars (from signTransaction)`);
    } catch (err) {
      throw new Error(`Failed to apply signature to input ${inputIndex}: ${err.message || String(err)}`);
    }
  }
  
  // Finalize transaction to recompute transaction ID with signatures
  try {
    tx.finalize();
    console.log(`[Coinjoin] Transaction finalized with ID: ${tx.id}`);
  } catch (err) {
    console.warn(`[Coinjoin] Warning: Failed to finalize transaction: ${err.message || String(err)}`);
    // Continue anyway - RPC might handle it
  }
  
  // Check transaction mass before submission
  // Note: Storage mass (used by RPC) may differ from consensus mass
  // We'll try to calculate it, but RPC will validate storage mass
  try {
    const maxMass = kaspa.maximumStandardTransactionMass();
    let transactionMass;
    
    console.log(`[Coinjoin] Checking transaction mass (max: ${Number(maxMass)})`);
    console.log(`[Coinjoin] Transaction has ${tx.inputs.length} inputs, ${tx.outputs.length} outputs`);
    
    // Try to get mass from transaction object if available
    if (tx.mass !== undefined && tx.mass !== null && tx.mass !== 0n) {
      transactionMass = typeof tx.mass === 'bigint' ? tx.mass : BigInt(String(tx.mass));
      console.log(`[Coinjoin] Transaction mass from tx.mass property: ${Number(transactionMass)}`);
    }
    
    // Calculate mass if not available from property
    if (!transactionMass || transactionMass === 0n) {
      try {
        // Try different network ID formats
        const networkId = KASPA_NETWORK === 'mainnet' ? 'mainnet' : (KASPA_NETWORK === 'testnet' ? 'testnet' : KASPA_NETWORK);
        transactionMass = kaspa.calculateTransactionMass(networkId, tx);
        console.log(`[Coinjoin] Calculated transaction mass: ${Number(transactionMass)}`);
      } catch (massErr) {
        console.warn(`[Coinjoin] Could not calculate transaction mass: ${massErr.message}`);
        console.warn(`[Coinjoin] Stack: ${massErr.stack}`);
        // Estimate based on inputs/outputs (rough approximation)
        // Each input with signature: ~3000-5000 mass, each output: ~100-200 mass
        const estimatedMass = (tx.inputs.length * 4000) + (tx.outputs.length * 150);
        console.warn(`[Coinjoin] Estimated mass: ${estimatedMass} (rough approximation)`);
        transactionMass = BigInt(estimatedMass);
      }
    }
    
    if (transactionMass !== undefined && transactionMass !== 0n) {
      const massNum = Number(transactionMass);
      const maxMassNum = Number(maxMass);
      const massPercent = (massNum / maxMassNum) * 100;
      
      console.log(`[Coinjoin] Transaction mass: ${massNum} / ${maxMassNum} (${massPercent.toFixed(1)}%)`);
      
      if (transactionMass > maxMass) {
        throw new Error(
          `Transaction mass (${massNum}) exceeds maximum allowed size (${maxMassNum}). ` +
          `Transaction has ${formattedInputs.length} inputs and ${transactionData.outputs.length} outputs. ` +
          `Consider reducing the number of participants or UTXOs per participant. ` +
          `Note: With ${transactionData.participants} participants, the transaction may be too large.`
        );
      }
      
      if (massPercent > 80) {
        console.warn(`[Coinjoin] Warning: Transaction mass is ${massPercent.toFixed(1)}% of maximum. Close to limit.`);
      }
    } else {
      // If we can't calculate mass, use a rough estimate based on transaction structure
      const estimatedMass = (tx.inputs.length * 4000) + (tx.outputs.length * 150);
      console.warn(`[Coinjoin] Could not get accurate mass, using estimate: ${estimatedMass}`);
      if (estimatedMass > Number(maxMass)) {
        throw new Error(
          `Estimated transaction mass (${estimatedMass}) exceeds maximum allowed size (${Number(maxMass)}). ` +
          `Transaction has ${tx.inputs.length} inputs and ${tx.outputs.length} outputs. ` +
          `With ${transactionData.participants} participants, the transaction is likely too large. ` +
          `Consider reducing participants or UTXOs per participant.`
        );
      }
    }
  } catch (massCheckErr) {
    // If mass check fails, log but continue - RPC will reject if too large
    console.error(`[Coinjoin] Mass validation error: ${massCheckErr.message}`);
    // If it's an error about exceeding limit, throw it
    if (massCheckErr.message && massCheckErr.message.includes('exceeds maximum')) {
      throw massCheckErr;
    }
  }
  
  // Submit transaction with sequence lock retry logic
  // Sequence locks prevent transactions from being accepted until UTXOs are mature enough
  // We retry with exponential backoff if we get a sequence lock error
  const MAX_RETRIES = 3;
  const INITIAL_DELAY_MS = 1000; // 1 second
  const MAX_DELAY_MS = 5000; // 5 seconds
  
  let lastError = null;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await rpc.submitTransaction({ transaction: tx });
      
      if (!result || !result.transactionId) {
        throw new Error('RPC returned invalid response: missing transactionId');
      }
      
      console.log(`[Coinjoin] Transaction submitted successfully: ${result.transactionId}`);
      
      // Clear pending transaction data from all sessions
      for (const sessionId of transactionData.sessionIds) {
        const session = await getSession(sessionId);
        if (session) {
          session.status = 'completed';
          session.coinjoinTxId = result.transactionId;
          session.completedAt = Date.now();
          session.updatedAt = Date.now();
          // Clear pending transaction data
          delete session.pendingTransaction;
          await setSession(sessionId, session);
        }
      }
      
      return {
        success: true,
        transactionId: result.transactionId,
        participants: transactionData.participants
      };
    } catch (err) {
      lastError = err;
      const errorMsg = err.message || err.toString() || String(err) || 'Unknown error';
      
      // Check if this is a sequence lock error
      const isSequenceLockError = errorMsg.includes('sequence locks') || 
                                  errorMsg.includes('sequence lock') ||
                                  errorMsg.includes('lock conditions') ||
                                  errorMsg.includes('lock time');
      
      if (isSequenceLockError && attempt < MAX_RETRIES - 1) {
        // Calculate delay with exponential backoff
        const delay = Math.min(
          INITIAL_DELAY_MS * Math.pow(2, attempt),
          MAX_DELAY_MS
        );
        
        console.log(`[Coinjoin] Sequence lock detected (attempt ${attempt + 1}/${MAX_RETRIES}), waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue; // Retry
      }
      
      // Not a sequence lock error, or we've exhausted retries - throw immediately
      console.error('[Coinjoin] Submit transaction error:', {
        message: err.message,
        stack: err.stack,
        name: err.name,
        raw: err,
        attempt: attempt + 1,
        maxRetries: MAX_RETRIES
      });
      throw new Error(`Failed to submit transaction: ${errorMsg}`);
    }
  }
  
  // Should never reach here, but just in case
  throw new Error(`Failed to submit transaction after ${MAX_RETRIES} attempts: ${lastError?.message || 'Unknown error'}`);
}

module.exports = {
  createCoinjoinSession,
  getAllCoinjoinSessions,
  getCoinjoinSessionsByStatus,
  revealUtxosForCoinjoin,
  buildZeroTrustCoinjoinTransaction,
  signCoinjoinInputs,
  submitSignedCoinjoinTransaction,
  storeCoinjoinSignatures,
  getCoinjoinSignatures,
  monitorCoinjoinDeposits,
  checkAndTriggerCoinjoinBatch,
  processTrustedCoinjoinBatch,
  getCoinjoinStats,
  FIXED_ENTRY_AMOUNT,
  MIN_ZERO_TRUST_PARTICIPANTS,
  MIN_TRUSTED_PARTICIPANTS,
};

