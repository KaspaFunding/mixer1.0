import type Database from '../database'
import type Rewarding from '../rewarding'
import type Treasury from '../../treasury'
import type Monitoring from '../monitoring'
import CoinbaseFinder from './coinbase'
import PaymentProcessor from './payments'

/**
 * DistributionManager - Orchestrates reward distribution for mature blocks
 * 
 * Responsibilities:
 * - Handle coinbase maturity events
 * - Process old unpaid blocks on startup
 * - Coordinate between CoinbaseFinder, PaymentProcessor, and Rewarding
 * - Manage contribution restoration
 */
export default class DistributionManager {
  constructor(
    private database: Database,
    private rewarding: Rewarding,
    private treasury: Treasury,
    private coinbaseFinder: CoinbaseFinder,
    private paymentProcessor: PaymentProcessor,
    private monitoring: Monitoring
  ) {}

  /**
   * Distribute rewards for a coinbase maturity event
   * 
   * @param amount Net amount (after pool fee)
   * @param coinbaseAmount Full coinbase amount (optional)
   * @param skipRestore If true, skip contribution restore (used for individual block processing)
   */
  async distribute(
    amount: bigint,
    coinbaseAmount?: bigint,
    skipRestore: boolean = false
  ): Promise<void> {
    // Only restore contributions if rewards map is empty and not skipping restore
    if (!skipRestore && this.rewarding.getRewardsCount() === 0) {
      await this.rewarding.restoreContributionsFromDatabase()
    }
    
    // Calculate coinbase amount if not provided
    const calculatedCoinbaseAmount = coinbaseAmount || (amount * 10000n) / BigInt(10000 - (this.treasury.fee * 100))
    
    // Record payment (rewarding system handles threshold checks automatically)
    this.rewarding.recordPayment(amount, async (contributors, payments) => {
      if (payments.length === 0) {
        return
      }
      
      // Use PaymentProcessor to handle payment logic
      const result = await this.paymentProcessor.processPayments(
        payments,
        calculatedCoinbaseAmount,
        this.treasury.fee,
        skipRestore
      )
      
      if (result.success && result.txHashes.length > 0) {
        this.monitoring.log(`Reward threshold exceeded by miner(s), individual rewards sent: \n${result.txHashes.map(h => `           - ${h}`).join('\n')}`)
      }
    })
  }

  /**
   * Check and distribute rewards for mature blocks that haven't been paid yet
   * Used for blocks that matured before pool restart
   */
  async checkAndDistributeMatureBlocks(blocks: any[]): Promise<void> {
    try {
      // Filter out blocks already marked as paid
      const unpaidBlocks = blocks.filter(b => !b.paid)
      
      if (unpaidBlocks.length === 0) {
        this.monitoring.log(`[DistributionManager] All ${blocks.length} block(s) are already marked as paid - skipping`)
        return
      }
      
      if (unpaidBlocks.length < blocks.length) {
        this.monitoring.log(`[DistributionManager] Filtered out ${blocks.length - unpaidBlocks.length} already-paid block(s), processing ${unpaidBlocks.length} unpaid block(s)`)
      }
      
      this.monitoring.log(`[DistributionManager] Checking ${unpaidBlocks.length} old block(s) for maturity and distributing rewards...`)
      
      // Clear rewards map first to process each block individually
      this.rewarding.clearRewards()
      
      let totalDistributed = 0n
      let successfulDistributions = 0
      
      for (const block of unpaidBlocks) {
        try {
          // Double-check block is not paid
          const currentBlock = this.database.getBlocks(1000).find(b => b.hash === block.hash)
          if (currentBlock?.paid) {
            this.monitoring.log(`[DistributionManager] Block ${block.hash.substring(0, 16)}... was marked as paid during processing - skipping`)
            continue
          }
          
          // Check if block is blue (mature)
          const { blue } = await this.treasury.processor.rpc.getCurrentBlockColor({ hash: block.hash }).catch(() => ({ blue: false }))
          
          if (!blue) {
            this.monitoring.log(`[DistributionManager] Block ${block.hash.substring(0, 16)}... is not yet mature (blue=false)`)
            continue
          }
          
          // Get coinbase transaction value
          const blockInfo = await this.treasury.processor.rpc.getBlock({ hash: block.hash, includeTransactions: true }).catch(() => null)
          
          if (!blockInfo?.block?.transactions || blockInfo.block.transactions.length === 0) {
            this.monitoring.log(`[DistributionManager] Block ${block.hash.substring(0, 16)}... has no transactions`)
            continue
          }
          
          // Get coinbase amount using CoinbaseFinder with multi-stage fallback matching
          const coinbaseTx = blockInfo.block.transactions[0]
          const result = await this.coinbaseFinder.findCoinbaseValue(
            block.hash, 
            blockInfo, 
            coinbaseTx,
            block.daaScore
          )
          
          if (!result.found) {
            this.monitoring.log(`[DistributionManager] ⚠️ Block ${block.hash.substring(0, 16)}... coinbase value not found - marking as paid to skip`)
            // Mark as paid to prevent retries
            const updatedBlock = { ...block, paid: true }
            this.database.addBlock(updatedBlock)
            continue
          }
          
          const coinbaseValue = result.value
          if (result.method) {
            this.monitoring.log(`[DistributionManager] Found coinbase value for block ${block.hash.substring(0, 16)}... using method: ${result.method}`)
          }
          
          // Calculate reward after pool fee
          const poolFee = (coinbaseValue * BigInt(this.treasury.fee * 100)) / 10000n
          const minerReward = coinbaseValue - poolFee
          
          this.monitoring.log(`[DistributionManager] Block ${block.hash.substring(0, 16)}... is mature! Coinbase: ${(Number(coinbaseValue) / 100000000).toFixed(8)} KAS, Miner reward: ${(Number(minerReward) / 100000000).toFixed(8)} KAS`)
          
          // Clean address for database operations
          const addressClean = block.address.replace(/^(kaspa:?|kaspatest:?)/i, '')
          
          // Restore only this block's contribution
          this.rewarding.clearRewards()
          await this.rewarding.restoreContributionsFromDatabase(block.hash)
          
          // Verify the block was restored
          if (!this.rewarding.hasReward(block.hash)) {
            // Fallback: manually add if restore didn't work
            const { default: Decimal } = await import('decimal.js')
            
            // Check if block has stored contributions
            let contributionsToRestore: Array<{ address: string, difficulty: InstanceType<typeof Decimal> }> = []
            if (block.contributions && Array.isArray(block.contributions) && block.contributions.length > 0) {
              // Restore all contributions from stored data
              contributionsToRestore = block.contributions.map(c => ({
                address: c.address.replace(/^(kaspa:?|kaspatest:?)/i, ''),
                difficulty: new Decimal(c.difficulty || '0')
              }))
              this.monitoring.log(`[DistributionManager] Fallback: Restoring ${contributionsToRestore.length} stored contribution(s) for block ${block.hash.substring(0, 16)}...`)
            } else {
              // Old format: only finder's contribution
              contributionsToRestore = [{
                address: addressClean,
                difficulty: new Decimal(block.difficulty || '0')
              }]
              this.monitoring.log(`[DistributionManager] Fallback: Restoring only finder's contribution for block ${block.hash.substring(0, 16)}... (old format)`)
            }
            
            this.rewarding.recordContributions(block.hash, contributionsToRestore)
          } else {
            this.monitoring.log(`[DistributionManager] Restored contribution(s) for block ${block.hash.substring(0, 16)}... (from database)`)
          }
          
          // Check if this specific block is in the rewards map
          if (!this.rewarding.hasReward(block.hash)) {
            this.monitoring.log(`[DistributionManager] ⚠️ Block ${block.hash.substring(0, 16)}... contribution not found in rewards map - marking as paid to skip`)
            // Mark block as paid to prevent retries
            const updatedBlock = { ...block, paid: true }
            this.database.addBlock(updatedBlock)
            continue
          }
          
          // Check treasury balance before distribution
          let treasuryBalance = 0n
          let treasuryBalanceKAS = '0.00000000'
          try {
            const utxoResult = await this.treasury.processor.rpc.getUtxosByAddresses({ addresses: [this.treasury.address] })
            if (utxoResult && utxoResult.entries && utxoResult.entries.length > 0) {
              treasuryBalance = utxoResult.entries.reduce((sum: bigint, utxo: any) => {
                const amount = typeof utxo.amount === 'bigint' ? utxo.amount : BigInt(utxo.amount || 0)
                return sum + amount
              }, 0n)
              treasuryBalanceKAS = (Number(treasuryBalance) / 100000000).toFixed(8)
            }
          } catch (error) {
            this.monitoring.log(`[DistributionManager] ⚠️ Could not check treasury balance: ${error instanceof Error ? error.message : String(error)}`)
            // Continue anyway - treasury.send() handles insufficient funds
          }
          
          if (treasuryBalance > 0n && treasuryBalance < minerReward) {
            this.monitoring.log(`[DistributionManager] ⚠️ Treasury has insufficient balance: ${treasuryBalanceKAS} KAS (need ${(Number(minerReward) / 100000000).toFixed(8)} KAS)`)
            this.monitoring.log(`[DistributionManager] Block ${block.hash.substring(0, 16)}... reward will be added to miner balance instead of sending payment`)
            
            // Add to balance instead of sending payment (miners get credited even if treasury is empty)
            const minerBefore = this.database.getMiner(addressClean)
            this.database.addBalance(addressClean, minerReward)
            const minerAfter = this.database.getMiner(addressClean)
            const actualAdded = minerAfter.balance - minerBefore.balance
            
            this.monitoring.log(`[DistributionManager] ✓ Credited ${(Number(minerReward) / 100000000).toFixed(8)} KAS (treasury insufficient for payout)`)
            
            // Mark block as paid
            const updatedBlock = { ...block, paid: true }
            this.database.addBlock(updatedBlock)
            
            // Only count actual amount added to balance
            totalDistributed += actualAdded >= minerReward ? minerReward : actualAdded
            successfulDistributions++
            continue
          }
          
          // Distribute this block's reward
          await this.distribute(minerReward, coinbaseValue, true)
          
          // Wait for balance to update
          await new Promise(resolve => setTimeout(resolve, 200))
          
          // Verify distribution worked
          const minerAfterDist = this.database.getMiner(addressClean)
          const balanceAfterDist = minerAfterDist.balance
          
          totalDistributed += minerReward
          successfulDistributions++
          
          // Mark block as paid after successful distribution
          const updatedBlock = { 
            ...block, 
            paid: true,
            ...(block.contributions && { contributions: block.contributions })
          }
          this.database.addBlock(updatedBlock)
          
          // Clear rewards after processing this block
          this.rewarding.clearRewards()
        } catch (error) {
          this.monitoring.log(`[DistributionManager] Error processing block ${block.hash.substring(0, 16)}...: ${error instanceof Error ? error.message : String(error)}`)
          console.error('[DistributionManager] Error details:', error)
        }
      }
      
      if (successfulDistributions > 0) {
        const totalKAS = (Number(totalDistributed) / 100000000).toFixed(8)
        this.monitoring.log(`[DistributionManager] ✓ Distributed ${successfulDistributions} mature block(s): ${totalKAS} KAS`)
      }
    } catch (error) {
      this.monitoring.log(`[DistributionManager] Error in checkAndDistributeMatureBlocks: ${error instanceof Error ? error.message : String(error)}`)
      console.error('[DistributionManager] Error details:', error)
    }
  }
}

