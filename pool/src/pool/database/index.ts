let lmdbOpen: any = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  lmdbOpen = require('lmdb').open
} catch (_) {
  lmdbOpen = null
}
import fs from 'fs'
import path from 'path'
import type { RootDatabase, Database as SubDatabase, Key } from 'lmdb'

type Miner = {
  balance: bigint
  paymentThreshold?: bigint
  paymentIntervalHours?: number
  lastPayoutTime?: number
  blocksFound?: number
}

const defaultMiner: Miner = {
  balance: 0n,
  blocksFound: 0
}

type Block = {
  hash: string
  address: string  // Block finder's address (for backwards compatibility)
  timestamp: number
  difficulty?: string  // Block finder's difficulty (for backwards compatibility)
  // All contributions for this block (stores ALL miners who contributed shares)
  contributions?: Array<{ address: string, difficulty: string }>
  paid?: boolean
  // DAA score for coinbase matching and persistence across restarts
  daaScore?: string  // Stored as string for JSON compatibility
}

export type PaymentStatus = 'pending' | 'processing' | 'sent' | 'confirmed' | 'failed' | 'restored'

export type Payment = {
  // Unique payment ID (transaction hash or generated ID)
  id: string
  // Miner address receiving payment
  address: string
  // Payment amount in sompi (as string for JSON storage) - this is the net amount sent to miner
  amount: string
  // Original coinbase amount from block (before pool fee) in sompi
  coinbaseAmount?: string
  // Timestamp when payment was created
  createdAt: number
  // Timestamp when payment was last updated
  updatedAt: number
  // Payment status
  status: PaymentStatus
  // Block hash(es) that triggered this payment
  blockHashes?: string[]
  // Transaction ID on blockchain (when payment is sent)
  txId?: string
  // Error message if payment failed
  error?: string
  // Number of retry attempts
  retryCount?: number
  // Pool fee deducted from coinbase (in sompi)
  poolFee?: string
  // Balance before payment
  balanceBefore?: string
  // Balance after payment (if restored)
  balanceAfter?: string
  // Payment threshold that triggered this payment
  paymentThreshold?: string
  // Time-based payment (interval hours)
  paymentIntervalHours?: number
  // Notes or additional info
  notes?: string
}

export default class Database {
  db: RootDatabase<any, Key> | null
  miners: SubDatabase<Miner, string> | null
  blocks: SubDatabase<Block, string> | null
  payments: SubDatabase<Payment, string> | null
  useLmdb: boolean
  jsonPath: string
  blocksJsonPath: string
  paymentsJsonPath: string

  constructor (dirPath: string) {
    this.useLmdb = Boolean(lmdbOpen)
    if (this.useLmdb) {
      this.db = lmdbOpen({ path: dirPath })
      // @ts-ignore
      this.miners = this.db.openDB('miners', {})
      // @ts-ignore
      this.blocks = this.db.openDB('blocks', {})
      // @ts-ignore
      this.payments = this.db.openDB('payments', {})
    } else {
      this.db = null
      this.miners = null
      this.blocks = null
      this.payments = null
      // ensure directory
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true })
      this.jsonPath = path.join(dirPath, 'miners.json')
      this.blocksJsonPath = path.join(dirPath, 'blocks.json')
      this.paymentsJsonPath = path.join(dirPath, 'payments.json')
      if (!fs.existsSync(this.jsonPath)) fs.writeFileSync(this.jsonPath, JSON.stringify({}), 'utf-8')
      if (!fs.existsSync(this.blocksJsonPath)) fs.writeFileSync(this.blocksJsonPath, JSON.stringify({}), 'utf-8')
      if (!fs.existsSync(this.paymentsJsonPath)) fs.writeFileSync(this.paymentsJsonPath, JSON.stringify({}), 'utf-8')
    }
  }

  getMiner (address: string) {
    if (this.useLmdb && this.miners) {
      // @ts-ignore
      return this.miners.get(address) ?? { ...defaultMiner }
    }
    const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
    const minerData = data[address]
    if (!minerData) {
      return { ...defaultMiner }
    }
    // Convert balance from string/number to BigInt when reading from JSON
    return {
      ...minerData,
      balance: typeof minerData.balance === 'string' ? BigInt(minerData.balance) : BigInt(minerData.balance || 0),
      paymentThreshold: minerData.paymentThreshold ? (typeof minerData.paymentThreshold === 'string' ? BigInt(minerData.paymentThreshold) : BigInt(minerData.paymentThreshold)) : undefined,
      blocksFound: minerData.blocksFound ?? 0
    } as Miner
  }

  addBalance (address: string, balance: bigint) {
    if (this.useLmdb && this.miners) {
      // @ts-ignore
      return this.miners.transactionSync(() => {
        const miner = this.getMiner(address)
        miner.balance += balance
        // @ts-ignore
        this.miners.putSync(address, miner)
      })
    } else {
      // JSON file storage
      const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
      const miner = this.getMiner(address)
      const oldBalance = miner.balance
      miner.balance = miner.balance + balance
      data[address] = this.serializeMiner(miner)
      
      // Write with error handling
      try {
        fs.writeFileSync(this.jsonPath, JSON.stringify(data, null, 2), 'utf-8')
        
        // Verify update by reading back
        const verifyData = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
        const verifyMiner = this.getMiner(address)
        if (verifyMiner.balance !== oldBalance + balance) {
          console.error(`[Database] Balance update verification failed for ${address}: expected ${(oldBalance + balance).toString()}, got ${verifyMiner.balance.toString()}`)
          console.error(`[Database] JSON data for ${address}:`, JSON.stringify(data[address], null, 2))
        } else {
          console.log(`[Database] ✓ Balance updated for ${address}: ${(Number(oldBalance) / 100000000).toFixed(8)} → ${(Number(verifyMiner.balance) / 100000000).toFixed(8)} KAS`)
        }
      } catch (error) {
        console.error(`[Database] Error writing balance for ${address}:`, error)
        throw error
      }
    }
  }

  // Helper to convert Miner (with BigInt) to JSON-serializable object
  private serializeMiner(miner: Miner) {
    return {
      balance: miner.balance.toString(),
      paymentThreshold: miner.paymentThreshold ? miner.paymentThreshold.toString() : undefined,
      paymentIntervalHours: miner.paymentIntervalHours,
      lastPayoutTime: miner.lastPayoutTime,
      blocksFound: miner.blocksFound ?? 0
    }
  }

  setPaymentInterval(address: string, intervalHours: number | undefined) {
    try {
      if (this.useLmdb && this.miners) {
        // @ts-ignore
        return this.miners.transactionSync(() => {
          const miner = this.getMiner(address)
          miner.paymentIntervalHours = intervalHours
          // @ts-ignore
          this.miners.putSync(address, miner)
        })
      }
      const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
      const miner = this.getMiner(address)
      miner.paymentIntervalHours = intervalHours
      data[address] = this.serializeMiner(miner)
      fs.writeFileSync(this.jsonPath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (error) {
      console.error('[Database] Error setting payment interval for', address, ':', error)
      throw new Error(`Failed to save payment interval: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  getPaymentInterval(address: string): number | undefined {
    const miner = this.getMiner(address)
    return miner.paymentIntervalHours
  }

  setLastPayoutTime(address: string, timestamp: number) {
    if (this.useLmdb && this.miners) {
      // @ts-ignore
      return this.miners.transactionSync(() => {
        const miner = this.getMiner(address)
        miner.lastPayoutTime = timestamp
        // @ts-ignore
        this.miners.putSync(address, miner)
      })
    }
    const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
    const miner = this.getMiner(address)
    miner.lastPayoutTime = timestamp
    data[address] = this.serializeMiner(miner)
    fs.writeFileSync(this.jsonPath, JSON.stringify(data), 'utf-8')
  }

  getLastPayoutTime(address: string): number | undefined {
    const miner = this.getMiner(address)
    return miner.lastPayoutTime
  }

  incrementBlockCount(address: string) {
    if (this.useLmdb && this.miners) {
      // @ts-ignore
      return this.miners.transactionSync(() => {
        const miner = this.getMiner(address)
        miner.blocksFound = (miner.blocksFound ?? 0) + 1
        // @ts-ignore
        this.miners.putSync(address, miner)
      })
    }
    const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
    const miner = this.getMiner(address)
    miner.blocksFound = (miner.blocksFound ?? 0) + 1
    data[address] = this.serializeMiner(miner)
    fs.writeFileSync(this.jsonPath, JSON.stringify(data), 'utf-8')
  }

  getBlockCount(address: string): number {
    const miner = this.getMiner(address)
    return miner.blocksFound ?? 0
  }

  getTotalBlockCount(): number {
    if (this.useLmdb && this.miners) {
      let total = 0
      // @ts-ignore
      this.miners.getKeys().forEach((key: string) => {
        const miner = this.getMiner(key)
        total += miner.blocksFound ?? 0
      })
      return total
    }
    const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
    let total = 0
    for (const address in data) {
      const minerData = data[address]
      total += minerData?.blocksFound ?? 0
    }
    return total
  }

  getAllMiners(): Map<string, Miner> {
    const miners = new Map<string, Miner>()
    if (this.useLmdb && this.miners) {
      // @ts-ignore
      this.miners.getKeys().forEach((key: string) => {
        if (key !== 'me') { // Exclude pool's own balance
          const miner = this.getMiner(key)
          miners.set(key, miner)
        }
      })
    } else {
      const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
      for (const address in data) {
        if (address !== 'me') { // Exclude pool's own balance
          const miner = this.getMiner(address)
          miners.set(address, miner)
        }
      }
    }
    return miners
  }

  addBlock(block: Block) {
    if (this.useLmdb && this.blocks) {
      // @ts-ignore
      return this.blocks.transactionSync(() => {
        // @ts-ignore
        const existing = this.blocks.get(block.hash)
        // Allow updates to existing blocks (e.g., marking as paid, updating contributions)
        // @ts-ignore
        this.blocks.putSync(block.hash, block)
      })
    }
    const data = JSON.parse(fs.readFileSync(this.blocksJsonPath, 'utf-8') || '{}')
    // Allow updates to existing blocks (e.g., marking as paid, updating contributions)
    data[block.hash] = block
    // Keep only last 1000 blocks to prevent file growth
    const entries = Object.entries(data).sort((a: [string, any], b: [string, any]) => 
      (b[1].timestamp || 0) - (a[1].timestamp || 0))
    const limited = Object.fromEntries(entries.slice(0, 1000))
    fs.writeFileSync(this.blocksJsonPath, JSON.stringify(limited), 'utf-8')
  }

  getBlocks(limit: number = 100): Block[] {
    if (this.useLmdb && this.blocks) {
      const blocks: Block[] = []
      // @ts-ignore
      this.blocks.getKeys({ limit, reverse: true }).forEach((key: string) => {
        // @ts-ignore
        const block = this.blocks.get(key)
        if (block) blocks.push(block)
      })
      return blocks
    }
    const data = JSON.parse(fs.readFileSync(this.blocksJsonPath, 'utf-8') || '{}')
    return Object.values(data).sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, limit) as Block[]
  }

  getBlocksByAddress(address: string, limit: number = 100): Block[] {
    const allBlocks = this.getBlocks(1000)
    const addressBlocks = allBlocks.filter(b => b.address === address)
    return addressBlocks.slice(0, limit)
  }

  // Add or update a payment record
  addPayment(payment: Payment) {
    // Ensure payment has required fields
    if (!payment.id) {
      throw new Error('Payment must have an id')
    }
    if (!payment.updatedAt) {
      payment.updatedAt = Date.now()
    }
    if (!payment.createdAt) {
      payment.createdAt = payment.updatedAt
    }

    if (this.useLmdb && this.payments) {
      // @ts-ignore
      return this.payments.transactionSync(() => {
        // @ts-ignore
        this.payments.putSync(payment.id, payment)
      })
    }
    const data = JSON.parse(fs.readFileSync(this.paymentsJsonPath, 'utf-8') || '{}')
    data[payment.id] = payment
    // Keep only last 5000 payments
    const entries = Object.entries(data).sort((a: [string, any], b: [string, any]) => 
      (b[1].updatedAt || b[1].createdAt || b[1].timestamp || 0) - (a[1].updatedAt || a[1].createdAt || a[1].timestamp || 0))
    const limited = Object.fromEntries(entries.slice(0, 5000))
    fs.writeFileSync(this.paymentsJsonPath, JSON.stringify(limited, null, 2), 'utf-8')
  }

  // Update payment status and fields
  updatePayment(id: string, updates: Partial<Payment>) {
    const payment = this.getPayment(id)
    if (!payment) {
      throw new Error(`Payment ${id} not found`)
    }
    const updated: Payment = {
      ...payment,
      ...updates,
      id: payment.id, // Preserve original ID
      updatedAt: Date.now()
    }
    this.addPayment(updated)
    return updated
  }

  // Get payment by ID
  getPayment(id: string): Payment | null {
    if (this.useLmdb && this.payments) {
      // @ts-ignore
      return this.payments.get(id) || null
    }
    const data = JSON.parse(fs.readFileSync(this.paymentsJsonPath, 'utf-8') || '{}')
    return data[id] || null
  }

  // Get payments by address
  getPaymentsByAddress(address: string, limit: number = 100): Payment[] {
    if (this.useLmdb && this.payments) {
      const payments: Payment[] = []
      // @ts-ignore
      this.payments.getKeys({ limit: 5000, reverse: true }).forEach((key: string) => {
        // @ts-ignore
        const payment = this.payments.get(key) as Payment
        if (payment && payment.address === address) payments.push(payment)
      })
      return payments.slice(0, limit)
    }
    const data = JSON.parse(fs.readFileSync(this.paymentsJsonPath, 'utf-8') || '{}')
    return Object.values(data)
      .filter((p: any) => p.address === address)
      .sort((a: any, b: any) => (b.updatedAt || b.createdAt || b.timestamp || 0) - (a.updatedAt || a.createdAt || a.timestamp || 0))
      .slice(0, limit) as Payment[]
  }

  // Get payments by status
  getPaymentsByStatus(status: PaymentStatus, limit: number = 100): Payment[] {
    if (this.useLmdb && this.payments) {
      const payments: Payment[] = []
      // @ts-ignore
      this.payments.getKeys({ limit: 5000, reverse: true }).forEach((key: string) => {
        // @ts-ignore
        const payment = this.payments.get(key) as Payment
        if (payment && payment.status === status) payments.push(payment)
      })
      return payments.slice(0, limit)
    }
    const data = JSON.parse(fs.readFileSync(this.paymentsJsonPath, 'utf-8') || '{}')
    return Object.values(data)
      .filter((p: any) => p.status === status)
      .sort((a: any, b: any) => (b.updatedAt || b.createdAt || b.timestamp || 0) - (a.updatedAt || a.createdAt || a.timestamp || 0))
      .slice(0, limit) as Payment[]
  }

  // Get payments by block hash
  getPaymentsByBlockHash(blockHash: string): Payment[] {
    if (this.useLmdb && this.payments) {
      const payments: Payment[] = []
      // @ts-ignore
      this.payments.getKeys({ limit: 5000, reverse: true }).forEach((key: string) => {
        // @ts-ignore
        const payment = this.payments.get(key) as Payment
        if (payment && payment.blockHashes && payment.blockHashes.includes(blockHash)) {
          payments.push(payment)
        }
      })
      return payments
    }
    const data = JSON.parse(fs.readFileSync(this.paymentsJsonPath, 'utf-8') || '{}')
    return Object.values(data)
      .filter((p: any) => p.blockHashes && p.blockHashes.includes(blockHash)) as Payment[]
  }

  // Get payments by transaction ID
  getPaymentByTxId(txId: string): Payment | null {
    if (this.useLmdb && this.payments) {
      // @ts-ignore
      this.payments.getKeys({ limit: 5000, reverse: true }).forEach((key: string) => {
        // @ts-ignore
        const payment = this.payments.get(key) as Payment
        if (payment && payment.txId === txId) {
          return payment
        }
      })
      return null
    }
    const data = JSON.parse(fs.readFileSync(this.paymentsJsonPath, 'utf-8') || '{}')
    const payment = Object.values(data).find((p: any) => p.txId === txId) as Payment | undefined
    return payment || null
  }

  // Get recent payments
  getRecentPayments(limit: number = 100): Payment[] {
    if (this.useLmdb && this.payments) {
      const payments: Payment[] = []
      // @ts-ignore
      this.payments.getKeys({ limit, reverse: true }).forEach((key: string) => {
        // @ts-ignore
        const payment = this.payments.get(key) as Payment
        if (payment) payments.push(payment)
      })
      return payments
    }
    const data = JSON.parse(fs.readFileSync(this.paymentsJsonPath, 'utf-8') || '{}')
    return Object.values(data)
      .sort((a: any, b: any) => (b.updatedAt || b.createdAt || b.timestamp || 0) - (a.updatedAt || a.createdAt || a.timestamp || 0))
      .slice(0, limit) as Payment[]
  }

  // Get pending payments (for retry processing)
  getPendingPayments(): Payment[] {
    return this.getPaymentsByStatus('pending')
  }

  // Get failed payments (for retry processing)
  getFailedPayments(): Payment[] {
    return this.getPaymentsByStatus('failed')
  }

  // Helper function to create a payment record
  createPaymentRecord(params: {
    id?: string
    address: string
    amount: string | bigint
    coinbaseAmount?: string | bigint
    status?: PaymentStatus
    blockHashes?: string[]
    txId?: string
    error?: string
    retryCount?: number
    poolFee?: string | bigint
    balanceBefore?: string | bigint
    balanceAfter?: string | bigint
    paymentThreshold?: string | bigint
    paymentIntervalHours?: number
    notes?: string
  }): Payment {
    const amountStr = typeof params.amount === 'bigint' ? params.amount.toString() : params.amount
    const now = Date.now()
    
    return {
      id: params.id || `payment_${now}_${params.address.substring(0, 8)}_${Math.random().toString(36).substring(2, 9)}`,
      address: params.address,
      amount: amountStr,
      coinbaseAmount: params.coinbaseAmount ? (typeof params.coinbaseAmount === 'bigint' ? params.coinbaseAmount.toString() : params.coinbaseAmount) : undefined,
      createdAt: now,
      updatedAt: now,
      status: params.status || 'pending',
      blockHashes: params.blockHashes,
      txId: params.txId,
      error: params.error,
      retryCount: params.retryCount || 0,
      poolFee: params.poolFee ? (typeof params.poolFee === 'bigint' ? params.poolFee.toString() : params.poolFee) : undefined,
      balanceBefore: params.balanceBefore ? (typeof params.balanceBefore === 'bigint' ? params.balanceBefore.toString() : params.balanceBefore) : undefined,
      balanceAfter: params.balanceAfter ? (typeof params.balanceAfter === 'bigint' ? params.balanceAfter.toString() : params.balanceAfter) : undefined,
      paymentThreshold: params.paymentThreshold ? (typeof params.paymentThreshold === 'bigint' ? params.paymentThreshold.toString() : params.paymentThreshold) : undefined,
      paymentIntervalHours: params.paymentIntervalHours,
      notes: params.notes
    }
  }

  setPaymentThreshold(address: string, threshold: bigint | undefined) {
    if (this.useLmdb && this.miners) {
      // @ts-ignore
      return this.miners.transactionSync(() => {
        const miner = this.getMiner(address)
        miner.paymentThreshold = threshold
        // @ts-ignore
        this.miners.putSync(address, miner)
      })
    }
    const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
    const miner = this.getMiner(address)
    miner.paymentThreshold = threshold
    data[address] = this.serializeMiner(miner)
    fs.writeFileSync(this.jsonPath, JSON.stringify(data), 'utf-8')
  }

  getPaymentThreshold(address: string): bigint | undefined {
    const miner = this.getMiner(address)
    return miner.paymentThreshold
  }

  // Reward block hash tracking (for treasury)
  // Maps transaction ID to block hash (for tracking which block a coinbase came from)
  private rewardBlockHashes: Map<string, string> = new Map()
  
  async addRewardBlockHash(blockHash: string, txId: string): Promise<void> {
    try {
      // Store in memory map
      this.rewardBlockHashes.set(txId, blockHash)
      
      // Also store in persistent storage if using LMDB
      if (this.useLmdb && this.db) {
        try {
          // @ts-ignore
          const rewardDB = this.db.openDB('rewards', {})
          // @ts-ignore
          rewardDB.put(txId, blockHash)
        } catch (e) {
          console.error(`[Database] Error storing reward block hash in LMDB:`, e)
        }
      } else {
        // Store in JSON file
        const rewardPath = this.blocksJsonPath.replace('blocks.json', 'reward_block_hashes.json')
        let data: Record<string, string> = {}
        try {
          if (fs.existsSync(rewardPath)) {
            data = JSON.parse(fs.readFileSync(rewardPath, 'utf-8') || '{}')
          }
        } catch (e) {
          data = {}
        }
        data[txId] = blockHash
        fs.writeFileSync(rewardPath, JSON.stringify(data), 'utf-8')
      }
    } catch (error) {
      console.error(`[Database] Error adding reward block hash:`, error)
    }
  }

  async getRewardBlockHash(txId: string, checkMemoryOnly: boolean = false): Promise<string | null> {
    try {
      // Check memory map first
      if (this.rewardBlockHashes.has(txId)) {
        return this.rewardBlockHashes.get(txId) || null
      }

      if (checkMemoryOnly) return null

      // Check persistent storage
      if (this.useLmdb && this.db) {
        // For LMDB, store reward block hashes separately (not in blocks table)
        // Use a separate key prefix to avoid conflicts
        try {
          // @ts-ignore
          const rewardDB = this.db.openDB('rewards', {})
          // @ts-ignore
          const blockHash = rewardDB.get(txId)
          if (blockHash && typeof blockHash === 'string') {
            this.rewardBlockHashes.set(txId, blockHash) // Cache in memory
            return blockHash
          }
        } catch (e) {
          // Reward DB doesn't exist yet, will be created on first write
        }
      } else {
        // Check JSON file
        const rewardPath = this.blocksJsonPath.replace('blocks.json', 'reward_block_hashes.json')
        if (fs.existsSync(rewardPath)) {
          const data = JSON.parse(fs.readFileSync(rewardPath, 'utf-8') || '{}')
          const blockHash = data[txId]
          if (blockHash) {
            this.rewardBlockHashes.set(txId, blockHash) // Cache in memory
            return blockHash
          }
        }
      }

      return null
    } catch (error) {
      console.error(`[Database] Error getting reward block hash:`, error)
      return null
    }
  }

  // Load reward block hashes from persistent storage on startup
  loadRewardBlockHashes(): void {
    try {
      if (this.useLmdb && this.blocks) {
        // For LMDB, we'll load on-demand since it's indexed
        return
      } else {
        // Load from JSON file
        const rewardPath = this.blocksJsonPath.replace('blocks.json', 'reward_block_hashes.json')
        if (fs.existsSync(rewardPath)) {
          const data = JSON.parse(fs.readFileSync(rewardPath, 'utf-8') || '{}')
          for (const [txId, blockHash] of Object.entries(data)) {
            this.rewardBlockHashes.set(txId, blockHash as string)
          }
        }
      }
    } catch (error) {
      console.error(`[Database] Error loading reward block hashes:`, error)
    }
  }

  /**
   * Cleanup database - remove old blocks and optionally reset balances
   */
  cleanupDatabase(options: {
    clearOldBlocks?: boolean  // Clear blocks older than specified days
    blockAgeDays?: number  // Age threshold in days (default: 30)
    clearPaidBlocks?: boolean  // Clear all paid blocks
    clearAllBlocks?: boolean  // Clear all blocks (use with caution)
    resetBalances?: boolean  // Reset all miner balances to 0
    keepRecentBlocks?: number  // Keep N most recent blocks (default: 100)
  }): { blocksRemoved: number, balancesReset: number } {
    const {
      clearOldBlocks = false,
      blockAgeDays = 30,
      clearPaidBlocks = false,
      clearAllBlocks = false,
      resetBalances = false,
      keepRecentBlocks = 100
    } = options

    let blocksRemoved = 0
    let balancesReset = 0

    try {
      // Cleanup blocks
      if (clearAllBlocks || clearPaidBlocks || clearOldBlocks) {
        const allBlocks = this.getBlocks(10000) // Get all blocks
        const now = Date.now()
        const ageThreshold = blockAgeDays * 24 * 60 * 60 * 1000 // Convert days to milliseconds
        const blocksToKeep: Block[] = []
        const blocksToRemove: string[] = []

        for (const block of allBlocks) {
          let shouldRemove = false

          if (clearAllBlocks) {
            shouldRemove = true
          } else if (clearPaidBlocks && block.paid) {
            shouldRemove = true
          } else if (clearOldBlocks && block.timestamp && (now - block.timestamp) > ageThreshold) {
            shouldRemove = true
          }

          if (shouldRemove) {
            blocksToRemove.push(block.hash)
          } else {
            blocksToKeep.push(block)
          }
        }

        // Sort blocks to keep by timestamp (newest first) and keep only N most recent
        const sortedBlocks = blocksToKeep.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        const finalBlocks = sortedBlocks.slice(0, keepRecentBlocks)
        const hashesToKeep = new Set(finalBlocks.map(b => b.hash))

        // Remove blocks that are not in the keep list
        for (const hash of blocksToRemove) {
          if (!hashesToKeep.has(hash)) {
            if (this.useLmdb && this.blocks) {
              // @ts-ignore
              this.blocks.transactionSync(() => {
                // @ts-ignore
                this.blocks.removeSync(hash)
              })
            } else {
              const data = JSON.parse(fs.readFileSync(this.blocksJsonPath, 'utf-8') || '{}')
              delete data[hash]
              fs.writeFileSync(this.blocksJsonPath, JSON.stringify(data), 'utf-8')
            }
            blocksRemoved++
          }
        }

        // If using JSON, also ensure we only keep the most recent blocks
        if (!this.useLmdb && finalBlocks.length > 0) {
          const limitedData: Record<string, Block> = {}
          for (const block of finalBlocks) {
            limitedData[block.hash] = block
          }
          fs.writeFileSync(this.blocksJsonPath, JSON.stringify(limitedData), 'utf-8')
        }
      }

      // Reset balances
      if (resetBalances) {
        const allMiners = this.getAllMiners()
        for (const [address, miner] of allMiners) {
          if (miner.balance > 0n) {
            this.addBalance(address, -miner.balance)
            balancesReset++
          }
        }
      }

      return { blocksRemoved, balancesReset }
    } catch (error) {
      console.error(`[Database] Error during cleanup:`, error)
      throw error
    }
  }
}