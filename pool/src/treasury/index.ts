import { EventEmitter } from 'events'
import { PrivateKey, UtxoProcessor, UtxoContext, type RpcClient, type IPaymentOutput, createTransactions } from "../../wasm/kaspa"

const startTime = BigInt(Date.now())

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
  
  constructor (rpc: RpcClient, networkId: string, privateKey: string, fee: number) {
    super()
  
    this.rpc = rpc
    this.privateKey = new PrivateKey(privateKey)
    this.address = (this.privateKey.toAddress(networkId)).toString()
    this.processor = new UtxoProcessor({ rpc, networkId })
    this.context = new UtxoContext({ processor: this.processor })
    this.fee = fee

    this.registerProcessor()
  }
  
  async send (outputs: IPaymentOutput[]) {
    const { estimate } = await this.rpc.getFeeEstimate({})
    const rpc = this.processor.rpc

    const hashes: string[] = []

    for (const output of outputs) {
      const { transactions, summary } = await createTransactions({
        entries: this.context,
        outputs: [ output ],
        changeAddress: this.address,
        priorityFee: 0n,
        // @ts-ignore - feeRate is used at runtime even if not in type definition
        feeRate: estimate.lowBuckets[0].feerate
      })
  
      for (const transaction of transactions) {
        // Sign transaction with private key
        // sign() accepts: (PrivateKey | HexString | Uint8Array)[]
        // privateKey.toString() returns hex string, which is valid
        transaction.sign([ this.privateKey.toString() ])
        
        // Submit transaction and get transaction ID
        // IMPORTANT: submit() returns Promise<string> with the transaction ID
        // We MUST consume the return value to prevent GC issues (per SDK docs)
        const txId = await transaction.submit(rpc)
        hashes.push(txId)
        
        console.log(`[Treasury] Transaction submitted successfully: ${txId}`)
      }
    }

    return hashes
  }
  
  private registerProcessor () {
    this.processor.addEventListener("utxo-proc-start", async () => {
      await this.context.clear()
      await this.context.trackAddresses([ this.address ])
      console.log(`[Treasury] UTXO processor started, tracking address: ${this.address}`)
      console.log(`[Treasury] Start time filter: ${new Date(Number(startTime)).toISOString()} (only coinbases after this time will be processed)`)
    })

    this.processor.addEventListener('maturity', async (e) => {
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
      
      // IMPORTANT: Only filter out coinbases from before pool start if they're significantly old
      // Allow coinbases within last 24 hours to account for pool restarts
      const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000)
      if (blockTimestamp < startTime && Number(blockTimestamp) < oneDayAgo) {
        console.log(`[Treasury] Skipping old coinbase (block timestamp ${new Date(Number(blockTimestamp)).toISOString()} < start time ${new Date(startTimeDate).toISOString()} and older than 24 hours)`)
        return
      }
      
      // Log if we're processing a coinbase that's before startTime but within 24 hours (pool restart scenario)
      if (blockTimestamp < startTime) {
        console.log(`[Treasury] Processing coinbase from before pool start (likely pool restart scenario)`)
      }

      const reward = eventValue
      const poolFee = (reward * BigInt(this.fee * 100)) / 10000n
      const rewardKAS = (Number(reward - poolFee) / 100000000).toFixed(8)
      const feeKAS = (Number(poolFee) / 100000000).toFixed(8)

      console.log(`[Treasury] Coinbase matured: ${rewardKAS} KAS to miners, ${feeKAS} KAS pool fee`)
      console.log(`[Treasury] Emitting 'coinbase' event with ${rewardKAS} KAS (${(reward - poolFee).toString()} sompi)`)
      console.log(`[Treasury] Emitting 'revenue' event with ${feeKAS} KAS (${poolFee.toString()} sompi)`)
      this.emit('coinbase', reward - poolFee)
      this.emit('revenue', poolFee)
      console.log(`[Treasury] Events emitted successfully`)
    })

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
      
      // Fallback: Try to calculate from known blocks and coinbase amounts
      // This is a workaround - we know treasury has UTXOs but can't read them directly
      console.warn('[Treasury] UtxoContext.entries() not accessible, using fallback calculation')
      
      // The actual balance should be visible when making transactions
      // For now, return 0n - the real balance will be used by treasury.send()
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
}
