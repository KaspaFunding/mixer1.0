# Kaspa Mixer - Standalone Edition

A comprehensive privacy solution for the Kaspa blockchain, offering both traditional mixing sessions and advanced zero-trust CoinJoin functionality. This standalone application provides a complete mixing service that can run entirely on your local machine, giving you full control over your privacy and security.

## 🌟 Overview

The Kaspa Mixer Standalone Edition is a desktop application that provides two powerful privacy mechanisms:

1. **Traditional Mixing Sessions**: Multi-hop mixing with intermediate addresses for enhanced privacy
2. **Zero-Trust CoinJoin**: Decentralized, trustless CoinJoin transactions where participants never share private keys

### Key Features

- ✅ **Complete Privacy Control**: All operations run locally on your machine
- ✅ **Zero-Trust CoinJoin**: No need to trust a coordinator with your private keys
- ✅ **Multi-Participant Support**: CoinJoin coordinates exactly 10 participants per transaction
- ✅ **Graphical User Interface**: Modern, intuitive GUI built with Electron
- ✅ **Command-Line Interface**: Full-featured CLI for advanced users
- ✅ **Automated UTXO Management**: Smart UTXO creation and verification
- ✅ **Sequence Lock Protection**: Automatic retry logic for network timing issues
- ✅ **Exact Amount Matching**: Strict enforcement of equal inputs/outputs for fairness
- ✅ **Real-Time WebSocket Coordination**: Live CoinJoin session coordination

## 📋 Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Features](#features)
- [Usage](#usage)
- [Configuration](#configuration)
- [Testing](#testing)
- [Security](#security)
- [Architecture](#architecture)
- [Technical Details](#technical-details)

## 🚀 Installation

### Prerequisites

- Node.js 18+ or later
- Kaspa node (kaspad) running locally or accessible via network
- Windows, Linux, or macOS

### Building from Source

```bash
# Clone the repository
git clone <repository-url>
cd Mixer/standalone-mixer

# Install dependencies
npm install

# Build the application
npm run build:gui          # For GUI version (Windows)
npm run build:gui:all      # For all platforms
npm run build              # For CLI version only
```

### Running the Application

```bash
# GUI Mode (Electron)
npm run electron

# CLI Mode
npm start

# Or use the built executable
./mixer-cli.exe
```

## ⚡ Quick Start

### GUI Mode

1. **Start the Application**: Run `npm run electron` or launch the built executable
2. **Connect to Kaspa Node**: Ensure your Kaspa node is running (default: `ws://127.0.0.1:17110`)
3. **Create a Session**: Choose between regular mixing or CoinJoin
4. **Follow the Wizard**: The GUI will guide you through the process

### CLI Mode

```bash
# Start the mixer
npm start

# Follow the interactive prompts to:
# - Create mixing sessions
# - Manage CoinJoin sessions
# - View session status
# - Monitor transactions
```

## 🎯 Features

### 1. Traditional Mixing Sessions

Traditional mixing provides multi-hop privacy through intermediate addresses:

- **Multi-Hop Transactions**: Funds move through intermediate addresses
- **Proportional Outputs**: Outputs are distributed proportionally for maximum privacy
- **Automatic Monitoring**: Real-time monitoring of deposit confirmations
- **Recovery System**: Automatic recovery from failed transactions

### 2. Zero-Trust CoinJoin

A revolutionary privacy feature that allows multiple participants to combine their funds without trusting a coordinator:

#### How It Works

1. **Commitment Phase**: Participants commit UTXOs using cryptographic hashes
2. **Reveal Phase**: Participants reveal their UTXOs when enough commitments exist
3. **Transaction Building**: System builds a CoinJoin transaction with all revealed UTXOs
4. **Signing**: Each participant signs their inputs locally (private keys never leave the device)
5. **Submission**: Fully signed transaction is submitted to the network

#### Key Benefits

- **Zero Trust**: No coordinator ever sees your private keys
- **Fairness**: All participants contribute and receive exactly the same amount
- **Privacy**: Source and destination addresses are obscured
- **Scalability**: Supports coordinated CoinJoin rounds with exactly 10 participants per transaction
- **Security**: Private keys are only used locally for signing

#### Requirements

- **Participants Required**: 10 (including the initiator)
- **Maximum Participants**: 10
- **Exact Amount Matching**: All inputs must be exactly equal (no tolerance)
- **Equal Outputs**: All outputs are exactly equal

## 📖 Usage

### Regular Mixing Sessions

#### Via GUI

1. Navigate to the "Mixing Sessions" tab
2. Click "Create New Session"
3. Enter your destination address and amount
4. The system will generate a deposit address
5. Send funds to the deposit address
6. Monitor the session status in real-time

#### Via CLI

```bash
npm start
# Select option: create
# Follow prompts to enter:
# - Destination address
# - Amount in KAS
# - Number of hops (optional)
```

### CoinJoin Sessions

#### Creating a CoinJoin Session

1. Navigate to "Coinjoin Sessions" tab in GUI
2. Click "Create Zero-Trust Session"
3. Enter:
   - Amount (must match other participants exactly)
   - Destination address
   - UTXOs (or use "Use My Wallet" for automatic UTXO management)
4. Click "Create Session"

#### Revealing UTXOs

1. Wait for all 10 participants to commit
2. Click "Reveal UTXOs" on your session
3. The system will automatically verify amount matching

#### Building Transaction

1. After all 10 participants have revealed
2. Click "Build Transaction"
3. Review the transaction details
4. Sign your inputs (private keys stay local)
5. Transaction is submitted automatically

#### Automated UTXO Management

The "Use My Wallet" feature automatically:
- Checks for existing matching UTXOs
- Creates fresh UTXOs if needed
- Waits for confirmation
- Verifies exact amount matching
- Populates the form automatically

## ⚙️ Configuration

### Environment Variables

Create a `.env` file in the project root:

```env
# Kaspa Node Configuration
KASPA_NODE_URL=ws://127.0.0.1:17110
HTTP_NODE_URL=http://127.0.0.1:16110
KASPA_NETWORK=mainnet
KASPA_ENCODING=borsh

# Admin Configuration (for privileged operations)
ADMIN_PASSWORD=your_admin_password
PRIVILEGED_ADDRESS_PASSWORD=your_privileged_password

# WebSocket Server (for CoinJoin coordination)
COINJOIN_WS_PORT=8080
```

### Test Configuration

For testing CoinJoin, create test configuration files:

**`scripts/test-config.json`** (3 participants):
```json
{
  "amountKAS": 1.0,
  "autoWallet": false,
  "participants": [
    {
      "privateKey": "priv key here",
      "address": "kaspa address of that priv key",
      "destinationAddress": "kaspa address of that priv key"
    },
    ...
  ]
}
```

**`scripts/test-config-10.json`** (10 participants):
```json
{
  "amountKAS": 1.00,
  "autoWallet": false,
  "participants": [
    {
      "privateKey": "priv key here",
      "address": "kaspa address of that priv key",
      "destinationAddress": "kaspa address of that priv key"
    },
    ...
  ]
}
```

## 🧪 Testing

### Running CoinJoin Tests

```bash
# Test with 3 participants (default)
node scripts/test-coinjoin.js

# Test with 10 participants
node scripts/test-coinjoin.js --config scripts/test-config-10.json
```

### Test Script Features

The test script automatically:
- Creates fresh UTXOs for each participant
- Excludes UTXOs from previous sessions
- Verifies exact amount matching
- Creates and manages CoinJoin sessions
- Signs transactions with proper signature scripts
- Submits transactions to the network

### Test Results

The test script provides comprehensive logging:
- UTXO creation and confirmation
- Session creation and management
- Transaction building and signing
- Final transaction ID and explorer link

## 🔒 Security

### Private Key Security

- **Never Transmitted**: Private keys are never sent over the network
- **Local Signing Only**: All signing happens locally on your device
- **No Coordinator Trust**: Zero-trust CoinJoin means no one sees your keys
- **Secure Storage**: Session data is stored locally with encryption

### Transaction Security

- **Exact Amount Matching**: Prevents gaming the system
- **Signature Verification**: All signatures are cryptographically verified
- **UTXO Validation**: Strict validation of UTXO amounts and sources
- **Sequence Lock Protection**: Automatic retry for network timing issues

### Privacy Guarantees

- **Multi-Hop Mixing**: Traditional sessions use intermediate addresses
- **CoinJoin Privacy**: Equal outputs make tracking difficult
- **No Logging**: No sensitive data is logged or transmitted
- **Local Processing**: All operations happen on your machine

## 🏗️ Architecture

### Application Structure

```
standalone-mixer/
├── lib/                    # Core library functions
│   ├── services/           # Service modules
│   │   ├── coinjoin.js    # CoinJoin logic
│   │   ├── coinjoin-websocket.js  # WebSocket coordination
│   │   └── ...
│   ├── wallet.js          # Wallet operations
│   ├── session-manager.js # Session management
│   └── ...
├── gui/                    # Electron GUI
│   ├── index.html         # Main UI
│   ├── renderer.js        # Frontend logic
│   └── styles.css         # Styling
├── scripts/                # Utility scripts
│   ├── test-coinjoin.js   # CoinJoin testing
│   └── ...
└── kaspa/                  # Kaspa WASM SDK
```

### Key Components

1. **CoinJoin Service** (`lib/services/coinjoin.js`)
   - Session creation and management
   - Transaction building
   - Signature collection and application
   - UTXO validation

2. **Wallet Service** (`lib/wallet.js`)
   - Private key management
   - UTXO creation and verification
   - Transaction sending
   - Balance checking

3. **WebSocket Server** (`lib/services/coinjoin-websocket.js`)
   - Real-time session coordination
   - Participant discovery
   - Status updates

4. **GUI** (`gui/`)
   - Electron-based interface
   - Real-time updates
   - Session management
   - Transaction monitoring

## 📊 Technical Details

### Transaction Mass

- **Mass Limit**: 100,000
- **10-Participant CoinJoin**: ~16,054 (16.1% utilization)
- **Headroom**: 83.9% available for additional participants or features
- **Scalability**: Can support significantly more participants if needed

### CoinJoin Specifications

- **Input Requirements**: All inputs must be exactly equal
- **Output Requirements**: All outputs are exactly equal
- **Participant Count**: 10 participants per transaction
- **Fee Handling**: Any remainder from division goes to transaction fees
- **Signature Method**: Uses `kaspa.signTransaction()` for proper signature script formatting

### UTXO Management

- **Fresh UTXO Creation**: Always creates new UTXOs for each session
- **UTXO Exclusion**: Automatically excludes UTXOs from previous sessions
- **Index Selection**: Prioritizes index 0 (send amount) over index 1 (change)
- **Amount Verification**: Strict verification of exact amounts
- **Confirmation Waiting**: Automatic waiting for UTXO confirmation

### Sequence Lock Protection

- **Automatic Retry**: Exponential backoff (1s, 2s, 4s, 8s, 16s)
- **Maximum Retries**: 5 attempts
- **Total Timeout**: 30 seconds
- **Error Handling**: Graceful handling of network timing issues

## 🔧 Development

### Building the Application

```bash
# Build GUI for Windows
npm run build:gui

# Build GUI for all platforms
npm run build:gui:all

# Build CLI executable
npm run build

# Build pool components
npm run pool:build
```

### Development Mode

```bash
# Start GUI in development mode
npm run electron

# Start CLI in development mode
npm start
```

### Code Structure

- **Backend**: Node.js with Kaspa WASM SDK
- **Frontend**: Electron with vanilla JavaScript
- **Communication**: IPC (Inter-Process Communication) between main and renderer
- **Storage**: Local file-based database (JSON)

## 📝 License

[Add your license information here]

## 🤝 Contributing

[Add contribution guidelines here]

## 📞 Support

[Add support information here]

## 🎉 Acknowledgments

- Built on the Kaspa blockchain
- Uses Rusty Kaspa WASM SDK
- Powered by Electron for cross-platform GUI

---

**Version**: 1.0.0  
**Last Updated**: 2025-01-07  
**Status**: BETA ✅

