// CLI interface

const readline = require('readline');
const { createSession, getSession, getAllSessions } = require('./session-manager');
const { deleteSession } = require('./database');
const { checkNodeStatus } = require('./rpc-client');
const { kaspa, KASPA_NETWORK } = require('./config');
const { importPrivateKey, getWalletInfo, getWalletBalance, sendFromWallet, removeWallet } = require('./wallet');

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
            // Sum in sompi (amounts are already converted)
            const total = destinations.reduce((sum, d) => sum + Number(d.amount), 0);
            createSession(destinations, total).then(session => {
              // Hide private key from user display (security)
              const { depositPrivateKey, intermediatePrivateKey, ...publicSession } = session;
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
              // Reconstruct address (may contain colons), amount is last part
              const address = parts.slice(0, -1).join(':'); // Everything except last part
              const amountKAS = parts[parts.length - 1]; // Last part is amount
              
              // Validate address format
              if (!address.trim() || !address.startsWith('kaspa:')) {
                console.log('⚠ Invalid address format. Address should start with "kaspa:"');
                readDest();
                return;
              }
              
              // Validate and convert KAS to sompi
              const amountKASNum = parseFloat(amountKAS);
              if (isNaN(amountKASNum) || amountKASNum <= 0) {
                console.log('⚠ Invalid amount. Must be a positive number in KAS.');
                readDest();
                return;
              }
              
              // Convert KAS to sompi (1 KAS = 100,000,000 sompi)
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
    } else if (cmd === 'status') {
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
            // Hide private keys from user display (security)
            const { depositPrivateKey, intermediatePrivateKey, ...publicSession } = session;
            console.log(`\nSession: ${publicSession.id}`);
            console.log(`Status: ${publicSession.status}`);
            console.log(`Deposit Address: ${publicSession.depositAddress}`);
            console.log(`Amount: ${(publicSession.amount / 1e8).toFixed(8)} KAS`);
            
            // Show intermediate address info if exists
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
    } else if (cmd === 'list') {
      const sessions = await getAllSessions();
      console.log(`\nTotal sessions: ${sessions.length}`);
      sessions.forEach(({ sessionId, session }) => {
        console.log(`  ${sessionId}: ${session.status} - ${(session.amount / 1e8).toFixed(8)} KAS`);
      });
      rl.prompt();
    } else if (cmd === 'key' || cmd === 'export-key') {
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
      
      // Helper function to convert private key to hex string
      function getPrivateKeyHex(privateKey) {
        if (!privateKey) return null;
        // If it's already a string (hex), return it
        if (typeof privateKey === 'string') return privateKey;
        // If it's a PrivateKey object, convert to hex
        if (privateKey && typeof privateKey.toString === 'function') {
          return privateKey.toString();
        }
        return String(privateKey);
      }
      
      // Display deposit private key
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
      
      // Display intermediate private key (if exists)
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
    } else if (cmd === 'delete' || cmd === 'remove' || cmd === 'del') {
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
      
      // Show session info before deletion
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
      
      // Ask for confirmation
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
    } else if (cmd === 'tx' || cmd === 'transaction') {
          const txId = args[0];
          if (!txId) {
            console.log('Usage: tx <transaction-id>');
            console.log('   or: transaction <transaction-id>');
            rl.prompt();
            return;
          }
          
          // Search all sessions for this transaction ID
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
    } else if (cmd === 'find' || cmd === 'search') {
      const address = args.join(' ');
      if (!address) {
        console.log('Usage: find <deposit-address>');
        console.log('   or: search <deposit-address>');
        rl.prompt();
        return;
      }
      
      // Search all sessions for this deposit address
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
    } else if (cmd === 'recover') {
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
      
      const { getRpcClient } = require('./rpc-client');
      const { setSession } = require('./session-manager');
      const { MIN_CONFIRMATIONS } = require('./config');
      const rpc = await getRpcClient();
      
      // Get current DAA score
      let currentDaaScore = 0;
      try {
        const dagInfo = await rpc.getBlockDagInfo({});
        currentDaaScore = dagInfo.virtualDaaScore || 0;
      } catch (err) {
        console.error('Error getting DAA score:', err.message);
        rl.prompt();
        return;
      }
      
      let recovered = false;
      
      // Step 1: Check deposit address
      if (session.depositAddress) {
        try {
          const result = await rpc.getUtxosByAddresses({ addresses: [session.depositAddress] });
          if (result && result.entries && result.entries.length > 0) {
            const confirmedUtxos = result.entries.filter(utxo => 
              utxo.blockDaaScore && (currentDaaScore - utxo.blockDaaScore >= MIN_CONFIRMATIONS)
            );
            if (confirmedUtxos.length > 0) {
              const total = confirmedUtxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
              if (total >= BigInt(session.amount)) {
                // Deposit confirmed but status wasn't updated
                if (!session.intermediateAddress) {
                  console.log('✓ Deposit confirmed. Generating intermediate address...');
                  const { generateIntermediateAddress } = require('./session-manager');
                  const { address, privateKey } = await generateIntermediateAddress();
                  session.intermediateAddress = address;
                  session.intermediatePrivateKey = privateKey;
                  session.depositUtxos = confirmedUtxos;
                  session.receivedAmount = total.toString();
                  session.status = 'deposit_received';
                  session.updatedAt = Date.now();
                  await setSession(sessionId, session);
                  console.log(`✓ Recovered to: deposit_received`);
                  recovered = true;
                }
              }
            } else {
              console.log('⏳ Deposit detected but not yet confirmed (waiting for confirmations)');
            }
          } else {
            // No UTXOs at deposit - check if it moved to intermediate
            console.log('⚠ No UTXOs at deposit address. Checking intermediate address...');
          }
        } catch (err) {
          console.error('Error checking deposit address:', err.message);
        }
      }
      
      // Step 2: Check intermediate address (if we have it)
      const intermediateAddresses = [];
      if (session.intermediateAddress) {
        intermediateAddresses.push(session.intermediateAddress);
      } else {
        console.log('⚠ No intermediate address in session data.');
        console.log('⚠ If funds are at an intermediate address, the private key may be lost.');
        console.log('⚠ Recovery is only possible if the intermediate address/private key pair is still in the session.');
      }
      
      // Check known intermediate address
      for (const intAddr of intermediateAddresses) {
        try {
          const result = await rpc.getUtxosByAddresses({ addresses: [intAddr] });
          if (result && result.entries && result.entries.length > 0) {
            const confirmedUtxos = result.entries.filter(utxo => 
              utxo.blockDaaScore && (currentDaaScore - utxo.blockDaaScore >= MIN_CONFIRMATIONS)
            );
            if (confirmedUtxos.length > 0) {
              console.log(`✓ Found ${confirmedUtxos.length} confirmed UTXO(s) at intermediate address`);
              
              // Check if we need to update session state
              if (!session.intermediateUtxos || session.status !== 'intermediate_confirmed') {
                session.intermediateUtxos = confirmedUtxos;
                session.intermediateConfirmed = true;
                const { MIN_INTERMEDIATE_DELAY_MS, MAX_INTERMEDIATE_DELAY_MS } = require('./config');
                const delay = Math.floor(Math.random() * (MAX_INTERMEDIATE_DELAY_MS - MIN_INTERMEDIATE_DELAY_MS + 1)) + MIN_INTERMEDIATE_DELAY_MS;
                session.intermediateDelayUntil = Date.now() + delay;
                session.status = 'intermediate_confirmed';
                session.updatedAt = Date.now();
                await setSession(sessionId, session);
                console.log(`✓ Recovered to: intermediate_confirmed (will payout after ${Math.floor(delay / 1000)}s)`);
                recovered = true;
              } else if (session.status === 'intermediate_confirmed') {
                // Check if delay has passed but payout wasn't sent
                if (session.intermediateDelayUntil && Date.now() >= session.intermediateDelayUntil) {
                  if (!session.payoutTxIds) {
                    console.log('✓ Intermediate confirmed and delay passed. Triggering payout...');
                    const { processFinalPayout } = require('./payout');
                    try {
                      await processFinalPayout(sessionId, session);
                      recovered = true;
                    } catch (err) {
                      console.error(`✗ Payout error: ${err.message}`);
                    }
                  }
                } else {
                  const remainingDelay = Math.max(0, session.intermediateDelayUntil - Date.now());
                  console.log(`⏳ Waiting ${Math.floor(remainingDelay / 1000)}s before payout (delay timer)`);
                }
              }
              
              // If we found funds and have the private key, we can proceed
              if (confirmedUtxos.length > 0 && session.intermediatePrivateKey) {
                // We have both address and key - can recover!
                if (!session.intermediateAddress && intAddr) {
                  // Address wasn't saved but we found it and have the key
                  session.intermediateAddress = intAddr;
                  await setSession(sessionId, session);
                  console.log(`✓ Saved intermediate address: ${intAddr}`);
                }
              } else if (confirmedUtxos.length > 0 && !session.intermediatePrivateKey) {
                // Found funds but no private key - funds are stuck
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
                session.intermediateAddress = intAddr; // Save it so we at least know where funds are
                await setSession(sessionId, session);
              }
            }
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
        } else if (cmd === 'wallet') {
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
            try {
              const balance = await getWalletBalance();
              console.log(`\n💰 Wallet Balance:`);
              console.log(`  Confirmed: ${(Number(balance.confirmed) / 1e8).toFixed(8)} KAS`);
              if (balance.unconfirmed > 0n) {
                console.log(`  Unconfirmed: ${(Number(balance.unconfirmed) / 1e8).toFixed(8)} KAS`);
              }
              console.log(`  Total: ${(Number(balance.total) / 1e8).toFixed(8)} KAS`);
              console.log(`  UTXOs: ${balance.utxoCount}`);
            } catch (err) {
              console.error(`\n✗ Error: ${err.message}`);
            }
            rl.prompt();
          } else if (subCmd === 'send') {
            const toAddress = args[1];
            const amountKAS = parseFloat(args[2]);
            
            if (!toAddress || isNaN(amountKAS) || amountKAS <= 0) {
              console.log('Usage: wallet send <address> <amount_kas>');
              console.log('Example: wallet send kaspa:qxxx... 1.5');
              rl.prompt();
              return;
            }
            
            try {
              const result = await sendFromWallet(toAddress, amountKAS);
              console.log(`\n✓ Transaction sent successfully!`);
              console.log(`  TX ID: ${result.txId}`);
              console.log(`  Amount: ${result.amount.toFixed(8)} KAS`);
              console.log(`  Fee: ${result.fee.toFixed(8)} KAS`);
              if (result.change > 0) {
                console.log(`  Change: ${result.change.toFixed(8)} KAS`);
              }
              console.log(`\nView on explorer: https://kas.fyi/transaction/${result.txId}`);
            } catch (err) {
              console.error(`\n✗ Error sending transaction: ${err.message}`);
            }
            rl.prompt();
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
        } else if (cmd === 'node') {
          await checkNodeStatus();
          rl.prompt();
        } else if (cmd === 'help') {
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
          console.log('  node - Check node status');
          console.log('  exit - Exit mixer\n');
          rl.prompt();
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

