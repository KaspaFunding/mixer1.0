#!/usr/bin/env node

// Quick script to generate private keys and addresses for testing

const path = require('path');
const fs = require('fs');

// Load config and services (same as test-coinjoin.js)
process.chdir(path.join(__dirname, '..'));
const { kaspa, KASPA_NETWORK } = require('./lib/config');

const participants = [];
for (let i = 0; i < 3; i++) {
  const keypair = kaspa.Keypair.random();
  const privateKey = keypair.privateKey.toHex();
  const address = keypair.toAddress(KASPA_NETWORK).toString();
  
  // Generate destination address
  const destKeypair = kaspa.Keypair.random();
  const destinationAddress = destKeypair.toAddress(KASPA_NETWORK).toString();
  
  participants.push({
    privateKey,
    address,
    destinationAddress
  });
  
  console.log(`\nParticipant ${i + 1}:`);
  console.log(`  Private Key: ${privateKey}`);
  console.log(`  Address: ${address}`);
  console.log(`  Destination: ${destinationAddress}`);
}

const config = {
  participants: 3,
  amountKAS: 1.0,
  autoWallet: false,
  participants
};

console.log('\n\n=== JSON Config ===\n');
const jsonOutput = JSON.stringify(config, null, 2);
console.log(jsonOutput);

// Write to test-config.json
const configPath = path.join(scriptDir, 'test-config.json');
fs.writeFileSync(configPath, jsonOutput, 'utf8');
console.log(`\n✅ Config written to: ${configPath}`);

