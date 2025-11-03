# Vardiff Implementation Plan

This document outlines the step-by-step plan to implement variable difficulty (vardiff) in the mining pool without breaking existing functionality.

## Overview

Vardiff automatically adjusts mining difficulty per miner based on their actual hashrate/performance, optimizing share submission frequency. This improves pool efficiency and reduces network overhead.

**Note**: This implementation is inspired by proven vardiff patterns from reference pool code, using a simpler time-based approach that tracks `lastShare` timestamp rather than maintaining arrays of share times.

## Key Design Principles

1. **Backward Compatibility**: If vardiff is disabled, pool behaves exactly as before (fixed difficulty)
2. **Gradual Changes**: Difficulty adjustments happen gradually to avoid sudden jumps
3. **Per-Miner Tracking**: Each miner connection gets its own difficulty adjustment
4. **Configurable**: All vardiff parameters are configurable via config.json and GUI

## Implementation Steps

### Step 1: Extend Configuration

**File**: `pool/config.json`

Add vardiff configuration section:
```json
{
  "stratum": {
    "hostName": "0.0.0.0",
    "port": 7777,
    "difficulty": "1024",
    "vardiff": {
      "enabled": false,
      "minDifficulty": 64,
      "maxDifficulty": 65536,
      "targetTime": 30,
      "variancePercent": 50,
      "maxChange": 2.0,
      "changeInterval": 30
    }
  }
}
```

**Parameters**:
- `enabled`: Enable/disable vardiff (default: false for backward compatibility)
- `minDifficulty`: Minimum difficulty allowed (protects against spam)
- `maxDifficulty`: Maximum difficulty allowed (protects against too-high values)
- `targetTime`: Target time between shares in seconds (30s = ~2 shares/min)
- `variancePercent`: Percentage deviation from target that triggers adjustment (50% = adjust if <15s or >45s)
- `maxChange`: Maximum multiplier for difficulty change (2.0 = can double or halve at most)
- `changeInterval`: Minimum seconds between difficulty changes (prevents oscillation)

### Step 2: Extend Miner Type

**File**: `pool/src/stratum/index.ts`

Add vardiff tracking fields to `Miner` type (based on proven reference implementation):
```typescript
export type Miner = {
  // ... existing fields ...
  difficulty: Decimal
  
  // Vardiff tracking fields (only used when vardiff enabled)
  vardiff?: {
    lastShare: number  // Timestamp of last share (simpler than array)
    lastDifficultyChange: number  // Timestamp of last change
    currentDifficulty: Decimal  // Current vardiff difficulty
    initialized: boolean  // Whether vardiff has been initialized
    shareCount: number  // Total shares submitted (for statistics)
  }
}
```

**Note**: The reference code uses `lastShare` timestamp instead of tracking an array of share times. This is simpler and proven effective. We'll calculate difficulty adjustments based on time since last share.

### Step 3: Load Vardiff Config

**File**: `pool/src/stratum/index.ts`

In constructor, load vardiff config:
```typescript
constructor (templates: Templates, hostName: string, port: number, difficulty: string, vardiffConfig?: any) {
  super(templates)
  this.difficulty = difficulty
  this.vardiffConfig = vardiffConfig || { enabled: false }
}
```

### Step 4: Initialize Vardiff on Subscribe

**File**: `pool/src/stratum/index.ts`

In `onMessage` when handling `mining.subscribe`:
```typescript
// After subscribe success, initialize vardiff if enabled
if (this.vardiffConfig.enabled) {
  socket.data.vardiff = {
    shareTimes: [],
    lastDifficultyChange: Date.now(),
    currentDifficulty: new Decimal(this.difficulty), // Start with pool default
    initialized: true
  }
  // Use vardiff difficulty instead of fixed
  socket.data.difficulty = socket.data.vardiff.currentDifficulty
}
```

### Step 5: Track Share Times (Simplified Approach)

**File**: `pool/src/stratum/stratum.ts` (in `submit` method after successful share)

Update share tracking (based on reference code pattern):
```typescript
// After recording share in submit() method (line ~387)
if (socket.data.vardiff?.initialized) {
  const now = Date.now()
  const oldLastShare = socket.data.vardiff.lastShare || socket.data.connectedAt
  socket.data.vardiff.lastShare = now
  socket.data.vardiff.shareCount = (socket.data.vardiff.shareCount || 0) + 1
  
  // Calculate time since last share (for difficulty adjustment)
  const timeSinceLastShare = now - oldLastShare
  
  // Adjust difficulty based on share frequency
  // Only adjust if enough time has passed since last change
  this.adjustDifficulty(socket, timeSinceLastShare)
}
```

**Note**: This simpler approach tracks only `lastShare` timestamp instead of an array. We'll adjust difficulty based on how frequently shares are submitted.

### Step 6: Implement Difficulty Adjustment Logic (Based on Reference Code)

**File**: `pool/src/stratum/stratum.ts`

Add new method (inspired by proven reference implementation):
```typescript
private adjustDifficulty(socket: Socket<Miner>, timeSinceLastShare: number): void {
  if (!socket.data.vardiff?.initialized || !this.vardiffConfig.enabled) {
    return
  }
  
  const vardiff = socket.data.vardiff
  const config = this.vardiffConfig
  const now = Date.now()
  
  // Don't adjust too frequently (throttle changes)
  if (now - vardiff.lastDifficultyChange < (config.changeInterval * 1000)) {
    return
  }
  
  // Need at least 2 shares to make meaningful adjustments
  if (vardiff.shareCount < 2) {
    return
  }
  
  const timeSinceLastShareSeconds = timeSinceLastShare / 1000
  const targetTime = config.targetTime
  const variance = (config.variancePercent / 100) * targetTime
  const minTarget = targetTime - variance
  const maxTarget = targetTime + variance
  
  let newDifficulty = vardiff.currentDifficulty.clone()
  let shouldChange = false
  
  // Adjust based on share frequency (reference code pattern)
  if (timeSinceLastShareSeconds < minTarget) {
    // Miner submitting too fast - increase difficulty
    const ratio = targetTime / timeSinceLastShareSeconds
    const changeMultiplier = Math.min(ratio, config.maxChange)
    newDifficulty = vardiff.currentDifficulty.mul(changeMultiplier)
    shouldChange = true
  } else if (timeSinceLastShareSeconds > maxTarget) {
    // Miner submitting too slow - decrease difficulty
    // Use smooth scaling like reference code (prevents sudden drops)
    const MAX_ELAPSED_MS = 5 * 60 * 1000 // 5 minutes cap
    const cappedTime = Math.min(timeSinceLastShare, MAX_ELAPSED_MS)
    const timeWeight = cappedTime / MAX_ELAPSED_MS // 0 to 1
    
    // Scale down based on time weight (smooth ramp-down)
    const scaledRatio = timeSinceLastShareSeconds / targetTime
    const changeMultiplier = Math.max(1 / scaledRatio, 1 / config.maxChange) * timeWeight
    newDifficulty = vardiff.currentDifficulty.mul(changeMultiplier)
    shouldChange = true
  }
  
  // Clamp to min/max difficulty
  const minDiff = new Decimal(config.minDifficulty)
  const maxDiff = new Decimal(config.maxDifficulty)
  if (newDifficulty.lt(minDiff)) newDifficulty = minDiff
  if (newDifficulty.gt(maxDiff)) newDifficulty = maxDiff
  
  // Only change if difference is significant (avoid tiny adjustments)
  const diffPercent = newDifficulty.div(vardiff.currentDifficulty).minus(1).abs().mul(100)
  if (shouldChange && diffPercent.gte(5)) { // At least 5% change
    const oldDiff = vardiff.currentDifficulty.toNumber()
    vardiff.currentDifficulty = newDifficulty
    vardiff.lastDifficultyChange = now
    socket.data.difficulty = newDifficulty // Update socket difficulty
    
    // Send new difficulty to miner
    this.sendDifficultyUpdate(socket)
    
    console.log(`[Vardiff] Adjusted difficulty for ${socket.remoteAddress}: ${oldDiff.toFixed(0)} -> ${newDifficulty.toNumber().toFixed(0)} (interval: ${timeSinceLastShareSeconds.toFixed(1)}s, target: ${targetTime}s)`)
  }
}
```

**Key improvements from reference code**:
- Uses `lastShare` timestamp instead of tracking array (simpler, proven)
- Implements time-based scaling for slow miners (smooth ramp-down)
- Caps maximum elapsed time to prevent extreme difficulty drops
- Uses time weight (0-1) for smooth transitions

### Step 7: Send Difficulty Updates

**File**: `pool/src/stratum/index.ts`

Add method to send difficulty updates (similar to existing `updateDifficulty` but for vardiff):
```typescript
private sendDifficultyUpdate(socket: Socket<Miner>): void {
  // @ts-ignore
  if (socket.readyState !== 1) return
  
  try {
    const event: Event<'mining.set_difficulty'> = {
      method: 'mining.set_difficulty',
      params: [socket.data.difficulty.toNumber()]
    }
    socket.write(JSON.stringify(event) + '\n')
    console.log(`[Vardiff] Sent difficulty update: ${socket.data.difficulty.toNumber().toFixed(0)} to ${socket.remoteAddress}`)
  } catch (err) {
    console.error(`[Vardiff] Failed to send difficulty update to ${socket.remoteAddress}:`, err)
  }
}
```

### Step 8: Update Pool Config Loader

**File**: `pool/index.ts`

Pass vardiff config to Stratum constructor:
```typescript
const stratum = new Stratum(
  templates, 
  config.stratum.hostName, 
  config.stratum.port, 
  config.stratum.difficulty,
  config.stratum.vardiff // Pass vardiff config
)
```

### Step 9: Update API to Show Vardiff Info

**File**: `pool/src/pool/api/index.ts`

In miner info endpoint, include vardiff difficulty:
```typescript
// In getMiner or miners endpoint
{
  // ... existing fields ...
  difficulty: vardiff?.currentDifficulty.toNumber() || difficulty.toNumber(),
  vardiffEnabled: !!vardiff?.initialized,
  vardiffDifficulty: vardiff?.currentDifficulty.toNumber()
}
```

### Step 10: GUI Integration

**Files**: `electron-main.js`, `gui/renderer.js`, `gui/preload.js`

1. **Add vardiff config to pool config update**:
   - Add vardiff fields to IPC handler
   - Update config write logic

2. **Add GUI controls** (in pool settings section):
   - Checkbox: "Enable Variable Difficulty"
   - Inputs: Min Difficulty, Max Difficulty, Target Time, etc.
   - Display: Current vardiff status per miner in miner list

3. **Add API endpoint** (optional):
   - `/api/vardiff/stats` - Get vardiff statistics

## Testing Strategy

1. **Backward Compatibility Test**:
   - Start pool with vardiff disabled
   - Verify it behaves exactly as before (fixed difficulty)

2. **Vardiff Basic Test**:
   - Enable vardiff with default settings
   - Connect a miner
   - Submit shares
   - Verify difficulty adjusts based on share frequency

3. **Boundary Tests**:
   - Test min/max difficulty clamping
   - Test maxChange limiting
   - Test changeInterval throttling

4. **Multiple Miners Test**:
   - Connect multiple miners with different hashrates
   - Verify each gets appropriate difficulty

## Rollout Plan

1. **Phase 1**: Implement core vardiff logic (Steps 1-7)
2. **Phase 2**: Add configuration support (Steps 8-9)
3. **Phase 3**: Add GUI controls (Step 10)
4. **Phase 4**: Testing and refinement
5. **Phase 5**: Enable by default (optional, after testing)

## Migration Notes

- Default vardiff is **disabled** (`enabled: false`), so existing configs continue working
- When enabled, miners start at the pool's default difficulty and adjust from there
- No data migration needed - vardiff state is per-connection (in-memory only)

## Performance Considerations

- Share time tracking is lightweight (just timestamps)
- Difficulty adjustment is O(n) where n is share history (max 10)
- Adjustment check happens only after each share (minimal overhead)
- No additional database writes for vardiff

