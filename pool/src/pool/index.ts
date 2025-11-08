import { sompiToKaspaStringWithSuffix } from '../../wasm/kaspa'
import Database from './database'
import Monitoring from './monitoring'
import Rewarding from './rewarding'
import type Treasury from '../treasury'
import type Stratum from '../stratum'
import type { Contribution } from '../stratum/stratum'
import Api from './api'
import CoinbaseFinder from './distribution/coinbase'
import PaymentProcessor from './distribution/payments'
import DistributionManager from './distribution'
import BlockRecorder from './blocks'
import ForcePayoutManager from './payouts'

export default class Pool {
  private treasury: Treasury
  private stratum: Stratum
  private database: Database
  private rewarding: Rewarding
  private monitoring: Monitoring
  private api: Api | undefined
  private coinbaseFinder: CoinbaseFinder
  private paymentProcessor: PaymentProcessor
  private distributionManager: DistributionManager
  private blockRecorder: BlockRecorder
  private forcePayoutManager: ForcePayoutManager

  constructor (treasury: Treasury, stratum: Stratum, paymentThreshold: string, database?: Database) {
    this.treasury = treasury
    this.stratum = stratum
    
    // Use provided database or create new one
    this.database = database || new Database('./database')
    this.rewarding = new Rewarding(this.treasury.processor.rpc, this.database, paymentThreshold)
    this.monitoring = new Monitoring()
    this.coinbaseFinder = new CoinbaseFinder(this.treasury, this.treasury.processor.rpc, this.monitoring)
    this.paymentProcessor = new PaymentProcessor(this.database, this.treasury, this.monitoring)
    this.distributionManager = new DistributionManager(
      this.database,
      this.rewarding,
      this.treasury,
      this.coinbaseFinder,
      this.paymentProcessor,
      this.monitoring
    )
    this.blockRecorder = new BlockRecorder(this.database, this.rewarding, this.treasury, this.stratum, this.monitoring)
    this.forcePayoutManager = new ForcePayoutManager(this.database, this.treasury, this.monitoring)

    // Restore contributions from unpaid blocks on startup
    this.restoreUnpaidContributions()

    this.stratum.on('subscription', (ip: string, agent: string) => this.monitoring.log(`Miner ${ip} subscribed into notifications with ${agent}.`))
    this.stratum.on('block', (hash: string, contribution: Contribution) => this.blockRecorder.recordBlock(hash, contribution))
    this.treasury.on('coinbase', async (netAmount: bigint, coinbaseAmount?: bigint) => {
      // Calculate coinbase amount if not provided
      const fullCoinbaseAmount = coinbaseAmount || (netAmount * 10000n) / BigInt(10000 - (this.treasury.fee * 100))
      this.distributionManager.distribute(netAmount, fullCoinbaseAmount)
    })
    this.treasury.on('revenue', (amount: bigint) => {
      this.monitoring.log(`[EVENT] Received 'revenue' event: ${(Number(amount) / 100000000).toFixed(8)} KAS pool fee`)
      this.revenuize(amount)
    })
  
    this.monitoring.log(`Pool is active on port ${this.stratum.socket.port}.`)
  }

  serveApi (port: number) {
    this.api = new Api(port, this.treasury, this.stratum, this.database, this)
    this.monitoring.log(`JSON/HTTP API is listening on port ${this.api.server.port}.`)
  }

  private async revenuize (amount: bigint) {
    this.database.addBalance('me', amount)
  }

  // Restore unpaid contributions on pool startup
  private async restoreUnpaidContributions() {
    try {
      const allBlocks = this.database.getBlocks(1000)
      const unpaidBlocks = allBlocks.filter(b => !b.paid)
      
      if (unpaidBlocks.length > 0) {
        // Restore contributions to memory
        await this.rewarding.restoreContributionsFromDatabase()
        
        // Check for mature blocks that need manual distribution
        const oldBlocks = unpaidBlocks.filter(b => (Date.now() - b.timestamp) > 2 * 60 * 1000 && !b.paid)
        if (oldBlocks.length > 0) {
          // Wait for treasury to initialize, then check maturity
          setTimeout(async () => {
            try {
              await this.distributionManager.checkAndDistributeMatureBlocks(oldBlocks)
            } catch (error) {
              console.error('[POOL] Error checking mature blocks:', error)
            }
          }, 5000)
        }
      }
    } catch (error) {
      this.monitoring.log(`[POOL] Error restoring contributions on startup: ${error instanceof Error ? error.message : String(error)}`)
      console.error('[POOL] Error details:', error)
    }
  }


  async forcePayoutMiner(address: string): Promise<{ success: boolean, paymentAmount: bigint, txHash: string, error?: string }> {
    return await this.forcePayoutManager.forcePayoutMiner(address)
  }

  async forcePayoutAll(): Promise<{ success: boolean, paymentsCount: number, totalAmount: bigint, txHashes: string[], error?: string }> {
    return await this.forcePayoutManager.forcePayoutAll()
  }

  /**
   * Cleanup database - remove old blocks and optionally reset balances
   */
  async cleanupDatabase(options: {
    clearOldBlocks?: boolean
    blockAgeDays?: number
    clearPaidBlocks?: boolean
    clearAllBlocks?: boolean
    resetBalances?: boolean
    keepRecentBlocks?: number
  }): Promise<{ success: boolean, blocksRemoved: number, balancesReset: number, error?: string }> {
    try {
      const result = this.database.cleanupDatabase(options)
      this.monitoring.log(`[CLEANUP] Removed ${result.blocksRemoved} block(s), reset ${result.balancesReset} balance(s)`)
      return {
        success: true,
        ...result
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.monitoring.log(`[CLEANUP] Database cleanup failed: ${errorMsg}`)
      return {
        success: false,
        blocksRemoved: 0,
        balancesReset: 0,
        error: errorMsg
      }
    }
  }

  /**
   * Settle partial payout and clean up database
   * Sends whatever treasury can afford, then cleans up broken data
   */
  async settlePayoutAndCleanup(): Promise<{ success: boolean, partialPayment?: { amount: bigint, txHash?: string }, cleanup?: { blocksMarked: number, balancesReset: number }, error?: string }> {
    try {
      this.monitoring.log(`[SETTLE] Starting settle payout and cleanup...`)
      
      // Step 1: Try to send partial payout (what treasury can afford)
      const allMiners = this.database.getAllMiners()
      let partialPayment: { amount: bigint, txHash?: string } | undefined = undefined
      
      for (const [address, miner] of allMiners) {
        if (miner.balance > 0n) {
          // Check treasury balance
          let treasuryBalance = 0n
          try {
            const utxoResult = await this.treasury.processor.rpc.getUtxosByAddresses({ addresses: [this.treasury.address] })
            if (utxoResult && utxoResult.entries && utxoResult.entries.length > 0) {
              treasuryBalance = utxoResult.entries.reduce((sum: bigint, utxo: any) => {
                const amount = typeof utxo.amount === 'bigint' ? utxo.amount : BigInt(utxo.amount || 0)
                return sum + amount
              }, 0n)
            }
          } catch (error) {
            this.monitoring.log(`[SETTLE] Could not check treasury balance: ${error instanceof Error ? error.message : String(error)}`)
          }
          
          const balanceKAS = (Number(miner.balance) / 100000000).toFixed(8)
          const treasuryKAS = (Number(treasuryBalance) / 100000000).toFixed(8)
          
          if (treasuryBalance > 0n && treasuryBalance < miner.balance) {
            // Send partial payment (what treasury can afford)
            const partialAmount = treasuryBalance - 10000n // Leave small amount for fees
            const addressForPayment = address.startsWith('kaspa:') ? address : `kaspa:${address}`
            
            this.monitoring.log(`[SETTLE] Sending partial payment: ${(Number(partialAmount) / 100000000).toFixed(8)} KAS (of ${balanceKAS} KAS balance, treasury has ${treasuryKAS} KAS)`)
            
            try {
              const txHashes = await this.treasury.send([{
                address: addressForPayment,
                amount: partialAmount
              }])
              
              if (txHashes && txHashes.length > 0) {
                const addressWithoutPrefix = address.replace(/^(kaspa:?|kaspatest:?)/i, '')
                this.database.addBalance(addressWithoutPrefix, -partialAmount)
                
                // Record payment
                const paymentRecord = this.database.createPaymentRecord({
                  id: txHashes[0],
                  address: addressWithoutPrefix,
                  amount: partialAmount,
                  status: 'sent',
                  txId: txHashes[0],
                  notes: `Partial payout - settled ${(Number(partialAmount) / 100000000).toFixed(8)} KAS before cleanup`
                })
                this.database.addPayment(paymentRecord)
                
                partialPayment = { amount: partialAmount, txHash: txHashes[0] }
                this.monitoring.log(`[SETTLE] ✓ Sent partial payment: ${(Number(partialAmount) / 100000000).toFixed(8)} KAS (tx: ${txHashes[0].substring(0, 16)}...)`)
              }
            } catch (sendError) {
              this.monitoring.log(`[SETTLE] Partial payment failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`)
              // Continue with cleanup anyway
            }
          } else if (treasuryBalance === 0n) {
            this.monitoring.log(`[SETTLE] Treasury has no balance - skipping partial payout`)
          } else {
            this.monitoring.log(`[SETTLE] Treasury has sufficient balance (${treasuryKAS} KAS) - will send full balance in normal payout`)
          }
          
          // Only process first miner (typically only one with balance)
          break
        }
      }
      
      // Step 2: Clean up database
      this.monitoring.log(`[SETTLE] Proceeding with database cleanup...`)
      const cleanupResult = await this.cleanupDatabase({
        clearPaidBlocks: true,
        resetBalances: true,
        keepRecentBlocks: 100
      })
      
      return {
        success: true,
        partialPayment,
        cleanup: cleanupResult.success ? {
          blocksMarked: cleanupResult.blocksRemoved,
          balancesReset: cleanupResult.balancesReset
        } : undefined
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.monitoring.log(`[SETTLE] Settle and cleanup failed: ${errorMsg}`)
      return {
        success: false,
        error: errorMsg
      }
    }
  }

}