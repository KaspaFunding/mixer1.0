import type Treasury from '../../treasury'
import type Database from '../database'
import type Monitoring from '../monitoring'

/**
 * ForcePayoutManager - Handles force payout operations for miners
 * 
 * Responsibilities:
 * - Force payout single miner
 * - Force payout all miners
 * - Handle insufficient treasury funds
 * - Record payments and mark blocks as paid
 */
export default class ForcePayoutManager {
  constructor(
    private database: Database,
    private treasury: Treasury,
    private monitoring: Monitoring
  ) {}

  /**
   * Force payout for a single miner
   */
  async forcePayoutMiner(
    address: string
  ): Promise<{ success: boolean, paymentAmount: bigint, txHash: string, error?: string }> {
    try {
      // Remove kaspa: prefix if present
      const addressWithoutPrefix = address.replace(/^(kaspa:?|kaspatest:?)/i, '')
      const miner = this.database.getMiner(addressWithoutPrefix)
      
      if (!miner || miner.balance <= 0n) {
        return {
          success: false,
          paymentAmount: 0n,
          txHash: '',
          error: miner ? 'Miner has no balance to payout' : 'Miner not found'
        }
      }
      
      const balanceKAS = (Number(miner.balance) / 100000000).toFixed(8)
      const addressWithPrefix = address.startsWith('kaspa:') ? address : `kaspa:${address}`
      
      this.monitoring.log(`Force payout (single miner): ${addressWithPrefix}, Balance: ${balanceKAS} KAS`)
      
      // Create payment
      const payment = {
        address: addressWithPrefix,
        amount: miner.balance
      }
      
      // Send payment
      let txHashes: string[]
      try {
        txHashes = await this.treasury.send([payment])
        
        if (!txHashes || txHashes.length === 0) {
          throw new Error('treasury.send() returned no transaction hashes')
        }
      } catch (sendError) {
        const errorMsg = sendError instanceof Error ? sendError.message : String(sendError)
        this.monitoring.log(`Force payout (single miner): Treasury.send failed: ${errorMsg}`)
        throw new Error(`Failed to send transaction: ${errorMsg}`)
      }
      
      // Record payment in database (force payout from multiple blocks)
      const txHash = txHashes[0]
      const paymentRecord = this.database.createPaymentRecord({
        id: String(txHash),
        address: addressWithoutPrefix,
        amount: miner.balance,
        status: 'sent',
        txId: String(txHash),
        balanceBefore: miner.balance,
        notes: 'Force payout - accumulated balance from multiple blocks'
      })
      this.database.addPayment(paymentRecord)
      
      // Deduct balance
      this.database.addBalance(addressWithoutPrefix, -miner.balance)
      
      // Update last payout time if interval is set
      if (miner.paymentIntervalHours && miner.paymentIntervalHours > 0) {
        this.database.setLastPayoutTime(addressWithoutPrefix, Date.now())
      }
      
      // Mark blocks as paid
      this.markBlocksAsPaid([addressWithoutPrefix])
      
      this.monitoring.log(`Force payout (single miner): Successfully sent ${balanceKAS} KAS to ${addressWithPrefix} (tx: ${String(txHash).substring(0, 16)}...)`)
      
      return {
        success: true,
        paymentAmount: miner.balance,
        txHash: String(txHash)
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.monitoring.log(`Force payout (single miner) failed: ${errorMsg}`)
      console.error('[ForcePayoutManager] Force payout (single miner) error:', error)
      return {
        success: false,
        paymentAmount: 0n,
        txHash: '',
        error: errorMsg
      }
    }
  }

  /**
   * Force payout for all miners with balance > 0
   */
  async forcePayoutAll(): Promise<{ success: boolean, paymentsCount: number, totalAmount: bigint, txHashes: string[], error?: string }> {
    try {
      const allMiners = this.database.getAllMiners()
      const payments: Array<{ address: string, amount: bigint }> = []

      // Log all miners found
      this.monitoring.log(`Force payout: Found ${allMiners.size} miner(s) in database`)
      
      // Collect all miners with balance > 0 (force payout sends all pending balances)
      for (const [address, miner] of allMiners) {
        // Log breakdown of unpaid blocks for this miner
        const addressWithoutPrefix = address.replace(/^(kaspa:?|kaspatest:?)/i, '')
        const unpaidBlocksForMiner = this.database.getBlocks(1000).filter(b => {
          const blockAddress = b.address.replace(/^(kaspa:?|kaspatest:?)/i, '')
          return blockAddress === addressWithoutPrefix && !b.paid
        })
        
        if (unpaidBlocksForMiner.length > 0 && miner.balance > 0n) {
          this.monitoring.log(`  Miner ${address.substring(0, 16)}... has ${unpaidBlocksForMiner.length} unpaid block(s) contributing to balance of ${(Number(miner.balance) / 100000000).toFixed(8)} KAS`)
          // Show first few unpaid blocks
          for (const block of unpaidBlocksForMiner.slice(0, 5)) {
            const blockAge = Date.now() - block.timestamp
            const blockAgeMinutes = Math.floor(blockAge / 60000)
            this.monitoring.log(`    - Block ${block.hash.substring(0, 16)}... (age: ${blockAgeMinutes} min, paid: ${block.paid ? 'YES' : 'NO'})`)
          }
          if (unpaidBlocksForMiner.length > 5) {
            this.monitoring.log(`    ... and ${unpaidBlocksForMiner.length - 5} more unpaid block(s)`)
          }
        }
        const balanceKAS = (Number(miner.balance) / 100000000).toFixed(8)
        const addressWithPrefix = address.startsWith('kaspa:') ? address : `kaspa:${address}`
        
        // Log detailed info for debugging
        const paymentIntervalHours = miner.paymentIntervalHours
        const paymentThreshold = miner.paymentThreshold
        const lastPayoutTime = this.database.getLastPayoutTime(address)
        
        this.monitoring.log(`  Miner: ${addressWithPrefix}, Balance: ${balanceKAS} KAS`)
        if (paymentIntervalHours) {
          this.monitoring.log(`    Payment interval: ${paymentIntervalHours} hours, Last payout: ${lastPayoutTime ? new Date(lastPayoutTime).toISOString() : 'never'}`)
        }
        if (paymentThreshold) {
          const thresholdKAS = (Number(paymentThreshold) / 100000000).toFixed(8)
          this.monitoring.log(`    Payment threshold: ${thresholdKAS} KAS`)
        }
        
        // Force payout sends any balance > 0
        if (miner.balance > 0n) {
          // Ensure address has kaspa: prefix for payment
          const addressForPayment = address.startsWith('kaspa:') ? address : `kaspa:${address}`
          payments.push({
            address: addressForPayment,
            amount: miner.balance
          })
          this.monitoring.log(`    ✓ Added to force payout queue: ${balanceKAS} KAS`)
        } else {
          this.monitoring.log(`    ⚠ Skipped (balance is 0)`)
        }
      }

      if (payments.length === 0) {
        // Check if any miners exist at all
        if (allMiners.size === 0) {
          this.monitoring.log('Force payout: No miners found in database')
        } else {
          this.monitoring.log('Force payout: No miners with pending balance (all balances are 0 - may have already been paid)')
          // Log recent payments for context
          for (const [address, miner] of allMiners) {
            const addressWithPrefix = address.startsWith('kaspa:') ? address : `kaspa:${address}`
            const recentPayments = this.database.getPaymentsByAddress(address, 3)
            if (recentPayments.length > 0) {
              const latestPayment = recentPayments[0]
              const paymentKAS = (Number(latestPayment.amount) / 100000000).toFixed(8)
              const paymentTime = new Date(latestPayment.createdAt || latestPayment.updatedAt || 0).toISOString()
              const txId = latestPayment.txId || latestPayment.id || 'unknown'
              this.monitoring.log(`  ${addressWithPrefix}: Last payment ${paymentKAS} KAS at ${paymentTime} (tx: ${txId.substring(0, 16)}...)`)
            }
          }
        }
        return {
          success: true,
          paymentsCount: 0,
          totalAmount: 0n,
          txHashes: []
        }
      }

      // Calculate total amount
      const totalAmount = payments.reduce((sum, p) => sum + p.amount, 0n)
      
      // Check treasury on-chain balance before payouts
      const treasuryBalance = await this.checkTreasuryBalance()
      const treasuryBalanceKAS = (Number(treasuryBalance) / 100000000).toFixed(8)
      
      const totalAmountKAS = (Number(totalAmount) / 100000000).toFixed(8)
      
      // Log payment details
      this.monitoring.log(`Force payout: Processing ${payments.length} payments totaling ${totalAmountKAS} KAS`)
      this.monitoring.log(`Force payout: Treasury balance: ${treasuryBalanceKAS} KAS`)
      
      if (treasuryBalance > 0n && treasuryBalance < totalAmount) {
        const shortfall = totalAmount - treasuryBalance
        const shortfallKAS = (Number(shortfall) / 100000000).toFixed(8)
        this.monitoring.log(`Force payout: ⚠️ WARNING: Treasury has insufficient balance! Need ${totalAmountKAS} KAS but only have ${treasuryBalanceKAS} KAS (shortfall: ${shortfallKAS} KAS)`)
        // Continue anyway - treasury.send will return error
      }
      
      // Log payment details
      for (const payment of payments) {
        const addressWithPrefix = payment.address.startsWith('kaspa:') ? payment.address : `kaspa:${payment.address}`
        const amountKAS = (Number(payment.amount) / 100000000).toFixed(8)
        this.monitoring.log(`  - ${addressWithPrefix}: ${amountKAS} KAS`)
      }

      // Send all payments
      let txHashes: string[]
      try {
        txHashes = await this.treasury.send(payments.map(p => ({
          address: p.address,
          amount: p.amount
        })))
      } catch (sendError) {
        const errorMsg = sendError instanceof Error ? sendError.message : String(sendError)
        this.monitoring.log(`Force payout: Treasury.send failed: ${errorMsg}`)
        // Return error instead of throwing - this allows API to return a proper response
        return {
          success: false,
          paymentsCount: 0,
          totalAmount: 0n,
          txHashes: [] as string[],
          error: `Insufficient treasury funds. Treasury balance: ${treasuryBalanceKAS} KAS, Required: ${totalAmountKAS} KAS. ${errorMsg}`
        }
      }
      
      // Validate that we got transaction hashes back
      if (!txHashes || txHashes.length === 0) {
        throw new Error('No transaction hashes returned from treasury.send - transactions may not have been submitted')
      }
      
      if (txHashes.length < payments.length) {
        this.monitoring.log(`Warning: Expected ${payments.length} transaction hashes, got ${txHashes.length}`)
      }
      
      // Convert txHashes to string array
      const txHashStrings: string[] = txHashes.map(h => String(h))

      // Record payments and deduct balances
      await this.recordPayouts(payments, txHashStrings)
      
      // Mark blocks as paid
      const addressesPaid = payments.map(p => {
        return p.address.replace(/^(kaspa:?|kaspatest:?)/i, '')
      })
      this.markBlocksAsPaid(addressesPaid)

      this.monitoring.log(`Force payout: Successfully sent ${payments.length} payment(s) with ${txHashStrings.length} transaction(s)`)

      return {
        success: true,
        paymentsCount: payments.length,
        totalAmount,
        txHashes: txHashStrings
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.monitoring.log(`Force payout failed: ${errorMsg}`)
      console.error('[ForcePayoutManager] Force payout error:', error)
      return {
        success: false,
        paymentsCount: 0,
        totalAmount: 0n,
        txHashes: [] as string[],
        error: errorMsg
      }
    }
  }

  /**
   * Check treasury on-chain balance
   */
  private async checkTreasuryBalance(): Promise<bigint> {
    try {
      const utxoResult = await this.treasury.processor.rpc.getUtxosByAddresses({ addresses: [this.treasury.address] })
      if (utxoResult && utxoResult.entries && utxoResult.entries.length > 0) {
        return utxoResult.entries.reduce((sum: bigint, utxo: any) => {
          const amount = typeof utxo.amount === 'bigint' ? utxo.amount : BigInt(utxo.amount || 0)
          return sum + amount
        }, 0n)
      }
    } catch (error) {
      this.monitoring.log(`Force payout: ⚠️ Could not check treasury balance: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 0n
  }

  /**
   * Record payments in database and update balances
   */
  private async recordPayouts(
    payments: Array<{ address: string, amount: bigint }>,
    txHashes: string[]
  ): Promise<void> {
    for (let i = 0; i < payments.length; i++) {
      const payment = payments[i]
      const txHash = txHashes[i] || txHashes[txHashes.length - 1] // Use last hash if array mismatch
      
      // Validate transaction hash
      if (!txHash || txHash.length === 0) {
        this.monitoring.log(`Warning: Missing transaction hash for payment ${i + 1} to ${payment.address}`)
        continue
      }
      
      // Address may have kaspa: prefix - remove it for storage (addresses stored without prefix)
      const addressForStorage = payment.address.replace(/^(kaspa:?|kaspatest:?)/i, '')
      
      // Record payment (force payout from multiple blocks)
      const paymentRecord = this.database.createPaymentRecord({
        id: txHash,
        address: addressForStorage,
        amount: payment.amount,
        status: 'sent',
        txId: txHash,
        notes: 'Force payout - accumulated balance from multiple blocks'
      })
      this.database.addPayment(paymentRecord)

      // Deduct balance and update last payout time
      this.database.addBalance(addressForStorage, -payment.amount)
      const miner = this.database.getMiner(addressForStorage)
      if (miner.paymentIntervalHours && miner.paymentIntervalHours > 0) {
        this.database.setLastPayoutTime(addressForStorage, Date.now())
      }
      
      // Log successful payment
      const addressWithPrefix = payment.address.startsWith('kaspa:') ? payment.address : `kaspa:${payment.address}`
      this.monitoring.log(`  ✓ Paid ${(Number(payment.amount) / 100000000).toFixed(8)} KAS to ${addressWithPrefix} - tx: ${txHash}`)
    }
  }

  /**
   * Mark blocks as paid for addresses that received payments
   */
  private markBlocksAsPaid(addresses: string[]): void {
    for (const address of addresses) {
      const blocks = this.database.getBlocksByAddress(address, 100)
      for (const block of blocks) {
        if (!block.paid) {
          // Preserve block data including contributions array
          const updatedBlock = { 
            ...block, 
            paid: true,
            ...(block.contributions && { contributions: block.contributions })
          }
          this.database.addBlock(updatedBlock)
        }
      }
    }
  }
}

