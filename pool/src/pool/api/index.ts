import Server from './server'
import type Stratum from '../../stratum'
import type Treasury from '../../treasury'
import type Database from '../database'

type Worker = {
  name: string,
  agent: string,
  difficulty: number
}

// Helper to format hashrate
function formatHashrate(hashrate: number): string {
  if (hashrate === 0) return '0 H/s'
  if (hashrate < 1000) return `${hashrate.toFixed(2)} H/s`
  if (hashrate < 1000000) return `${(hashrate / 1000).toFixed(2)} KH/s`
  if (hashrate < 1000000000) return `${(hashrate / 1000000).toFixed(2)} MH/s`
  const gh = hashrate / 1000000000
  if (gh >= 1000) return `${(gh / 1000).toFixed(2)} TH/s`
  return `${gh.toFixed(2)} GH/s`
}

export default class Api extends Server {
  private treasury: Treasury
  private stratum: Stratum
  private database: Database
  private pool: any // Reference to Pool instance for force payout

  constructor (port: number, treasury: Treasury, stratum: Stratum, database: Database, pool?: any) {
    super({
      '/status': () => this.status(),
      '/miners': () => this.getMiners(),
      '/miner': ({ address }) => this.getMiner(address),
      '/blocks': ({ limit }) => this.getBlocks(limit ? parseInt(limit) : undefined),
      '/blocks/:address': ({ address, limit }) => this.getBlocksByAddress(address, limit ? parseInt(limit) : undefined),
      '/network-info': () => this.getNetworkInfo(),
      '/pool-stats': () => this.getPoolStats(),
      '/treasury-balance': () => this.getTreasuryBalance(),
      '/transaction/:hash': ({ hash }) => this.getTransaction(hash),
      '/block-reward': () => this.getBlockReward(),
      '/payouts/force-all': {
        post: async () => this.forcePayoutAll()
      },
      '/payouts/force/:address': {
        post: async ({ address }) => this.forcePayoutMiner(address)
      },
      '/payments/record': {
        post: async (body) => this.recordPaymentManually(body.txHash, body.address, body.amount)
      },
      '/treasury/check-maturity': {
        post: async () => this.checkCoinbaseMaturity()
      },
      '/treasury/distribute-matured': {
        post: async () => this.distributeMaturedRewards()
      },
      '/miner/update-payment-interval': {
        post: async (body) => this.updatePaymentInterval(body.address, body.intervalHours, body.verificationIP)
      },
      '/miner/update-threshold': {
        post: async (body) => this.updatePaymentThreshold(body.address, body.threshold, body.verificationIP)
      }
    }, port)

    this.treasury = treasury
    this.stratum = stratum
    this.database = database
    this.pool = pool
  }

  private status () {
    const poolHashrate = this.stratum.getPoolHashrate()
    const recentBlocks = this.database.getBlocks(10)
    
    return {
      networkId: this.treasury.processor.networkId!,
      miners: this.stratum.miners.size,
      workers: this.stratum.subscriptors.size,
      blocksFound: this.database.getTotalBlockCount(),
      poolHashrate: poolHashrate,
      poolHashrateFormatted: formatHashrate(poolHashrate),
      recentBlocks: recentBlocks.map(b => ({
        hash: b.hash,
        address: b.address,
        timestamp: b.timestamp,
        difficulty: b.difficulty
      }))
    }
  }

  private getMiners () {
    const miners = Array.from(this.stratum.miners.keys()).map((address) => {
      const miner = this.database.getMiner(address)
      const connections = this.stratum.miners.get(address)
      
      const workers = connections ? Array.from(connections).flatMap((session) => {
        const { agent, difficulty, workers } = session.data

        return Array.from(workers, ([, workerName ]) => ({
            name: workerName,
            agent,
            difficulty: difficulty.toNumber()
        }))
      }) : []

      // Format address with kaspa: prefix for display
      const formattedAddress = address.startsWith('kaspa:') ? address : `kaspa:${address}`

      const blocksFound = this.database.getBlockCount(address)
      const hashrate = this.stratum.getMinerHashrate(address)

      return {
        address: formattedAddress,
        balance: miner.balance.toString(),
        connections: connections?.size ?? 0,
        workers: workers.length,
        workersDetail: workers,
        blocksFound: blocksFound,
        hashrate: hashrate,
        hashrateFormatted: formatHashrate(hashrate)
      }
    })

    return { miners }
  }

  private getMiner (address: string) {
    // Remove kaspa: prefix if present for internal lookup (addresses stored without prefix)
    const addressWithoutPrefix = address.replace(/^(kaspa:?|kaspatest:?)/i, '')
    
    // Check if this is the treasury address - treasury balance is tracked as 'me'
    const treasuryAddressClean = this.treasury.address.replace(/^(kaspa:?|kaspatest:?)/i, '')
    if (addressWithoutPrefix.toLowerCase() === treasuryAddressClean.toLowerCase()) {
      // Return treasury/pool balance info
      const treasuryMiner = this.database.getMiner('me')
      return {
        address: this.treasury.address.startsWith('kaspa:') ? this.treasury.address : `kaspa:${this.treasury.address}`,
        balance: treasuryMiner.balance.toString(),
        balanceKAS: (BigInt(treasuryMiner.balance) / 100000000n).toString(),
        connections: 0,
        workers: [],
        paymentIntervalHours: null,
        paymentThreshold: null,
        lastPayoutTime: null,
        nextPayoutTime: null,
        hashrate: 0,
        hashrateFormatted: '0 H/s',
        blocks: [],
        payments: [],
        isTreasury: true,
        note: 'This is the pool treasury address. Balance represents pool fees collected.'
      }
    }
    
    const miner = this.database.getMiner(addressWithoutPrefix)
    const connections = this.stratum.miners.get(addressWithoutPrefix)

    const workers = connections ? Array.from(connections).flatMap((session) => {
      const { agent, difficulty, workers } = session.data

      return Array.from(workers, ([, workerName ]) => ({
          name: workerName,
          agent,
          difficulty: difficulty.toNumber()
      }))
    }) : []

    // Format address with kaspa: prefix for display
    const formattedAddress = addressWithoutPrefix.startsWith('kaspa:') ? addressWithoutPrefix : `kaspa:${addressWithoutPrefix}`

    // Get payment interval info
    const paymentIntervalHours = this.database.getPaymentInterval(addressWithoutPrefix)
    const lastPayoutTime = this.database.getLastPayoutTime(addressWithoutPrefix)
    const paymentThreshold = this.database.getPaymentThreshold(addressWithoutPrefix)
    const hashrate = this.stratum.getMinerHashrate(addressWithoutPrefix)
    const blocks = this.database.getBlocksByAddress(addressWithoutPrefix, 10)
    const payments = this.database.getPaymentsByAddress(addressWithoutPrefix, 10)
    
    let nextPayoutTime: number | null = null
    if (paymentIntervalHours && paymentIntervalHours > 0 && lastPayoutTime) {
      nextPayoutTime = lastPayoutTime + (paymentIntervalHours * 60 * 60 * 1000)
    }

    return {
      address: formattedAddress,
      balance: miner.balance.toString(),
      connections: connections?.size ?? 0,
      workers,
      paymentIntervalHours: paymentIntervalHours ?? null,
      paymentThreshold: paymentThreshold ? paymentThreshold.toString() : null,
      lastPayoutTime: lastPayoutTime ?? null,
      nextPayoutTime: nextPayoutTime,
      hashrate: hashrate,
      hashrateFormatted: formatHashrate(hashrate),
      blocks: blocks.map(b => ({
        hash: b.hash,
        timestamp: b.timestamp,
        difficulty: b.difficulty,
        paid: b.paid ?? false
      })),
      payments: payments.map(p => ({
        hash: p.hash,
        amount: p.amount,
        timestamp: p.timestamp
      }))
    }
  }

  private getBlocks(limit: number | undefined) {
    const blocks = this.database.getBlocks(limit || 100)
    return {
      blocks: blocks.map(b => ({
        hash: b.hash,
        address: b.address,
        timestamp: b.timestamp,
        difficulty: b.difficulty,
        paid: b.paid ?? false
      }))
    }
  }

  private getBlocksByAddress(address: string, limit: number | undefined) {
    const addressWithoutPrefix = address.replace(/^(kaspa:?|kaspatest:?)/i, '')
    const blocks = this.database.getBlocksByAddress(addressWithoutPrefix, limit || 100)
    return {
      blocks: blocks.map(b => ({
        hash: b.hash,
        timestamp: b.timestamp,
        difficulty: b.difficulty,
        paid: b.paid ?? false
      }))
    }
  }

  private async getNetworkInfo() {
    try {
      const info = await this.treasury.rpc.getInfo({})
      const dagInfo = await this.treasury.rpc.getBlockDagInfo({})
      const peerInfo = await this.treasury.rpc.getConnectedPeerInfo({}).catch(() => null)
      
      // Safely extract values with BigInt handling
      // Note: getBlockDagInfo returns blockCount and headerCount (not blocks/headers)
      const safeBlockCount = dagInfo.blockCount !== undefined ? dagInfo.blockCount.toString() : '0'
      const safeHeaderCount = dagInfo.headerCount !== undefined ? dagInfo.headerCount.toString() : '0'
      const safeDaaScore = dagInfo.virtualDaaScore !== undefined ? dagInfo.virtualDaaScore.toString() : '0'
      const tipHashes = dagInfo.tipHashes || []
      const difficulty = dagInfo.difficulty !== undefined ? dagInfo.difficulty.toString() : '0'
      
      // Extract peer count from getConnectedPeerInfo response
      // Response structure can vary: direct array, or object with connectedPeerInfo/peerInfo array
      let peerCount = 0
      if (peerInfo) {
        if (Array.isArray(peerInfo)) {
          peerCount = peerInfo.length
        } else if (peerInfo && Array.isArray((peerInfo as any).connectedPeerInfo)) {
          peerCount = (peerInfo as any).connectedPeerInfo.length
        } else if (peerInfo && Array.isArray((peerInfo as any).peerInfo)) {
          peerCount = (peerInfo as any).peerInfo.length
        } else if (peerInfo && typeof peerInfo === 'object') {
          // Try to find any array property
          for (const key in peerInfo) {
            if (Array.isArray((peerInfo as any)[key])) {
              peerCount = (peerInfo as any)[key].length
              break
            }
          }
        }
      }
      
      return {
        networkId: this.treasury.processor.networkId!,
        serverVersion: info.serverVersion || 'Unknown',
        blockCount: safeBlockCount,
        headerCount: safeHeaderCount,
        virtualDaaScore: safeDaaScore,
        difficulty: difficulty,
        tips: tipHashes.length,
        isSynced: info.isSynced ?? false,
        peerCount: peerCount
      }
    } catch (error) {
      console.error('[API] Error getting network info:', error)
      return {
        networkId: this.treasury.processor.networkId!,
        error: 'Failed to fetch network information',
        serverVersion: 'Unknown',
        blockCount: '0',
        headerCount: '0',
        virtualDaaScore: '0',
        difficulty: '0',
        tips: 0,
        isSynced: false,
        peerCount: 0
      }
    }
  }

  private async getBlockReward() {
    try {
      
      
      // Get current DAA score to calculate current reward
      const dagInfo = await this.treasury.processor.rpc.getBlockDagInfo({})
      const daaScore = dagInfo.virtualDaaScore ? BigInt(dagInfo.virtualDaaScore.toString()) : 0n
      
      if (daaScore === 0n) {
        return { error: 'Could not get DAA score', reward: null }
      }
      
    
      
      if (!dagInfo.tipHashes || dagInfo.tipHashes.length === 0) {
        return { error: 'No tip hashes available', reward: null }
      }
      
    
      const sampleCount = Math.min(10, dagInfo.tipHashes.length)
      const rewards: number[] = []
      
      for (let i = 0; i < sampleCount && rewards.length < 5; i++) {
        try {
          const blockHash = dagInfo.tipHashes[i]
          const blockResponse = await this.treasury.processor.rpc.getBlock({
            hash: blockHash,
            includeTransactions: true
          })
          
          if (blockResponse?.block?.transactions && blockResponse.block.transactions.length > 0) {
            // First transaction is always coinbase
            const coinbaseTx = blockResponse.block.transactions[0]
            let totalReward = 0n
            
            // Sum all outputs in coinbase transaction
            // This should be the total block reward
            if (coinbaseTx.outputs && coinbaseTx.outputs.length > 0) {
              for (const output of coinbaseTx.outputs) {
                const value = output.value
                if (value) {
                  totalReward += BigInt(value)
                }
              }
            }
            
            // Convert from sompi to KAS
            const rewardKAS = Number(totalReward) / 100000000
            
            // Filter for reasonable rewards (4-10 KAS expected as of Nov 2025)
            // Some blocks might have anomalies, so we filter outliers
            // Note: Tip blocks may include transaction fees or other outputs, so only accept reasonable values
            if (rewardKAS >= 2 && rewardKAS <= 15) {
              rewards.push(rewardKAS)
            }
          }
        } catch (err) {
          // Skip this block if we can't read it
          continue
        }
      }
      
      if (rewards.length === 0) {
        return { error: 'Could not extract valid block rewards from sample blocks', reward: null }
      }
      
      // Calculate median reward (more stable than average for outliers)
      rewards.sort((a, b) => a - b)
      const medianIndex = Math.floor(rewards.length / 2)
      const medianReward = rewards.length % 2 === 0
        ? (rewards[medianIndex - 1] + rewards[medianIndex]) / 2
        : rewards[medianIndex]
      
      console.log('[API] Block reward (median from', rewards.length, 'blocks):', medianReward.toFixed(4), 'KAS (samples:', rewards.map(r => r.toFixed(2)).join(', '), ')')
      
      return {
        reward: medianReward,
        rewardSompi: (BigInt(Math.round(medianReward * 100000000))).toString()
      }
    } catch (error) {
      console.error('[API] Error getting block reward:', error)
      return {
        error: error instanceof Error ? error.message : String(error),
        reward: null
      }
    }
  }

  private getPoolStats() {
    const poolFee = this.treasury.fee
    const poolEarnings = this.database.getMiner('me').balance.toString()
    const recentPayments = this.database.getRecentPayments(10)
    const totalBlocks = this.database.getTotalBlockCount()
    const poolHashrate = this.stratum.getPoolHashrate()
    const poolEarningsKAS = (BigInt(poolEarnings) / 100000000n).toString()
    
    return {
      poolFee,
      poolEarnings,
      poolEarningsKAS,
      totalBlocks,
      poolHashrate,
      poolHashrateFormatted: formatHashrate(poolHashrate),
      recentPayments: recentPayments.map(p => ({
        hash: p.hash,
        address: p.address,
        amount: p.amount,
        amountKAS: (BigInt(p.amount) / 100000000n).toString(),
        timestamp: p.timestamp
      }))
    }
  }

  private updatePaymentThreshold(address: string, threshold: string, verificationIP: string) {
    console.log('[API] Update payment threshold called for', address, 'threshold:', threshold)
    
    // Validate inputs
    if (!address || !threshold || verificationIP === undefined || verificationIP === null) {
      return { success: false, error: 'Missing required parameters' }
    }

    // Remove kaspa: prefix if present
    const addressWithoutPrefix = address.replace(/^(kaspa:?|kaspatest:?)/i, '')

    // Convert threshold to bigint (from KAS to Sompi)
    const thresholdValue = BigInt(Math.floor(parseFloat(threshold) * 100000000))
    
    // Validate threshold range (0.1 KAS to 1000 KAS) - 0 means use pool default
    if (thresholdValue < 0n) {
      return { success: false, error: 'Invalid threshold value. Must be >= 0' }
    }
    if (thresholdValue > 0n && (thresholdValue < 10000000n || thresholdValue > 100000000000n)) {
      return { success: false, error: 'Invalid threshold value. Must be between 0.1 and 1000 KAS (or 0 to use pool default)' }
    }

 

    try {
      this.database.setPaymentThreshold(addressWithoutPrefix, thresholdValue === 0n ? undefined : thresholdValue)
      console.log('[API] Payment threshold updated for', address, '(stored as:', addressWithoutPrefix + ')', 'to', thresholdValue === 0n ? 'pool default' : threshold, 'KAS')
      return { success: true, threshold: thresholdValue === 0n ? null : threshold }
    } catch (error) {
      console.error('[API] Error updating payment threshold:', error)
      return { success: false, error: 'Failed to update payment threshold' }
    }
  }

  private updatePaymentInterval(address: string, intervalHours: number | string | null | undefined, verificationIP: string) {
    // Validate inputs
    if (!address || verificationIP === undefined || verificationIP === null) {
      return { success: false, error: 'Missing required parameters' }
    }

    // Remove kaspa: prefix if present (addresses are stored without prefix in database)
    const addressWithoutPrefix = address.replace(/^(kaspa:?|kaspatest:?)/i, '')
    
    console.log('[API] Update payment interval called for', address, '(stored as:', addressWithoutPrefix + ')', 'interval:', intervalHours)

    // Handle null/undefined to disable time-based payouts
    let intervalValue: number | undefined = undefined
    if (intervalHours !== null && intervalHours !== undefined && intervalHours !== '') {
      intervalValue = typeof intervalHours === 'string' ? parseFloat(intervalHours) : intervalHours
      
      // Validate interval range (0.1 hours / 6 minutes to 168 hours / 7 days)
      // Allow 0.1 hours minimum for testing purposes
      if (isNaN(intervalValue) || intervalValue < 0.1 || intervalValue > 168) {
        return { success: false, error: 'Invalid interval value. Must be between 0.1 hours (6 minutes) and 168 hours (7 days)' }
      }
      
      // Round to 1 decimal place for precise testing (allows 0.1, 0.5, etc.)
      intervalValue = Math.round(intervalValue * 10) / 10
    }


    try {
      this.database.setPaymentInterval(addressWithoutPrefix, intervalValue)
      console.log('[API] Payment interval updated for', address, '(stored as:', addressWithoutPrefix + ')', 'to', intervalValue, 'hours')
      return { success: true, intervalHours: intervalValue }
    } catch (error) {
      console.error('[API] Error updating payment interval:', error)
      return { success: false, error: 'Failed to update payment interval' }
    }
  }

  private recordPaymentManually(txHash: string, address: string, amount: string | number) {
    try {
      // Remove kaspa: prefix if present
      const addressWithoutPrefix = address.replace(/^(kaspa:?|kaspatest:?)/i, '')
      const amountSompi = typeof amount === 'string' ? BigInt(amount) : BigInt(Math.round(parseFloat(amount.toString()) * 100000000))
      
      // Record payment in database
      this.database.addPayment({
        hash: txHash,
        address: addressWithoutPrefix,
        amount: amountSompi.toString(),
        timestamp: Date.now()
      })
      
      // Mark blocks as paid
      const blocks = this.database.getBlocksByAddress(addressWithoutPrefix, 100)
      for (const block of blocks) {
        if (!block.paid) {
          const updatedBlock = { ...block, paid: true }
          this.database.addBlock(updatedBlock)
        }
      }
      
      // Update last payout time if interval is set
      const miner = this.database.getMiner(addressWithoutPrefix)
      if (miner.paymentIntervalHours && miner.paymentIntervalHours > 0) {
        this.database.setLastPayoutTime(addressWithoutPrefix, Date.now())
      }
      
      return {
        success: true,
        message: 'Payment recorded manually',
        txHash,
        address: addressWithoutPrefix,
        amount: amountSompi.toString(),
        amountKAS: (Number(amountSompi) / 100000000).toFixed(8),
        blocksMarkedPaid: blocks.filter(b => !b.paid).length
      }
    } catch (error) {
      console.error('[API] Error recording payment manually:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private async forcePayoutMiner(address: string) {
    if (!this.pool) {
      return { success: false, error: 'Pool instance not available', paymentAmount: '0', txHash: '' }
    }

    try {
      const result = await this.pool.forcePayoutMiner(address)
      // Convert BigInt to string for JSON serialization
      return {
        ...result,
        paymentAmount: result.paymentAmount.toString()
      }
    } catch (error) {
      console.error('[API] Force payout (single miner) error:', error)
      return { 
        success: false, 
        error: error instanceof Error ? error.message : String(error),
        paymentAmount: '0',
        txHash: ''
      }
    }
  }

  private async getTransaction(hash: string) {
    try {
      // Try different RPC methods to get transaction info
      let txInfo: any = null
      
      // Method 1: Try getAcceptedTransactionIdsForBlock (need to find block first)
      // Method 2: Try querying by checking recent blocks
      // For now, let's check the transaction in a block that contains it
      
      // Since we don't have direct transaction query, we'll check recent blocks
      // and look for transactions with this hash
      const recentBlocks = this.database.getBlocks(50)
      let foundInBlock: any = null
      
      // Check if this hash matches any of our recorded blocks (might be a block hash)
      for (const block of recentBlocks) {
        if (block.hash === hash) {
          // This is a block, get its transactions
          try {
            const blockInfo = await this.treasury.processor.rpc.getBlock({ 
              hash: hash,
              includeTransactions: true 
            }).catch(() => null)
            if (blockInfo?.block?.transactions) {
              foundInBlock = blockInfo.block
              break
            }
          } catch (err) {
            console.warn('[API] Error getting block for transaction lookup:', err)
          }
        }
      }
      
      // If not found as block, try to get as transaction ID
      // The Kaspa RPC may use getTransaction or similar
      if (!foundInBlock) {
        // Try to search through recent blocks for this transaction
        const dagInfo = await this.treasury.processor.rpc.getBlockDagInfo({})
        if (dagInfo.tipHashes && dagInfo.tipHashes.length > 0) {
          // Check tip blocks for the transaction
          for (let i = 0; i < Math.min(10, dagInfo.tipHashes.length); i++) {
            try {
              const blockInfo = await this.treasury.processor.rpc.getBlock({ 
                hash: dagInfo.tipHashes[i],
                includeTransactions: true 
              }).catch(() => null)
              
              if (blockInfo?.block?.transactions) {
                const tx = blockInfo.block.transactions.find((t: any) => 
                  t.transactionId === hash || t.transactionId?.toString() === hash
                )
                if (tx) {
                  txInfo = { transaction: tx, foundInBlock: dagInfo.tipHashes[i] }
                  break
                }
              }
            } catch (err) {
              continue
            }
          }
        }
      } else {
        // Found as block, extract coinbase transaction
        if (foundInBlock.transactions && foundInBlock.transactions.length > 0) {
          txInfo = { transaction: foundInBlock.transactions[0], isBlock: true, blockHash: hash }
        }
      }
      
      if (!txInfo) {
        return { error: 'Transaction not found', hash }
      }
      
      // Parse transaction details
      const transaction = txInfo.transaction
      let totalInputs = 0n
      let totalOutputs = 0n
      
      // Sum inputs
      if (transaction.inputs && transaction.inputs.length > 0) {
        // Inputs reference previous outputs, need to check those
        // For now, we'll note the input count
      }
      
      // Sum outputs
      if (transaction.outputs && transaction.outputs.length > 0) {
        for (const output of transaction.outputs) {
          if (output.value) {
            totalOutputs += BigInt(output.value.toString())
          }
        }
      }
      
      // Check if treasury address is involved
      const treasuryAddressClean = this.treasury.address.replace(/^(kaspa:?|kaspatest:?)/i, '')
      const treasuryInvolved = {
        inInputs: false,
        inOutputs: false,
        amounts: { inputs: 0n, outputs: 0n }
      }
      
      // Check outputs for treasury address (simplified - would need to decode addresses)
      // For now, return basic transaction info
      
      return {
        hash,
        transactionId: transaction.transactionId || hash,
        inputs: transaction.inputs?.length || 0,
        outputs: transaction.outputs?.length || 0,
        totalOutputValue: totalOutputs.toString(),
        totalOutputValueKAS: (Number(totalOutputs) / 100000000).toFixed(8),
        accepted: txInfo.acceptedTransactionIds?.includes(hash) || false,
        note: 'Transaction details from Kaspa node. Check inputs/outputs for treasury address involvement.'
      }
    } catch (error) {
      console.error('[API] Error getting transaction:', error)
      return {
        error: error instanceof Error ? error.message : String(error),
        hash
      }
    }
  }

  private async getTreasuryBalance() {
    try {
      const balanceSompi = await this.treasury.getBalance()
      const balanceKAS = await this.treasury.getBalanceKAS()
      
      // Also get pool earnings (tracked in database)
      const poolEarnings = this.database.getMiner('me').balance.toString()
      const poolEarningsKAS = (BigInt(poolEarnings) / 100000000n).toString()
      
      return {
        address: this.treasury.address.startsWith('kaspa:') ? this.treasury.address : `kaspa:${this.treasury.address}`,
        utxoBalance: balanceSompi.toString(),
        utxoBalanceKAS: balanceKAS.toFixed(8),
        poolEarnings: poolEarnings,
        poolEarningsKAS: poolEarningsKAS,
        note: 'UTXO balance is the actual on-chain balance. Pool earnings is the tracked pool fee revenue.'
      }
    } catch (error) {
      console.error('[API] Error getting treasury balance:', error)
      return {
        error: error instanceof Error ? error.message : String(error),
        address: this.treasury.address.startsWith('kaspa:') ? this.treasury.address : `kaspa:${this.treasury.address}`,
        utxoBalance: '0',
        utxoBalanceKAS: '0',
        poolEarnings: '0',
        poolEarningsKAS: '0'
      }
    }
  }

  private async checkCoinbaseMaturity() {
    if (!this.pool) {
      return { success: false, error: 'Pool instance not available' }
    }

    try {
      // Get all blocks from database (get many blocks without address filter)
      // Get blocks for all known miners and combine
      const allMiners = Array.from(this.stratum.miners.keys())
      const blocksByHash = new Map<string, any>()
      
      // Get blocks for each miner address
      for (const address of allMiners) {
        const blocks = this.database.getBlocksByAddress(address, 100)
        for (const block of blocks) {
          if (!blocksByHash.has(block.hash)) {
            blocksByHash.set(block.hash, block)
          }
        }
      }
      
      // Also get blocks from status (recent blocks)
      try {
        const status = await this.status()
        if (status.recentBlocks) {
          for (const block of status.recentBlocks) {
            const fullBlock = this.database.getBlocksByAddress(block.address, 100).find(b => b.hash === block.hash)
            if (fullBlock && !blocksByHash.has(fullBlock.hash)) {
              blocksByHash.set(fullBlock.hash, fullBlock)
            }
          }
        }
      } catch (err) {
        console.warn('[API] Could not get blocks from status:', err)
      }
      
      console.log(`[API] Checking maturity for ${blocksByHash.size} unique blocks`)
      
      // Check each block's maturity status
      const maturityResults: any[] = []
      for (const [hash, block] of blocksByHash) {
        try {
          const blockInfo = await this.treasury.processor.rpc.getBlock({ hash, includeTransactions: true }).catch(() => null)
          
          if (!blockInfo?.block) {
            maturityResults.push({ hash: hash.substring(0, 16) + '...', status: 'not_found', error: 'Block not found in chain' })
            continue
          }
          
          // Check if block is blue (mature)
          const { blue } = await this.treasury.processor.rpc.getCurrentBlockColor({ hash }).catch(() => ({ blue: false }))
          
          // Get coinbase transaction value
          // CRITICAL: Only count the first transaction (coinbase) and sum its outputs
          // Coinbase transactions should only have one output to the treasury address
          let coinbaseValue = 0n
          
          if (blockInfo.block.transactions && blockInfo.block.transactions.length > 0) {
            // First transaction is always coinbase
            const coinbaseTx = blockInfo.block.transactions[0]
            
            // Verify this is actually a coinbase (should have no inputs or special input)
            // Coinbase transactions typically have no inputs or a special coinbase input
            const hasNoInputs = !coinbaseTx.inputs || coinbaseTx.inputs.length === 0
            const isCoinbaseInput = coinbaseTx.inputs && coinbaseTx.inputs.length > 0 && 
                                   coinbaseTx.inputs.some((inp: any) => inp.previousOutpoint?.index === undefined || inp.previousOutpoint?.index === 0xFFFFFFFF)
            
            if (hasNoInputs || isCoinbaseInput) {
              // This is definitely a coinbase transaction
              if (coinbaseTx.outputs && coinbaseTx.outputs.length > 0) {
                // Sum all outputs in coinbase (should be just one, but sum all to be safe)
                for (const output of coinbaseTx.outputs) {
                  if (output.value) {
                    const value = BigInt(output.value.toString())
                    coinbaseValue += value
                  }
                }
              }
            } else {
              console.warn(`[API] Block ${hash.substring(0, 16)}... first transaction doesn't look like coinbase (has ${coinbaseTx.inputs?.length || 0} inputs)`)
            }
          }
          
          // Debug log to verify coinbase values
          if (coinbaseValue > 0n) {
            const coinbaseKAS = (Number(coinbaseValue) / 100000000).toFixed(8)
            console.log(`[API] Block ${hash.substring(0, 16)}... coinbase: ${coinbaseKAS} KAS (${coinbaseValue.toString()} sompi)`)
            
            // Warn if coinbase seems too high (likely reading wrong transaction)
            if (coinbaseValue > 1000000000n) { // > 10 KAS
              console.warn(`[API] WARNING: Block ${hash.substring(0, 16)}... coinbase seems unusually high: ${coinbaseKAS} KAS`)
            }
          } else {
            console.warn(`[API] Block ${hash.substring(0, 16)}... no coinbase value found`)
          }
          
          maturityResults.push({
            hash: hash.substring(0, 16) + '...',
            fullHash: hash,
            mature: blue,
            coinbaseValue: coinbaseValue.toString(),
            coinbaseValueKAS: (Number(coinbaseValue) / 100000000).toFixed(8),
            timestamp: block.timestamp
          })
        } catch (error) {
          maturityResults.push({
            hash: hash.substring(0, 16) + '...',
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
      
      return {
        success: true,
        blocksChecked: blocksByHash.size,
        results: maturityResults,
        note: 'This checks block maturity status. If blocks are mature but rewards not distributed, the UTXO processor may not be detecting coinbase maturity events.'
      }
    } catch (error) {
      console.error('[API] Error checking coinbase maturity:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private async distributeMaturedRewards() {
    if (!this.pool) {
      return { success: false, error: 'Pool instance not available' }
    }

    try {
      // Get all blocks and check their maturity
      const maturityCheck = await this.checkCoinbaseMaturity()
      if (!maturityCheck.success || !maturityCheck.results) {
        return maturityCheck
      }

      const matureBlocks = maturityCheck.results.filter((r: any) => r.mature === true)
      
      if (matureBlocks.length === 0) {
        return {
          success: true,
          message: 'No mature blocks found to distribute',
          distributed: 0,
          totalAmount: '0'
        }
      }

      console.log(`[API] Found ${matureBlocks.length} mature blocks, triggering manual distribution`)

      // Calculate total coinbase value from mature blocks
      let totalCoinbase = 0n
      for (const block of matureBlocks) {
        if (block.coinbaseValue) {
          totalCoinbase += BigInt(block.coinbaseValue.toString())
        }
      }

      // Calculate pool fee (1% as per config)
      const poolFeePercent = 1
      const poolFee = (totalCoinbase * BigInt(poolFeePercent * 100)) / 10000n
      const minerReward = totalCoinbase - poolFee

      console.log(`[API] Total coinbase: ${(Number(totalCoinbase) / 100000000).toFixed(8)} KAS`)
      console.log(`[API] Pool fee (${poolFeePercent}%): ${(Number(poolFee) / 100000000).toFixed(8)} KAS`)
      console.log(`[API] Miner reward: ${(Number(minerReward) / 100000000).toFixed(8)} KAS`)

      // CRITICAL: Before distributing, we need to restore contributions for these blocks
      // Contributions are stored in memory (this.rewarding.rewards) but are lost on pool restart
      // We need to reconstruct them from the database blocks
      console.log(`[API] Reconstructing contributions from database blocks...`)
      
      // Import Decimal for difficulty calculation
      const Decimal = (await import('decimal.js')).default
      
      // Get all blocks from database
      const allBlocks = this.database.getBlocks(1000)
      
      // Reconstruct contributions for each mature block
      // CRITICAL: This must happen BEFORE emitting events
      const poolRewarding = this.pool ? (this.pool as any).rewarding : null
      
      if (!poolRewarding) {
        return {
          success: false,
          error: 'Pool rewarding instance not available'
        }
      }
      
      for (const matureBlock of matureBlocks) {
        const blockData = allBlocks.find((b: any) => b.hash === matureBlock.fullHash)
        if (blockData) {
          // Reconstruct contribution from block data
          // Contribution needs: address, difficulty
          const addressClean = blockData.address.replace(/^(kaspa:?|kaspatest:?)/i, '')
          const contribution = {
            address: addressClean,
            difficulty: new Decimal(blockData.difficulty || '0')
          }
          
          // Record contribution in the rewarding system
          // This populates this.rewards map which is needed for distribution
          poolRewarding.recordContributions(matureBlock.fullHash, [contribution])
          console.log(`[API] Restored contribution for block ${matureBlock.hash.substring(0, 16)}... from ${addressClean} (difficulty: ${blockData.difficulty})`)
        } else {
          console.warn(`[API] Block ${matureBlock.hash.substring(0, 16)}... not found in database`)
        }
      }
      
      // Verify contributions were restored
      const rewardsCount = poolRewarding.rewards ? poolRewarding.rewards.size : 0
      console.log(`[API] Contributions restored. Rewards map now has ${rewardsCount} block(s)`)

      // Now manually trigger distribution by emitting events
      // This simulates what the UTXO processor should have done
      // Emit revenue first, then coinbase (order shouldn't matter but being explicit)
      console.log(`[API] Emitting 'revenue' event with ${(Number(poolFee) / 100000000).toFixed(8)} KAS`)
      this.treasury.emit('revenue', poolFee)
      
      console.log(`[API] Emitting 'coinbase' event with ${(Number(minerReward) / 100000000).toFixed(8)} KAS`)
      this.treasury.emit('coinbase', minerReward)

      return {
        success: true,
        message: 'Manually triggered reward distribution for mature blocks',
        matureBlocks: matureBlocks.length,
        totalCoinbase: totalCoinbase.toString(),
        totalCoinbaseKAS: (Number(totalCoinbase) / 100000000).toFixed(8),
        poolFee: poolFee.toString(),
        poolFeeKAS: (Number(poolFee) / 100000000).toFixed(8),
        minerReward: minerReward.toString(),
        minerRewardKAS: (Number(minerReward) / 100000000).toFixed(8),
        note: 'Events have been emitted. Check pool logs to see if distribution occurred.'
      }
    } catch (error) {
      console.error('[API] Error distributing matured rewards:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private async forcePayoutAll() {
    if (!this.pool) {
      return { success: false, error: 'Pool instance not available' }
    }

    try {
      const result = await this.pool.forcePayoutAll()
      // Convert BigInt to string for JSON serialization
      return {
        ...result,
        totalAmount: result.totalAmount.toString(),
        totalAmountKAS: (result.totalAmount / 100000000n).toString()
      }
    } catch (error) {
      console.error('[API] Error forcing payout all:', error)
      return {
        success: false,
        paymentsCount: 0,
        totalAmount: '0',
        totalAmountKAS: '0',
        txHashes: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}
