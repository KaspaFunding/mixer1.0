// @ts-ignore - events module available at runtime
import { EventEmitter } from 'events'
import { PrivateKey, UtxoProcessor, UtxoContext, type RpcClient, type IPaymentOutput, createTransactions, type IUtxoEntry } from "../../wasm/kaspa"
import type Database from '../pool/database'

const startTime = BigInt(Date.now())
const DEBUG = false

// Kaspa post-Crescendo: 10 blocks/second
// Reduced maturity for faster payouts (protocol allows this, node will enforce minimum)
// At 10 BPS: 100 blocks = 10 seconds, 200 blocks = 20 seconds, 500 blocks = 50 seconds
UtxoProcessor.setCoinbaseTransactionMaturityDAA('mainnet', 100n)  // ~10 seconds at 10 BPS
UtxoProcessor.setCoinbaseTransactionMaturityDAA('testnet-10', 100n)
UtxoProcessor.setCoinbaseTransactionMaturityDAA('testnet-11', 2000n)

export default class Treasury extends EventEmitter {
  privateKey: PrivateKey
  address: string
  processor: UtxoProcessor
  context: UtxoContext
  fee: number
  rpc: RpcClient
  networkId: string
  private database: Database | null = null
  
  // Block queue management
  private blockQueue: Map<string, any> = new Map()
  private lastBlockTimestamp: number = Date.now()
  private queueStarted = false
  private watchdogStarted = false
  reconnecting = false
  
  constructor (rpc: RpcClient, networkId: string, privateKey: string, fee: number, database?: Database) {
    super()
  
    this.rpc = rpc
    this.networkId = networkId
    this.privateKey = new PrivateKey(privateKey)
    this.address = (this.privateKey.toAddress(networkId)).toString()
    this.processor = new UtxoProcessor({ rpc, networkId })
    this.context = new UtxoContext({ processor: this.processor })
    this.fee = fee
    this.database = database || null

    console.log(`[Treasury] Pool Wallet Address: ${this.address}`)
    
    this.registerProcessor()
    
    // Subscribe to block-added events
    try {
      this.rpc.subscribeBlockAdded()
    } catch (error) {
      console.error(`[Treasury] SUBSCRIBE ERROR:`, error)
    }

    // Start block listener and watchdog
    try {
      this.listenToBlocks()
      this.startWatchdog()
    } catch (error) {
      console.error(`[Treasury] LISTEN ERROR:`, error)
    }
  }
  
  // Convert RPC UTXO entry to IUtxoEntry format
  private convertRpcUtxoToEntry(utxo: any): IUtxoEntry {
    const outpoint = utxo.outpoint || {
      transactionId: String(utxo.transactionId || utxo.txId || utxo.txid || ''),
      index: typeof utxo.index === 'number' ? utxo.index : (utxo.outpoint?.index || 0)
    }
    
    const amount = typeof utxo.amount === 'bigint' ? utxo.amount : BigInt(String(utxo.amount || '0'))
    const blockDaaScore = typeof utxo.blockDaaScore === 'bigint' 
      ? utxo.blockDaaScore 
      : BigInt(String(utxo.blockDaaScore || '0'))
    const isCoinbase = utxo.isCoinbase === true || utxo.isCoinbase === 1
    
    const scriptPublicKey = utxo.scriptPublicKey || {
      version: utxo.scriptPublicKeyVersion || 0,
      script: String(utxo.scriptPublicKeyScript || utxo.scriptPublicKey?.script || '')
    }
    
    return {
      outpoint: {
        transactionId: String(outpoint.transactionId),
        index: typeof outpoint.index === 'number' ? outpoint.index : 0
      },
      amount,
      scriptPublicKey: {
        version: typeof scriptPublicKey.version === 'number' ? scriptPublicKey.version : 0,
        script: String(scriptPublicKey.script || '')
      },
      blockDaaScore,
      isCoinbase
    }
  }

  // Fetch UTXOs from RPC and convert to IUtxoEntry format
  private async fetchAndConvertUtxos(): Promise<IUtxoEntry[]> {
    try {
      const utxoResult = await this.rpc.getUtxosByAddresses({ addresses: [this.address] })
      if (!utxoResult || !utxoResult.entries || utxoResult.entries.length === 0) {
        console.warn(`[Treasury] No UTXOs found at treasury address ${this.address} - cannot create transactions`)
        throw new Error(`Insufficient funds: No UTXOs available at treasury address`)
      }
      
      const utxoEntries = utxoResult.entries.map((utxo: any) => this.convertRpcUtxoToEntry(utxo))
      console.log(`[Treasury] Fetched ${utxoEntries.length} UTXO(s) from RPC for transaction creation`)
      return utxoEntries
    } catch (error) {
      console.error(`[Treasury] Error fetching UTXOs from RPC: ${error instanceof Error ? error.message : String(error)}`)
      throw new Error(`Failed to fetch UTXOs: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Validate that sufficient funds are available
  private validateSufficientFunds(utxoEntries: IUtxoEntry[], totalAmountNeeded: bigint): void {
    const totalUtxoValue = utxoEntries.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n)
    
    console.log(`[Treasury] Total amount needed: ${(Number(totalAmountNeeded) / 100000000).toFixed(8)} KAS`)
    console.log(`[Treasury] Total UTXO value available: ${(Number(totalUtxoValue) / 100000000).toFixed(8)} KAS`)
    
    if (totalUtxoValue < totalAmountNeeded) {
      const shortfall = totalAmountNeeded - totalUtxoValue
      const shortfallKAS = (Number(shortfall) / 100000000).toFixed(8)
      throw new Error(`Insufficient funds: Need ${(Number(totalAmountNeeded) / 100000000).toFixed(8)} KAS but only have ${(Number(totalUtxoValue) / 100000000).toFixed(8)} KAS (shortfall: ${shortfallKAS} KAS)`)
    }
  }

  // Process a single payment output
  private async processPaymentOutput(output: IPaymentOutput, estimate: any, rpc: any): Promise<string[]> {
    // Refetch UTXOs for each transaction to ensure latest state
    const utxoResult = await this.rpc.getUtxosByAddresses({ addresses: [this.address] })
    if (!utxoResult || !utxoResult.entries || utxoResult.entries.length === 0) {
      throw new Error(`Insufficient funds: No UTXOs available for payment to ${output.address}`)
    }
    
    const currentUtxoEntries = utxoResult.entries.map((utxo: any) => this.convertRpcUtxoToEntry(utxo))
    const currentUtxoValue = currentUtxoEntries.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n)
    
    if (currentUtxoValue < BigInt(output.amount)) {
      throw new Error(`Insufficient funds: Need ${(Number(output.amount) / 100000000).toFixed(8)} KAS but only have ${(Number(currentUtxoValue) / 100000000).toFixed(8)} KAS`)
    }
    
    // Create transactions using UTXOs from RPC
    const { transactions } = await createTransactions({
      entries: currentUtxoEntries,
      outputs: [ output ],
      changeAddress: this.address,
      priorityFee: 0n,
      networkId: this.networkId,
      // @ts-ignore - feeRate is used at runtime even if not in type definition
      feeRate: estimate.lowBuckets[0].feerate
    })

    const hashes: string[] = []
    for (const transaction of transactions) {
      transaction.sign([ this.privateKey.toString() ])
      const txId = await transaction.submit(rpc)
      hashes.push(txId)
      
      console.log(`[Treasury] Transaction submitted successfully: ${txId}`)
      console.log(`[Treasury] Payment: ${(Number(output.amount) / 100000000).toFixed(8)} KAS to ${output.address}`)
    }
    
    return hashes
  }

  async send (outputs: IPaymentOutput[]) {
    const { estimate } = await this.rpc.getFeeEstimate({})
    const rpc = this.processor.rpc

    // Fetch UTXOs and validate total funds
    const utxoEntries = await this.fetchAndConvertUtxos()
    const totalAmountNeeded = outputs.reduce((sum, output) => sum + BigInt(output.amount), 0n)
    this.validateSufficientFunds(utxoEntries, totalAmountNeeded)

    // Process each output separately, refetching UTXOs to avoid double-spending
    const allHashes: string[] = []
    for (const output of outputs) {
      try {
        const txHashes = await this.processPaymentOutput(output, estimate, rpc)
        allHashes.push(...txHashes)
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.error(`[Treasury] Error creating/sending transaction for ${output.address}: ${errorMsg}`)
        throw new Error(`Failed to send payment to ${output.address}: ${errorMsg}`)
      }
    }

    return allHashes
  }
  
  utxoProcStartHandler = async () => {
    await this.context.clear()
    await this.context.trackAddresses([this.address])
    console.log(`[Treasury] UTXO processor started, tracking address: ${this.address}`)
    console.log(`[Treasury] Start time filter: ${new Date(Number(startTime)).toISOString()} (only coinbases after this time will be processed)`)
  }

  maturityHandler = async (e: any) => {
      // @ts-ignore - isCoinbase, value, and blockDaaScore exist on TransactionRecord at runtime
      if (!e.data.isCoinbase) return
      
      // @ts-ignore - blockDaaScore exists on TransactionRecord at runtime
      const eventBlockDaaScore = e.data.blockDaaScore
      const { timestamps } = await this.rpc.getDaaScoreTimestampEstimate({
        daaScores: [ eventBlockDaaScore ]
      })

      const blockTimestamp = timestamps[0]
      const startTimeDate = Number(startTime)
      
      // @ts-ignore - value exists on TransactionRecord at runtime
      const eventValue = e.data.value
      
      console.log(`[Treasury] Coinbase maturity event: value=${eventValue.toString()} sompi, blockDaaScore=${eventBlockDaaScore}, timestamp=${new Date(Number(blockTimestamp)).toISOString()}`)
      console.log(`[Treasury] Start time filter: ${new Date(startTimeDate).toISOString()}, Block timestamp: ${new Date(Number(blockTimestamp)).toISOString()}`)
      
      // Filter out old coinbases, but allow coinbases within last 24 hours for pool restarts
      const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000)
      if (blockTimestamp < startTime && Number(blockTimestamp) < oneDayAgo) {
        console.log(`[Treasury] Skipping old coinbase (block timestamp ${new Date(Number(blockTimestamp)).toISOString()} < start time ${new Date(startTimeDate).toISOString()} and older than 24 hours)`)
        return
      }
      
      // Log coinbase processing from before startTime (pool restart scenario)
      if (blockTimestamp < startTime) {
        console.log(`[Treasury] Processing coinbase from before pool start (likely pool restart scenario)`)
      }

      const reward = eventValue
      const poolFee = (reward * BigInt(this.fee * 100)) / 10000n
      const rewardKAS = (Number(reward - poolFee) / 100000000).toFixed(8)
      const feeKAS = (Number(poolFee) / 100000000).toFixed(8)

      console.log(`[Treasury] Coinbase matured: ${rewardKAS} KAS to miners, ${feeKAS} KAS pool fee`)
      
      // @ts-ignore - transaction ID exists at runtime
      const txnId = e.data.id
      
      // Try to fetch reward block hash from database
      let reward_block_hash = await this.fetchRewardBlockHash(txnId.toString())
      
      if (!reward_block_hash && this.database && typeof this.database.getRewardBlockHash === 'function') {
        reward_block_hash = (await this.database.getRewardBlockHash(txnId.toString(), false)) || ''
      }

      console.log(`[Treasury] Emitting 'coinbase' event with ${rewardKAS} KAS (${(reward - poolFee).toString()} sompi)`)
      
      // Emit coinbase event with full coinbase amount and metadata
      if (reward_block_hash) {
        // @ts-ignore - EventEmitter.emit is available at runtime
        this.emit('coinbase', reward - poolFee, reward, reward_block_hash, txnId, eventBlockDaaScore)
      } else {
        // @ts-ignore - EventEmitter.emit is available at runtime
        this.emit('coinbase', reward - poolFee, reward, '', txnId, eventBlockDaaScore)
      }
      
      // @ts-ignore - EventEmitter.emit is available at runtime
      this.emit('revenue', poolFee)
      console.log(`[Treasury] Events emitted successfully`)
    }

  private registerProcessor () {
    this.processor.addEventListener("utxo-proc-start", this.utxoProcStartHandler)
    this.processor.addEventListener('maturity', this.maturityHandler)

    this.processor.start()
    console.log(`[Treasury] UTXO processor started, waiting for coinbase maturity events...`)
  }

  // Get the actual UTXO balance for the treasury address
  async getBalance(): Promise<bigint> {
    try {
      // Try multiple methods to get UTXO entries from UtxoContext
      let entries: any[] = []
      
      // Method 1: Try entries() as iterator
      try {
        // @ts-ignore - entries() may exist as iterator
        entries = Array.from(this.context.entries() || [])
      } catch (err) {
        // Method 2: Try as array property
        try {
          // @ts-ignore - entries may be a property
          entries = this.context.entries || []
        } catch (err2) {
          // Method 3: Try using iterator directly
          try {
            // @ts-ignore - context may be iterable
            entries = Array.from(this.context || [])
          } catch (err3) {
            console.warn('[Treasury] Could not access UtxoContext entries via any method')
          }
        }
      }
      
      // Sum up all UTXO values
      let totalBalance = 0n
      if (entries && entries.length > 0) {
        for (const entry of entries) {
          // @ts-ignore - entry.value exists at runtime
          if (entry && entry.value) {
            const value = entry.value
            // Value might be bigint, number, or string
            const valueBigInt = typeof value === 'bigint' ? value : 
                               typeof value === 'number' ? BigInt(value) :
                               typeof value === 'string' ? BigInt(value) : 0n
            totalBalance += valueBigInt
          }
        }
      }
      
      // If we got balance, return it
      if (totalBalance > 0n) {
        return totalBalance
      }
      
      // Fallback: UtxoContext entries not accessible (workaround - balance visible in transactions)
      console.warn('[Treasury] UtxoContext.entries() not accessible, using fallback calculation')
      return 0n
    } catch (error) {
      console.error('[Treasury] Error getting balance from UtxoContext:', error)
      return 0n
    }
  }

  // Get balance as KAS (human-readable)
  async getBalanceKAS(): Promise<number> {
    const balanceSompi = await this.getBalance()
    return Number(balanceSompi) / 100000000
  }

  // Block queue management methods
  async listenToBlocks() {
    this.rpc.addEventListener('block-added', this.blockAddedHandler)
    
    if (!this.queueStarted) {
      this.queueStarted = true
      this.startQueueProcessor()
    }
  }

  blockAddedHandler = async (eventData: any) => {
    try {
      const data = eventData.data
      const reward_block_hash = data?.block?.header?.hash

      if (!reward_block_hash) {
        if (DEBUG) console.log('[Treasury] Block hash is undefined')
        return
      }

      // Prevent queue overflow
      if (this.blockQueue.size > 1000) {
        console.error('[Treasury] Block queue overflow. Dropping oldest entries.')
        const keys = Array.from(this.blockQueue.keys()).slice(0, 100)
        for (const key of keys) {
          this.blockQueue.delete(key)
        }
      }

      this.lastBlockTimestamp = Date.now()

      if (!this.blockQueue.has(reward_block_hash)) {
        this.blockQueue.set(reward_block_hash, data)
      } else {
        if (DEBUG) console.log(`[Treasury] Duplicate block ${reward_block_hash.substring(0, 16)}... ignored`)
      }
    } catch (error) {
      console.error(`[Treasury] Error in block-added handler:`, error)
    }
  }

  private startWatchdog() {
    if (this.watchdogStarted) return
    
    this.watchdogStarted = true
    
    setInterval(() => {
      const secondsSinceLastBlock = (Date.now() - this.lastBlockTimestamp) / 1000
      
      if (secondsSinceLastBlock > 120) {
        if (DEBUG) {
          console.log('[Treasury] Watchdog - No block received in 2 minutes. Reconnecting RPC...')
        }
        this.reconnectBlockListener()
      }
    }, 30000) // Check every 30 seconds
  }

  private startQueueProcessor() {
    const MAX_PARALLEL_JOBS = 10
    let activeJobs = 0

    const processQueue = async () => {
      while (true) {
        while (activeJobs < MAX_PARALLEL_JOBS && this.blockQueue.size > 0) {
          const nextEntry = this.blockQueue.entries().next().value
          if (!nextEntry) continue

          const [hash, data] = nextEntry
          this.blockQueue.delete(hash)

          activeJobs++

          // Process block in parallel
          ;(async () => {
            try {
              await this.processBlockData(data)
            } catch (error) {
              console.error(`[Treasury] Error in parallel handler:`, error)
            } finally {
              activeJobs--
            }
          })()
        }

        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }

    processQueue()
  }

  async reconnectBlockListener() {
    if (this.reconnecting) return
    
    this.reconnecting = true

    try {
      this.rpc.removeEventListener('block-added', this.blockAddedHandler)
      this.rpc.unsubscribeBlockAdded()
      this.rpc.subscribeBlockAdded()
      await this.listenToBlocks()
    } catch (error) {
      console.error(`[Treasury] Error during reconnectBlockListener:`, error)
      setTimeout(() => this.reconnectBlockListener(), 5000) // Retry after 5 seconds
    } finally {
      this.reconnecting = false
    }
  }

  private async processBlockData(data: any) {
    const transactions = data?.block?.transactions || []
    const isChainBlock = data?.block?.verboseData?.isChainBlock

    if (!Array.isArray(transactions) || transactions.length === 0) return

    const TARGET_ADDRESS = this.address

    txLoop: for (const tx of transactions) {
      for (const [index, vout] of (tx.outputs || []).entries()) {
        const addr = vout?.verboseData?.scriptPublicKeyAddress

        if (addr === TARGET_ADDRESS) {
          try {
            const reward_block_hash = data?.block?.header?.hash
            const txId = tx.verboseData?.transactionId

            if (DEBUG) {
              console.log(`[Treasury] Reward hash: ${reward_block_hash} | TX: ${txId}`)
            }

            // If database is available, track reward block hash
            if (this.database && typeof this.database.addRewardBlockHash === 'function') {
              const reward_block_hashDB = await this.database.getRewardBlockHash(txId.toString(), true)

              if (!reward_block_hashDB) {
                // No entry exists — insert new
                await this.database.addRewardBlockHash(reward_block_hash, txId.toString())
              } else if (reward_block_hashDB !== reward_block_hash && isChainBlock) {
                // Entry exists with different block hash and is chain block — update
                await this.database.addRewardBlockHash(reward_block_hash, txId.toString())
              }
            }

            break txLoop
          } catch (error) {
            console.error(`[Treasury] Error processing reward details:`, error)
            break txLoop
          }
        }
      }
    }
  }

  // Get reward block hash from transaction ID (for use in maturity handler)
  async fetchRewardBlockHash(txId: string): Promise<string | null> {
    if (this.database && typeof this.database.getRewardBlockHash === 'function') {
      return await this.database.getRewardBlockHash(txId, false)
    }
    return null
  }

  async unregisterProcessor() {
    if (DEBUG) console.log(`[Treasury] unregisterProcessor - this.context.clear()`)
    
    await this.context.clear()
    
    if (DEBUG) console.log(`[Treasury] Removing event listeners`)
    
    this.processor.removeEventListener('utxo-proc-start', this.utxoProcStartHandler)
    this.context.unregisterAddresses([this.address])
    this.processor.removeEventListener('maturity', this.maturityHandler)
    
    // Remove block-added listener
    this.rpc.removeEventListener('block-added', this.blockAddedHandler)
    
    await this.processor.stop()
  }
}
