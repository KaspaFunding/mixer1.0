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
      '/payouts/force-all': {
        post: async () => this.forcePayoutAll()
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

    // Note: The standalone pool doesn't have IP tracking infrastructure,
    // so we accept the verificationIP parameter but don't strictly validate it

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
      
      // Validate interval range (1 hour to 168 hours / 7 days)
      if (isNaN(intervalValue) || intervalValue < 1 || intervalValue > 168) {
        return { success: false, error: 'Invalid interval value. Must be between 1 and 168 hours (7 days)' }
      }
      
      // Round to nearest hour
      intervalValue = Math.round(intervalValue)
    }

    // Note: The standalone pool doesn't have IP tracking infrastructure,
    // so we accept the verificationIP parameter but don't strictly validate it
    // In production, you may want to add IP verification

    try {
      this.database.setPaymentInterval(addressWithoutPrefix, intervalValue)
      console.log('[API] Payment interval updated for', address, '(stored as:', addressWithoutPrefix + ')', 'to', intervalValue, 'hours')
      return { success: true, intervalHours: intervalValue }
    } catch (error) {
      console.error('[API] Error updating payment interval:', error)
      return { success: false, error: 'Failed to update payment interval' }
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
