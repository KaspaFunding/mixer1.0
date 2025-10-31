# Kaspa Mining Pool Architecture

## Overview
This is a full-featured Kaspa mining pool implementation written in TypeScript using Bun runtime. It implements the Stratum mining protocol with support for standard EthereumStratum and Bitmain-specific protocols.

## Entry Point
**`index.ts`** - Main entry point that:
1. Connects to Kaspa node via WebSocket
2. Initializes Treasury (coinbase address management)
3. Initializes Templates (block template management)
4. Starts Stratum server (miner connections)
5. Starts Pool coordinator (reward distribution)
6. Optionally starts HTTP API server

## Core Components

### 1. Stratum Server (`src/stratum/`)
Handles all miner connections via TCP using Bun.listen.

**`index.ts`** - Main Stratum server:
- TCP server on configurable hostname/port (default: 0.0.0.0:7777)
- Handles connection lifecycle (open, data, close, error)
- Processes Stratum protocol messages:
  - `mining.subscribe` - Miner registration
  - `mining.authorize` - Worker authentication
  - `mining.submit` - Share submission
- Supports both standard and Bitmain encoding formats
- Rate limiting and idle timeout (30s for unsubscribed connections)
- Sequential message processing (critical for ASICs)

**`stratum.ts`** - Base Stratum protocol handler:
- Subscription management
- Worker authorization and validation
- Share submission and validation
- Job broadcasting to subscribed miners
- Address validation (with/without kaspa: prefix)

**`protocol.ts`** - Protocol definitions:
- Request/Response message types
- Error codes and handling
- Message parsing and validation

### 2. Templates (`src/templates/`)
Manages block templates from Kaspa node.

**`index.ts`** - Template manager:
- Subscribes to new block templates from Kaspa node
- Creates PoW (Proof of Work) objects for each template
- Maintains a rolling window of templates (DAA window)
- Registers callback for job announcements to miners

**`jobs/index.ts`** - Job ID management:
- Generates unique 2-byte job IDs
- Maps job IDs to block template hashes
- Handles job expiration

### 3. Treasury (`src/treasury/`)
Manages the pool's coinbase address and UTXO tracking.

**`index.ts`** - Treasury manager:
- Manages pool's private key and address
- Tracks coinbase transactions via UTXO processor
- Calculates pool fees
- Emits events:
  - `coinbase` - When coinbase matures (reward - fee)
  - `revenue` - Pool fee amount

### 4. Pool Coordinator (`src/pool/`)
Orchestrates all pool components and handles rewards.

**`index.ts`** - Main pool coordinator:
- Records block contributions from miners
- Distributes rewards when coinbase matures
- Manages reward distribution cycles
- Integrates with database, monitoring, and API

**`rewarding.ts`** - Reward distribution:
- Tracks miner contributions per block
- Calculates proportional rewards using PPLNS
- Accumulates miner balances
- Pays out when threshold exceeded

**`database/index.ts`** - Miner database:
- Stores miner balances (LMDB or JSON fallback)
- Thread-safe balance updates
- Persists miner data

**`monitoring/index.ts`** - Logging and monitoring:
- Structured console logging
- Timestamp formatting
- Status monitoring

**`api/`** - HTTP API server:
- RESTful endpoints:
  - `GET /status` - Pool status
  - `GET /miners` - List all miners
  - `GET /miner?address=...` - Get miner details
- Returns miner balances, connections, workers

## Data Flow

### Connection Flow:
1. Miner connects via TCP to Stratum server
2. Socket `open` event fires → `onConnect()` initializes miner data
3. Miner sends `mining.subscribe` → Pool responds with subscription
4. Pool immediately sends `set_extranonce` and `mining.set_difficulty`
5. Miner sends `mining.authorize` → Pool validates address/worker
6. Pool sends `mining.notify` jobs when new blocks arrive

### Mining Flow:
1. Kaspa node notifies pool of new block template
2. Templates manager creates PoW object and job ID
3. Stratum broadcasts `mining.notify` to all subscribed miners
4. Miner computes hash and submits share via `mining.submit`
5. Pool validates share (nonce uniqueness, difficulty)
6. If valid block, submits to network and records contribution

### Reward Flow:
1. Block is successfully submitted to network
2. Pool records all valid shares for that block
3. When coinbase matures (after 200 DAA blocks), Treasury emits `coinbase` event
4. Rewarding system calculates proportional shares using PPLNS
5. Miner balances accumulate in database
6. When balance exceeds threshold, pool sends payment transaction

## Configuration

**`config.json`**:
```json
{
  "node": "ws://127.0.0.1:17110",        // Kaspa node WebSocket
  "treasury": {
    "privateKey": "...",                  // Pool's private key
    "fee": 1,                            // Pool fee percentage
    "rewarding": {
      "paymentThreshold": "1000000000"   // Minimum payout (sompi)
    }
  },
  "templates": {
    "identity": "KaspaFunding",           // Block extraData
    "daaWindow": 40                       // Template retention window
  },
  "stratum": {
    "hostName": "0.0.0.0",                // Bind address (0.0.0.0 = all interfaces)
    "port": 7777,                         // Stratum port
    "difficulty": "4096"                  // Mining difficulty
  },
  "api": {
    "enabled": true,                      // Enable HTTP API
    "port": 8080                          // API port
  }
}
```

## Protocol Details

### Supported Formats:
- **Standard EthereumStratum**: For Iceriver, Goldshell, and most ASICs
  - Subscribe response: `[true, "EthereumStratum/1.0.0"]`
  - Extranonce: 2 bytes (4 hex chars)
  
- **Bitmain Format**: For Bitmain/GodMiner ASICs
  - Subscribe response: `[null, extranonce, extranonce2_size]`
  - Different job encoding

### Key Features:
- **Sequential Message Processing**: Critical for ASICs that send subscribe + authorize together
- **Immediate Handshake**: Sends extranonce and difficulty right after subscribe response
- **Address Validation**: Handles addresses with/without `kaspa:` prefix
- **Worker Names**: Required format `address.worker_name`
- **Idle Timeout**: Disconnects miners that don't subscribe within 30s
- **Rate Limiting**: Prevents abuse (100 messages/second per connection)

## Files Structure
```
pool/
├── index.ts              # Entry point
├── config.json           # Configuration
├── package.json          # Dependencies
├── src/
│   ├── stratum/          # Stratum protocol
│   │   ├── index.ts      # Server implementation
│   │   ├── stratum.ts    # Protocol handler
│   │   └── protocol.ts   # Type definitions
│   ├── templates/        # Block templates
│   │   ├── index.ts      # Template manager
│   │   └── jobs/         # Job ID management
│   ├── treasury/         # Coinbase management
│   │   └── index.ts      # Treasury handler
│   ├── pool/             # Pool coordination
│   │   ├── index.ts      # Main pool class
│   │   ├── rewarding.ts  # Reward distribution
│   │   ├── database/     # Miner database
│   │   ├── monitoring/   # Logging
│   │   └── api/          # HTTP API
│   └── types.d.ts        # TypeScript types
├── wasm/
│   └── kaspa.ts          # Kaspa WASM bindings
└── database/
    └── miners.json       # Miner balances (if JSON mode)
```

## API Endpoints

### GET /status
Returns pool status:
```json
{
  "networkId": "mainnet",
  "miners": 5,
  "workers": 10
}
```

### GET /miners
Returns all miners:
```json
{
  "miners": [
    {
      "address": "kaspa:...",
      "balance": "1000000000",
      "connections": 2,
      "workers": 3,
      "workersDetail": [...]
    }
  ]
}
```

### GET /miner?address=kaspa:...
Returns specific miner details:
```json
{
  "address": "kaspa:...",
  "balance": "1000000000",
  "connections": 2,
  "workers": [...]
}
```

## Known Issues & Fixes Applied

### Fixed Issues:
1. ✅ Buffer to string conversion in `onData`
2. ✅ Sequential message processing (subscribe before authorize)
3. ✅ Immediate extranonce/difficulty after subscribe
4. ✅ Removed duplicate extranonce in authorize
5. ✅ Address validation with/without kaspa: prefix
6. ✅ Enhanced logging for debugging
7. ✅ Worker name parsing (indexOf vs lastIndexOf)
8. ✅ Idle timeout handling

### Current Issue:
- **ASIC Connection**: No packets from ASIC (192.168.1.165) reaching Windows
  - Likely network-level: router firewall, client isolation, or Windows network profile
  - Pool code is correct (test connections work)

