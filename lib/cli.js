// CLI interface

const readline = require('readline');
const { createSession, getSession, getAllSessions } = require('./session-manager');
const { deleteSession } = require('./database');
const { checkNodeStatus } = require('./rpc-client');
const { kaspa, KASPA_NETWORK } = require('./config');
const { importPrivateKey, getWalletInfo, getWalletBalance, sendFromWallet, removeWallet } = require('./wallet');
const {
  createCoinjoinSession,
  getAllCoinjoinSessions,
  getCoinjoinStats,
  revealUtxosForCoinjoin,
  buildZeroTrustCoinjoinTransaction,
  FIXED_ENTRY_AMOUNT,
  MIN_ZERO_TRUST_PARTICIPANTS,
  MIN_TRUSTED_PARTICIPANTS
} = require('./services/coinjoin');

// Helper function to convert private key to hex string
function getPrivateKeyHex(privateKey) {
  if (!privateKey) return null;
  if (typeof privateKey === 'string') return privateKey;
  if (privateKey && typeof privateKey.toString === 'function') {
    return privateKey.toString();
  }
  return String(privateKey);
}

// Helper function to hide private keys from display
function hidePrivateKeys(session) {
  const { depositPrivateKey, intermediatePrivateKey, ...publicSession } = session;
  return publicSession;
}

// Handler for 'create' command
function handleCreate(rl) {
  console.log('\nCreating new mixing session...');
  console.log('Enter destination addresses (one per line, format: address:amount_kas)');
  console.log('Example: kaspa:qxxx:1.5 (for 1.5 KAS)');
  console.log('Maximum 10 destinations allowed. Type "done" when finished');
  
  const MAX_DESTINATIONS = 10;
  const destinations = [];
  
  const readDest = () => {
    rl.question('', (input) => {
      if (input.toLowerCase() === 'done') {
        if (destinations.length === 0) {
          console.log('No destinations added');
          rl.prompt();
          return;
        }
        const total = destinations.reduce((sum, d) => sum + Number(d.amount), 0);
        createSession(destinations, total).then(session => {
          const publicSession = hidePrivateKeys(session);
          console.log(`\n✓ Session created!`);
          console.log(`  Session ID: ${publicSession.id}`);
          console.log(`  Deposit Address: ${publicSession.depositAddress}`);
          console.log(`  Amount: ${(publicSession.amount / 1e8).toFixed(8)} KAS`);
          console.log(`\nSend ${(publicSession.amount / 1e8).toFixed(8)} KAS to the deposit address above.`);
          rl.prompt();
        }).catch(err => {
          console.error(`\n✗ Error creating session: ${err.message}`);
          rl.prompt();
        });
      } else {
        if (destinations.length >= MAX_DESTINATIONS) {
          console.log(`✗ Maximum ${MAX_DESTINATIONS} destinations allowed. Type "done" to finish.`);
          readDest();
          return;
        }
        const parts = input.split(':');
        if (parts.length >= 2) {
          const address = parts.slice(0, -1).join(':');
          const amountKAS = parts[parts.length - 1];
          
          if (!address.trim() || !address.startsWith('kaspa:')) {
            console.log('⚠ Invalid address format. Address should start with "kaspa:"');
            readDest();
            return;
          }
          
          const amountKASNum = parseFloat(amountKAS);
          if (isNaN(amountKASNum) || amountKASNum <= 0) {
            console.log('⚠ Invalid amount. Must be a positive number in KAS.');
            readDest();
            return;
          }
          
          const amountSompi = Math.round(amountKASNum * 1e8);
          if (amountSompi < 1000) {
            console.log('⚠ Amount too small. Minimum is 0.00001 KAS (dust threshold).');
            readDest();
            return;
          }
          
          destinations.push({ address: address.trim(), amount: amountSompi.toString() });
          console.log(`✓ Added: ${address.trim()} - ${amountKASNum.toFixed(8)} KAS (${amountSompi.toLocaleString()} sompi) [${destinations.length}/${MAX_DESTINATIONS}]`);
        } else {
          console.log('⚠ Invalid format. Use: address:amount_kas (e.g., kaspa:qxxx:1.5)');
        }
        readDest();
      }
    });
  };
  readDest();
}

// Handler for 'status' command
async function handleStatus(rl, args) {
  const sessionId = args[0];
  if (!sessionId) {
    console.log('Usage: status <session-id>');
    rl.prompt();
    return;
  }
  const session = await getSession(sessionId);
  if (!session) {
    console.log('Session not found');
  } else {
    const publicSession = hidePrivateKeys(session);
    console.log(`\nSession: ${publicSession.id}`);
    console.log(`Status: ${publicSession.status}`);
    console.log(`Deposit Address: ${publicSession.depositAddress}`);
    console.log(`Amount: ${(publicSession.amount / 1e8).toFixed(8)} KAS`);
    
    if (publicSession.intermediateAddress) {
      console.log(`Intermediate Address: ${publicSession.intermediateAddress}`);
      if (publicSession.intermediateTxId) {
        console.log(`Intermediate TX: ${publicSession.intermediateTxId}`);
      }
    }
    
    if (publicSession.payoutTxIds && publicSession.payoutTxIds.length > 0) {
      console.log(`Payout TX: ${publicSession.payoutTxIds[0]}`);
    }
    
    if (publicSession.error) {
      console.log(`Error: ${publicSession.error}`);
    }
    
    if (publicSession.destinations) {
      console.log(`Destinations: ${publicSession.destinations.length}`);
      publicSession.destinations.forEach((d, i) => {
        console.log(`  ${i + 1}. ${d.address} - ${(d.amount / 1e8).toFixed(8)} KAS`);
      });
    }
  }
  rl.prompt();
}

// Handler for 'list' command
async function handleList(rl) {
  const sessions = await getAllSessions();
  console.log(`\nTotal sessions: ${sessions.length}`);
  sessions.forEach(({ sessionId, session }) => {
    console.log(`  ${sessionId}: ${session.status} - ${(session.amount / 1e8).toFixed(8)} KAS`);
  });
  rl.prompt();
}

// Handler for 'key' command
async function handleKey(rl, args) {
  const sessionId = args[0];
  if (!sessionId) {
    console.log('Usage: key <session-id>');
    console.log('   or: export-key <session-id>');
    rl.prompt();
    return;
  }
  const session = await getSession(sessionId);
  if (!session) {
    console.log('Session not found');
    rl.prompt();
    return;
  }
  
  console.log(`\n📋 Private Keys for Session: ${session.id}`);
  console.log(`   Status: ${session.status}`);
  console.log(`   Amount: ${(session.amount / 1e8).toFixed(8)} KAS\n`);
  
  if (session.depositPrivateKey) {
    const depositKeyHex = getPrivateKeyHex(session.depositPrivateKey);
    console.log('🔐 Deposit Private Key:');
    console.log(`   ${depositKeyHex}`);
    if (session.depositAddress) {
      console.log(`   Address: ${session.depositAddress}`);
    }
    console.log('');
  } else {
    console.log('⚠ Deposit private key not found\n');
  }
  
  if (session.intermediatePrivateKey) {
    const intermediateKeyHex = getPrivateKeyHex(session.intermediatePrivateKey);
    console.log('🔐 Intermediate Private Key:');
    console.log(`   ${intermediateKeyHex}`);
    if (session.intermediateAddress) {
      console.log(`   Address: ${session.intermediateAddress}`);
    }
    console.log('');
  }
  
  console.log('⚠ WARNING: Keep these private keys secure!');
  console.log('   Anyone with access to these keys can spend funds.\n');
  rl.prompt();
}

// Handler for 'delete' command
async function handleDelete(rl, args) {
  const sessionId = args[0];
  if (!sessionId) {
    console.log('Usage: delete <session-id>');
    console.log('   or: remove <session-id>');
    console.log('   or: del <session-id>');
    rl.prompt();
    return;
  }
  const session = await getSession(sessionId);
  if (!session) {
    console.log('Session not found');
    rl.prompt();
    return;
  }
  
  console.log(`\n⚠ Session to be deleted:`);
  console.log(`   ID: ${session.id}`);
  console.log(`   Status: ${session.status}`);
  console.log(`   Amount: ${(session.amount / 1e8).toFixed(8)} KAS`);
  if (session.depositAddress) {
    console.log(`   Deposit Address: ${session.depositAddress}`);
  }
  console.log('');
  console.log('⚠ WARNING: This will permanently delete the session and all associated data!');
  console.log('   Make sure to export private keys first if you need them for backup.');
  console.log('');
  
  rl.question('Type "yes" to confirm deletion: ', async (answer) => {
    if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
      try {
        await deleteSession(sessionId);
        console.log(`\n✓ Session ${sessionId} deleted successfully.`);
      } catch (err) {
        console.error(`\n✗ Error deleting session: ${err.message}`);
      }
    } else {
      console.log('Deletion cancelled.');
    }
    rl.prompt();
  });
}

// Handler for 'tx' command
async function handleTx(rl, args) {
  const txId = args[0];
  if (!txId) {
    console.log('Usage: tx <transaction-id>');
    console.log('   or: transaction <transaction-id>');
    rl.prompt();
    return;
  }
  
  const sessions = await getAllSessions();
  let found = false;
  
  for (const { sessionId, session } of sessions) {
    if (session.intermediateTxId === txId) {
      console.log(`\n✓ Found session with intermediate transaction:`);
      console.log(`  Session ID: ${sessionId}`);
      console.log(`  Status: ${session.status}`);
      console.log(`  Deposit: ${(session.amount / 1e8).toFixed(8)} KAS`);
      console.log(`  Intermediate TX: ${txId}`);
      if (session.intermediateAddress) {
        console.log(`  Intermediate Address: ${session.intermediateAddress}`);
      }
      if (session.payoutTxIds && session.payoutTxIds.length > 0) {
        console.log(`  Payout TX: ${session.payoutTxIds[0]}`);
      }
      if (session.error) {
        console.log(`  Error: ${session.error}`);
      }
      found = true;
      break;
    }
    
    if (session.payoutTxIds && session.payoutTxIds.includes(txId)) {
      console.log(`\n✓ Found session with payout transaction:`);
      console.log(`  Session ID: ${sessionId}`);
      console.log(`  Status: ${session.status}`);
      console.log(`  Payout TX: ${txId}`);
      if (session.destinations) {
        console.log(`  Destinations: ${session.destinations.length}`);
        session.destinations.forEach((d, i) => {
          console.log(`    ${i + 1}. ${d.address} - ${(d.amount / 1e8).toFixed(8)} KAS`);
        });
      }
      found = true;
      break;
    }
  }
  
  if (!found) {
    console.log(`\nTransaction ${txId} not found in any session.`);
    console.log('This might be:');
    console.log('  - A transaction from outside the mixer');
    console.log('  - A transaction from a deleted session');
    console.log('  - Check kas.fyi for transaction details');
  }
  
  rl.prompt();
}

// Handler for 'find' command
async function handleFind(rl, args) {
  const address = args.join(' ');
  if (!address) {
    console.log('Usage: find <deposit-address>');
    console.log('   or: search <deposit-address>');
    rl.prompt();
    return;
  }
  
  const sessions = await getAllSessions();
  let found = false;
  
  for (const { sessionId, session } of sessions) {
    if (session.depositAddress && session.depositAddress.toLowerCase() === address.toLowerCase()) {
      console.log(`\n✓ Found session with deposit address:`);
      console.log(`  Session ID: ${sessionId}`);
      console.log(`  Status: ${session.status}`);
      console.log(`  Deposit Address: ${session.depositAddress}`);
      console.log(`  Amount: ${(session.amount / 1e8).toFixed(8)} KAS`);
      
      if (session.intermediateAddress) {
        console.log(`  Intermediate Address: ${session.intermediateAddress}`);
      }
      if (session.intermediateTxId) {
        console.log(`  Intermediate TX: ${session.intermediateTxId}`);
      }
      if (session.payoutTxIds && session.payoutTxIds.length > 0) {
        console.log(`  Payout TX: ${session.payoutTxIds[0]}`);
      }
      if (session.error) {
        console.log(`  Error: ${session.error}`);
      }
      if (session.destinations) {
        console.log(`  Destinations: ${session.destinations.length}`);
        session.destinations.forEach((d, i) => {
          console.log(`    ${i + 1}. ${d.address} - ${(d.amount / 1e8).toFixed(8)} KAS`);
        });
      }
      found = true;
      break;
    }
  }
  
  if (!found) {
    console.log(`\nNo session found with deposit address: ${address}`);
    console.log('This might be:');
    console.log('  - A session that was deleted');
    console.log('  - An address that doesn\'t belong to this mixer');
    console.log('  - Check the exact address (case-sensitive)');
  }
  
  rl.prompt();
}

// Handler for 'recover' command
async function handleRecover(rl, args) {
  const sessionId = args[0];
  if (!sessionId) {
    console.log('Usage: recover <session-id>');
    rl.prompt();
    return;
  }
  
  const session = await getSession(sessionId);
  if (!session) {
    console.log('Session not found');
    rl.prompt();
    return;
  }
  
  console.log(`\nRecovering session ${sessionId}...`);
  console.log(`Current status: ${session.status}`);
  
  const { recoverDepositAddress, recoverIntermediateAddress, getIntermediateAddresses } = require('./services/session-recovery');
  
  let recovered = false;
  
  // Recover deposit address
  try {
    const depositResult = await recoverDepositAddress(sessionId, session);
    if (depositResult.recovered) {
      recovered = true;
    }
  } catch (err) {
    console.error('Error checking deposit address:', err.message);
  }
  
  // Recover intermediate addresses
  const intermediateAddresses = getIntermediateAddresses(session);
  for (const intAddr of intermediateAddresses) {
    try {
      const intResult = await recoverIntermediateAddress(sessionId, session, intAddr);
      if (intResult.recovered) {
        recovered = true;
      }
    } catch (err) {
      console.error(`Error checking intermediate address ${intAddr}:`, err.message);
    }
  }
  
  if (!recovered) {
    console.log('\n⚠ Could not automatically recover session state.');
    console.log('Current status:', session.status);
    if (session.error) {
      console.log('Error:', session.error);
    }
  }
  
  rl.prompt();
}

// Handler for 'wallet' command
function handleWallet(rl, args) {
  const subCmd = args[0];
  
  if (subCmd === 'import') {
    const privateKeyHex = args.slice(1).join(' ');
    if (!privateKeyHex) {
      console.log('Usage: wallet import <private_key_hex>');
      console.log('   or: wallet import (will prompt for private key)');
      rl.question('\nEnter private key (hex format): ', async (input) => {
        const key = input.trim();
        if (!key) {
          console.log('No private key provided.');
          rl.prompt();
          return;
        }
        try {
          const wallet = importPrivateKey(key);
          console.log(`\n✓ Wallet imported successfully!`);
          console.log(`  Address: ${wallet.address}`);
          console.log(`\n⚠ WARNING: Keep your private key secure!`);
        } catch (err) {
          console.error(`\n✗ Error importing wallet: ${err.message}`);
        }
        rl.prompt();
      });
    } else {
      try {
        const wallet = importPrivateKey(privateKeyHex);
        console.log(`\n✓ Wallet imported successfully!`);
        console.log(`  Address: ${wallet.address}`);
        console.log(`\n⚠ WARNING: Keep your private key secure!`);
      } catch (err) {
        console.error(`\n✗ Error importing wallet: ${err.message}`);
      }
      rl.prompt();
    }
  } else if (subCmd === 'balance') {
    getWalletBalance().then(balance => {
      console.log(`\n💰 Wallet Balance:`);
      console.log(`  Confirmed: ${(Number(balance.confirmed) / 1e8).toFixed(8)} KAS`);
      if (balance.unconfirmed > 0n) {
        console.log(`  Unconfirmed: ${(Number(balance.unconfirmed) / 1e8).toFixed(8)} KAS`);
      }
      console.log(`  Total: ${(Number(balance.total) / 1e8).toFixed(8)} KAS`);
      console.log(`  UTXOs: ${balance.utxoCount}`);
      rl.prompt();
    }).catch(err => {
      console.error(`\n✗ Error: ${err.message}`);
      rl.prompt();
    });
  } else if (subCmd === 'send') {
    const toAddress = args[1];
    const amountKAS = parseFloat(args[2]);
    
    if (!toAddress || isNaN(amountKAS) || amountKAS <= 0) {
      console.log('Usage: wallet send <address> <amount_kas>');
      console.log('Example: wallet send kaspa:qxxx... 1.5');
      rl.prompt();
      return;
    }
    
    sendFromWallet(toAddress, amountKAS).then(result => {
      console.log(`\n✓ Transaction sent successfully!`);
      console.log(`  TX ID: ${result.txId}`);
      console.log(`  Amount: ${result.amount.toFixed(8)} KAS`);
      console.log(`  Fee: ${result.fee.toFixed(8)} KAS`);
      if (result.change > 0) {
        console.log(`  Change: ${result.change.toFixed(8)} KAS`);
      }
      console.log(`\nView on explorer: https://kas.fyi/transaction/${result.txId}`);
      rl.prompt();
    }).catch(err => {
      console.error(`\n✗ Error sending transaction: ${err.message}`);
      rl.prompt();
    });
  } else if (subCmd === 'info') {
    const wallet = getWalletInfo();
    if (!wallet) {
      console.log('\nNo wallet imported. Use "wallet import" to import your private key.');
    } else {
      console.log(`\n📋 Wallet Info:`);
      console.log(`  Address: ${wallet.address}`);
      console.log(`  Imported: ${wallet.importedAt}`);
    }
    rl.prompt();
  } else if (subCmd === 'remove' || subCmd === 'delete') {
    rl.question('\n⚠ WARNING: This will delete your imported wallet private key!\nType "yes" to confirm: ', (answer) => {
      if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
        try {
          const removed = removeWallet();
          if (removed) {
            console.log('\n✓ Wallet removed successfully.');
          } else {
            console.log('\nNo wallet to remove.');
          }
        } catch (err) {
          console.error(`\n✗ Error removing wallet: ${err.message}`);
        }
      } else {
        console.log('Cancelled.');
      }
      rl.prompt();
    });
  } else {
    console.log('Usage: wallet <command>');
    console.log('  import <private_key_hex> - Import your wallet private key');
    console.log('  balance - Check wallet balance');
    console.log('  send <address> <amount_kas> - Send funds from wallet');
    console.log('  info - Show wallet info');
    console.log('  remove - Remove imported wallet');
    rl.prompt();
  }
}

// Handler for 'node' command
async function handleNode(rl) {
  await checkNodeStatus();
  rl.prompt();
}

// Handler for 'coinjoin' command
async function handleCoinjoin(rl, args) {
  const subCmd = args[0];
  
  if (subCmd === 'create' || subCmd === 'new') {
    await handleCoinjoinCreate(rl, args.slice(1));
  } else if (subCmd === 'status' || subCmd === 'info') {
    await handleCoinjoinStatus(rl, args.slice(1));
  } else if (subCmd === 'list' || subCmd === 'ls') {
    await handleCoinjoinList(rl);
  } else if (subCmd === 'reveal') {
    await handleCoinjoinReveal(rl, args.slice(1));
  } else if (subCmd === 'build') {
    await handleCoinjoinBuild(rl, args.slice(1));
  } else if (subCmd === 'stats') {
    await handleCoinjoinStats(rl);
  } else if (subCmd === 'ws:info' || subCmd === 'ws-info') {
    await handleCoinjoinWebSocketInfo(rl);
  } else if (subCmd === 'ws:start' || subCmd === 'ws-start') {
    await handleCoinjoinWebSocketStart(rl, args.slice(1));
  } else if (subCmd === 'ws:stop' || subCmd === 'ws-stop') {
    await handleCoinjoinWebSocketStop(rl);
  } else {
    console.log('\nCoinjoin Commands:');
    console.log('  coinjoin create <mode> <destination> - Create coinjoin session');
    console.log('    modes: trusted (default) or zero-trust');
    console.log('  coinjoin status <id> - Check coinjoin session status');
    console.log('  coinjoin list - List all coinjoin sessions');
    console.log('  coinjoin reveal <id> - Reveal UTXOs for zero-trust coinjoin');
    console.log('  coinjoin build <id1,id2,id3...> - Build zero-trust coinjoin transaction');
    console.log('  coinjoin stats - Show coinjoin statistics');
    console.log('  coinjoin ws:info - Show WebSocket server status');
    console.log('  coinjoin ws:start [port] - Start WebSocket server');
    console.log('  coinjoin ws:stop - Stop WebSocket server');
    rl.prompt();
  }
}

// Handler for 'coinjoin create'
async function handleCoinjoinCreate(rl, args) {
  const mode = args[0] || 'trusted';
  const destination = args[1];
  
  if (!destination) {
    console.log('\nUsage: coinjoin create [trusted|zero-trust] <destination-address>');
    console.log('Example: coinjoin create trusted kaspa:qz...');
    console.log('Example: coinjoin create zero-trust kaspa:qz...');
    rl.prompt();
    return;
  }
  
  if (mode === 'zero-trust' || mode === 'zerotrust') {
    console.log('\n⚠ Zero-trust coinjoin mode');
    console.log('You will need to provide UTXOs directly.');
    console.log('This requires wallet integration or manual UTXO selection.');
    rl.question('\nDo you have UTXOs ready? (y/N): ', async (answer) => {
      if (answer.toLowerCase() !== 'y') {
        console.log('Zero-trust coinjoin requires UTXOs. Please prepare them first.');
        rl.prompt();
        return;
      }
      
      // For CLI, we'll create a placeholder session
      // In practice, users would provide UTXOs via wallet integration
      console.log('\n⚠ Note: Zero-trust coinjoin requires UTXOs.');
      console.log('For now, creating session without UTXOs (will need to be completed later).');
      console.log('Use GUI or wallet integration for full zero-trust support.');
      rl.prompt();
    });
  } else {
    // Trusted mode
    console.log('\n⚠ Trusted coinjoin mode');
    console.log('This mode requires a pool wallet address and private key.');
    console.log('The pool wallet will hold funds temporarily.');
    rl.question('\nPool wallet address: ', async (poolAddress) => {
      if (!poolAddress || !poolAddress.startsWith('kaspa:')) {
        console.log('Invalid pool wallet address');
        rl.prompt();
        return;
      }
      
      rl.question('Pool private key (hex): ', async (poolKey) => {
        if (!poolKey || poolKey.length !== 64) {
          console.log('Invalid pool private key (must be 64 hex characters)');
          rl.prompt();
          return;
        }
        
        try {
          const session = await createCoinjoinSession(destination, {
            zeroTrustMode: false,
            poolWalletAddress: poolAddress,
            poolPrivateKey: poolKey
          });
          
          console.log(`\n✓ Coinjoin session created!`);
          console.log(`  Session ID: ${session.id}`);
          console.log(`  Deposit Address: ${session.depositAddress}`);
          console.log(`  Mode: Trusted`);
          console.log(`  Amount: 1 KAS (fixed entry)`);
          console.log(`\nSend exactly 1 KAS to: ${session.depositAddress}`);
        } catch (err) {
          console.error(`\n✗ Error: ${err.message}`);
        }
        rl.prompt();
      });
    });
  }
}

// Handler for 'coinjoin status'
async function handleCoinjoinStatus(rl, args) {
  const sessionId = args[0];
  if (!sessionId) {
    console.log('Usage: coinjoin status <session-id>');
    rl.prompt();
    return;
  }
  
  const session = await getSession(sessionId);
  if (!session || session.type !== 'coinjoin') {
    console.log('Coinjoin session not found');
    rl.prompt();
    return;
  }
  
  console.log(`\n📋 Coinjoin Session: ${session.id}`);
  console.log(`  Status: ${session.status}`);
  console.log(`  Mode: ${session.zeroTrustMode ? 'Zero-Trust' : 'Trusted'}`);
  console.log(`  Created: ${new Date(session.createdAt).toLocaleString()}`);
  
  if (session.zeroTrustMode) {
    console.log(`  Commitments: ${session.utxoCommitments?.length || 0}`);
    if (session.status === 'revealed') {
      console.log(`  Revealed UTXOs: ${session.revealedUtxos?.length || 0}`);
    }
  } else {
    if (session.depositAddress) {
      console.log(`  Deposit Address: ${session.depositAddress}`);
    }
    if (session.amount) {
      console.log(`  Amount: ${(Number(session.amount) / 1e8).toFixed(8)} KAS`);
    }
    if (session.txId) {
      console.log(`  Forward TX: ${session.txId}`);
    }
  }
  
  if (session.destinationAddress) {
    console.log(`  Destination: ${session.destinationAddress}`);
  }
  
  if (session.error) {
    console.log(`  Error: ${session.error}`);
  }
  
  rl.prompt();
}

// Handler for 'coinjoin list'
async function handleCoinjoinList(rl) {
  const sessions = await getAllCoinjoinSessions();
  
  if (sessions.length === 0) {
    console.log('\nNo coinjoin sessions found.');
    rl.prompt();
    return;
  }
  
  console.log(`\n📋 Coinjoin Sessions (${sessions.length}):`);
  console.log('');
  
  const trusted = sessions.filter(s => !s.session.zeroTrustMode);
  const zeroTrust = sessions.filter(s => s.session.zeroTrustMode);
  
  if (trusted.length > 0) {
    console.log('Trusted Mode:');
    trusted.forEach(({ sessionId, session }) => {
      console.log(`  ${sessionId.substring(0, 20)}... | ${session.status.padEnd(15)} | ${session.depositAddress ? 'Deposit ready' : 'Waiting'}`);
    });
  }
  
  if (zeroTrust.length > 0) {
    console.log('\nZero-Trust Mode:');
    zeroTrust.forEach(({ sessionId, session }) => {
      console.log(`  ${sessionId.substring(0, 20)}... | ${session.status.padEnd(15)} | ${session.utxoCommitments?.length || 0} commitments`);
    });
  }
  
  rl.prompt();
}

// Handler for 'coinjoin reveal'
async function handleCoinjoinReveal(rl, args) {
  const sessionId = args[0];
  if (!sessionId) {
    console.log('Usage: coinjoin reveal <session-id>');
    rl.prompt();
    return;
  }
  
  const session = await getSession(sessionId);
  if (!session || !session.zeroTrustMode) {
    console.log('Session not found or not in zero-trust mode');
    rl.prompt();
    return;
  }
  
  console.log('\n⚠ Revealing UTXOs for zero-trust coinjoin');
  console.log('This requires the UTXOs you originally committed to.');
  console.log('Note: This is typically done via wallet integration or WebSocket.');
  console.log('\nFor CLI, you would need to provide:');
  console.log('1. The UTXOs you committed');
  console.log('2. Your destination address');
  console.log('\nUse GUI or wallet integration for full zero-trust support.');
  rl.prompt();
}

// Handler for 'coinjoin build'
async function handleCoinjoinBuild(rl, args) {
  const sessionIdsStr = args[0];
  if (!sessionIdsStr) {
    console.log('Usage: coinjoin build <session-id1,session-id2,session-id3...>');
    console.log(`Minimum ${MIN_ZERO_TRUST_PARTICIPANTS} sessions required for zero-trust coinjoin`);
    rl.prompt();
    return;
  }
  
  const sessionIds = sessionIdsStr.split(',').map(id => id.trim());
  
  try {
    const txData = await buildZeroTrustCoinjoinTransaction(sessionIds);
    
    console.log(`\n✓ Coinjoin transaction built!`);
    console.log(`  Participants: ${txData.participants}`);
    console.log(`  Inputs: ${txData.inputs.length} UTXOs`);
    console.log(`  Outputs: ${txData.outputs.length}`);
    console.log(`  Total Input: ${(Number(txData.totalInput) / 1e8).toFixed(8)} KAS`);
    console.log(`  Total Output: ${(Number(txData.totalOutput) / 1e8).toFixed(8)} KAS`);
    console.log(`  Fee: ${(Number(txData.fee) / 1e8).toFixed(8)} KAS`);
    console.log(`  Equal Output: ${(Number(txData.outputs[0]?.amount || 0) / 1e8).toFixed(8)} KAS per participant`);
    console.log(`\n${txData.message}`);
    console.log('\nNote: Each participant must sign their own inputs.');
    console.log('Use wallet integration or GUI for signing and submission.');
  } catch (err) {
    console.error(`\n✗ Error: ${err.message}`);
  }
  
  rl.prompt();
}

// Handler for 'coinjoin stats'
async function handleCoinjoinStats(rl) {
  try {
    const stats = await getCoinjoinStats();
    
    console.log('\n📊 Coinjoin Statistics:');
    console.log(`  Total Sessions: ${stats.total}`);
    console.log(`\n  Trusted Mode:`);
    console.log(`    Total: ${stats.trusted.total}`);
    console.log(`    Waiting Deposit: ${stats.trusted.waiting}`);
    console.log(`    Entered: ${stats.trusted.entered}`);
    console.log(`    Ready for Batch: ${stats.trusted.ready}`);
    console.log(`    Completed: ${stats.trusted.completed}`);
    console.log(`\n  Zero-Trust Mode:`);
    console.log(`    Total: ${stats.zeroTrust.total}`);
    console.log(`    Committed: ${stats.zeroTrust.committed}`);
    console.log(`    Revealed: ${stats.zeroTrust.revealed}`);
    console.log(`    Completed: ${stats.zeroTrust.completed}`);
    
    if (stats.trusted.entered >= MIN_TRUSTED_PARTICIPANTS) {
      console.log(`\n✓ Ready for trusted batch processing (${stats.trusted.entered} participants)`);
    }
    
    if (stats.zeroTrust.revealed >= MIN_ZERO_TRUST_PARTICIPANTS) {
      console.log(`\n✓ Ready for zero-trust coinjoin (${stats.zeroTrust.revealed} participants)`);
    }
  } catch (err) {
    console.error(`\n✗ Error: ${err.message}`);
  }
  
  rl.prompt();
}

// Handler for 'coinjoin ws:info'
async function handleCoinjoinWebSocketInfo(rl) {
  try {
    const { getWebSocketServerInfo } = require('./services/coinjoin-websocket');
    const info = getWebSocketServerInfo();
    
    console.log('\n📡 Coinjoin WebSocket Server:');
    console.log(`  Status: ${info.running ? 'Running' : 'Stopped'}`);
    if (info.running) {
      console.log(`  Port: ${info.port}`);
      console.log(`  URL: ${info.url}`);
      console.log(`  Lobby Participants: ${info.lobbyParticipants}`);
      console.log(`  Active Rooms: ${info.activeRooms}`);
    } else {
      console.log('  Use "coinjoin ws:start" to start the server');
    }
  } catch (err) {
    console.error(`\n✗ Error: ${err.message}`);
  }
  
  rl.prompt();
}

// Handler for 'coinjoin ws:start'
async function handleCoinjoinWebSocketStart(rl, args) {
  const port = args[0] ? parseInt(args[0], 10) : 8080;
  
  if (isNaN(port) || port < 1 || port > 65535) {
    console.log('\nInvalid port number. Must be between 1 and 65535');
    rl.prompt();
    return;
  }
  
  try {
    const { createCoinjoinWebSocketServer } = require('./services/coinjoin-websocket');
    const server = createCoinjoinWebSocketServer(port);
    
    console.log(`\n✓ WebSocket server started successfully!`);
    console.log(`  URL: ${server.url || `ws://localhost:${server.port}/ws/coinjoin`}`);
    console.log(`  Port: ${server.port}`);
  } catch (err) {
    console.error(`\n✗ Error: ${err.message}`);
  }
  
  rl.prompt();
}

// Handler for 'coinjoin ws:stop'
async function handleCoinjoinWebSocketStop(rl) {
  try {
    const { stopCoinjoinWebSocketServer } = require('./services/coinjoin-websocket');
    stopCoinjoinWebSocketServer();
    console.log('\n✓ WebSocket server stopped');
  } catch (err) {
    console.error(`\n✗ Error: ${err.message}`);
  }
  
  rl.prompt();
}

// Handler for 'help' command
function handleHelp(rl) {
  console.log('\nAvailable commands:');
  console.log('  create - Create new mixing session');
  console.log('  status <id> - Check session status');
  console.log('  list - List all sessions');
  console.log('  tx <txid> - Find session by mixer transaction ID');
  console.log('  find <address> - Find session by deposit address');
  console.log('  recover <id> - Recover session state from blockchain');
  console.log('  key <id> - Export private keys for session (backup/recovery)');
  console.log('  delete <id> - Delete a session (requires confirmation)');
  console.log('  wallet import <private_key_hex> - Import your wallet private key');
  console.log('  wallet balance - Check wallet balance');
  console.log('  wallet send <address> <amount_kas> - Send funds from wallet');
  console.log('  wallet info - Show wallet info');
  console.log('  wallet remove - Remove imported wallet');
  console.log('  coinjoin create [mode] <address> - Create coinjoin session');
  console.log('  coinjoin status <id> - Check coinjoin session');
  console.log('  coinjoin list - List coinjoin sessions');
  console.log('  coinjoin stats - Show coinjoin statistics');
  console.log('  node - Check node status');
  console.log('  exit - Exit mixer\n');
  rl.prompt();
}

function createCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  console.log('=== Kaspa Mixer (Standalone) ===\n');
      console.log('Commands:');
      console.log('  create - Create new mixing session');
      console.log('  status <id> - Check session status');
      console.log('  list - List all sessions');
      console.log('  tx <txid> - Find session by mixer transaction ID');
      console.log('  find <address> - Find session by deposit address');
      console.log('  recover <id> - Recover session state from blockchain');
      console.log('  key <id> - Export private keys for session');
      console.log('  delete <id> - Delete a session');
      console.log('  wallet import <private_key_hex> - Import your wallet private key');
      console.log('  wallet balance - Check wallet balance');
      console.log('  wallet send <address> <amount_kas> - Send funds from wallet');
      console.log('  wallet info - Show wallet info');
      console.log('  wallet remove - Remove imported wallet');
      console.log('  coinjoin create [mode] <address> - Create coinjoin session');
      console.log('  coinjoin status <id> - Check coinjoin session');
      console.log('  coinjoin list - List coinjoin sessions');
      console.log('  coinjoin stats - Show coinjoin statistics');
      console.log('  node - Check node status');
      console.log('  exit - Exit mixer\n');
  
  rl.setPrompt('mixer> ');
  rl.prompt();
  
  rl.on('line', async (line) => {
    const [cmd, ...args] = line.trim().split(' ');
    
    if (cmd === 'exit') {
      console.log('Exiting...');
      rl.close();
      process.exit(0);
    } else if (cmd === 'create') {
      handleCreate(rl);
    } else if (cmd === 'status') {
      await handleStatus(rl, args);
    } else if (cmd === 'list') {
      await handleList(rl);
    } else if (cmd === 'key' || cmd === 'export-key') {
      await handleKey(rl, args);
    } else if (cmd === 'delete' || cmd === 'remove' || cmd === 'del') {
      await handleDelete(rl, args);
    } else if (cmd === 'tx' || cmd === 'transaction') {
      await handleTx(rl, args);
    } else if (cmd === 'find' || cmd === 'search') {
      await handleFind(rl, args);
    } else if (cmd === 'recover') {
      await handleRecover(rl, args);
    } else if (cmd === 'wallet') {
      handleWallet(rl, args);
    } else if (cmd === 'node') {
      await handleNode(rl);
    } else if (cmd === 'coinjoin' || cmd === 'cj') {
      await handleCoinjoin(rl, args);
    } else if (cmd === 'help') {
      handleHelp(rl);
    } else if (cmd === '') {
      rl.prompt();
    } else {
      console.log('Unknown command. Type "help" for commands.');
      rl.prompt();
    }
  });
}

module.exports = {
  createCLI,
};
