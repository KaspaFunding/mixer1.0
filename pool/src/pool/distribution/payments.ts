import type { IPaymentOutput } from '../../../wasm/kaspa'
import type Treasury from '../../treasury'
import type Database from '../database'
import type Monitoring from '../monitoring'

/**
 * PaymentProcessor - Handles payment transactions, error recovery, and payment recording
 * 
 * Responsibilities:
 * - Send payments via treasury
 * - Handle payment failures (restore balances)
 * - Record payments in database
 * - Mark blocks as paid after successful payments
 */
export default class PaymentProcessor {
  constructor(
    private database: Database,
    private treasury: Treasury,
    private monitoring: Monitoring
  ) {}

  /**
   * Process payment outputs from rewarding system
   * 
   * @param payments Payment outputs from rewarding system
   * @param coinbaseAmount Original coinbase amount (for payment records)
   * @param poolFee Pool fee percentage (for calculating fees)
   * @param isIndividualBlock If true, skip payout checks (used during individual block processing)
   */
  async processPayments(
    payments: IPaymentOutput[],
    coinbaseAmount: bigint,
    poolFee: number,
    isIndividualBlock: boolean = false
  ): Promise<{ success: boolean, txHashes: string[], error?: string }> {
    if (payments.length === 0) {
      return { success: true, txHashes: [] }
    }

    // Store payment amounts before sending (for error recovery)
    const paymentAmounts = new Map<string, bigint>()
    for (const payment of payments) {
      const addressStr = typeof payment.address === 'string' ? payment.address : payment.address.toString()
      const addressForStorage = addressStr.replace(/^(kaspa:?|kaspatest:?)/i, '')
      paymentAmounts.set(addressForStorage, payment.amount)
    }

    // Send payments
    let txHashes: string[]
    try {
      txHashes = await this.sendPayments(payments)
      
      if (!txHashes || txHashes.length === 0) {
        throw new Error('treasury.send() returned no transaction hashes')
      }

      const totalAmount = payments.reduce((sum, p) => sum + BigInt(p.amount), 0n)
      this.monitoring.log(`[PaymentProcessor] ✓ Sent ${(Number(totalAmount) / 100000000).toFixed(8)} KAS to ${payments.length} miner(s)`)
    } catch (sendError) {
      // Handle payment failure
      await this.handlePaymentFailure(paymentAmounts, coinbaseAmount, poolFee, sendError)
      const errorMsg = sendError instanceof Error ? sendError.message : String(sendError)
      return { success: false, txHashes: [], error: errorMsg }
    }

    // Record successful payments and mark blocks as paid
    await this.recordPayments(payments, txHashes, coinbaseAmount, poolFee)
    await this.markBlocksAsPaid(payments)

    return { success: true, txHashes }
  }

  /**
   * Send payments via treasury
   */
  private async sendPayments(payments: IPaymentOutput[]): Promise<string[]> {
    return await this.treasury.send(payments)
  }

  /**
   * Handle payment failures - restore balances and record failed payments
   */
  private async handlePaymentFailure(
    paymentAmounts: Map<string, bigint>,
    coinbaseAmount: bigint,
    poolFee: number,
    error: any
  ): Promise<void> {
    const errorMsg = error instanceof Error ? error.message : String(error)
    this.monitoring.log(`[PaymentProcessor] ERROR: Failed to send payments: ${errorMsg}`)
    console.error('[PaymentProcessor] Error details:', error)

    // Restore balances if payment failed
    for (const [address, amount] of paymentAmounts) {
      // Get miner info for payment record
      const miner = this.database.getMiner(address)
      const balanceAfter = miner.balance + amount

      // Record failed payment in database
      const failedPayment = this.database.createPaymentRecord({
        address,
        amount,
        coinbaseAmount: coinbaseAmount.toString(),
        status: 'failed',
        error: errorMsg,
        poolFee: coinbaseAmount > amount ? (coinbaseAmount - amount).toString() : undefined,
        balanceBefore: miner.balance,
        balanceAfter: balanceAfter.toString(),
        retryCount: 0
      })
      this.database.addPayment(failedPayment)

      // Restore balance
      this.database.addBalance(address, amount)

      // Update payment status to 'restored'
      this.database.updatePayment(failedPayment.id, {
        status: 'restored',
        balanceAfter: balanceAfter.toString()
      })
    }
  }

  /**
   * Record successful payments in database
   */
  private async recordPayments(
    payments: IPaymentOutput[],
    txHashes: string[],
    coinbaseAmount: bigint,
    poolFee: number
  ): Promise<void> {
    // Convert txHashes to string array
    const txHashStrings: string[] = txHashes.map(h => String(h))

    for (let i = 0; i < payments.length; i++) {
      const payment = payments[i]
      const txHash = txHashStrings[i] || txHashStrings[0] // Use first hash if array mismatch
      
      // Ensure address is string and remove prefix for storage
      const addressStr = typeof payment.address === 'string' ? payment.address : payment.address.toString()
      const addressForStorage = addressStr.replace(/^(kaspa:?|kaspatest:?)/i, '')

      // Get block hashes for this payment (blocks that triggered this payout)
      const relatedBlocks = this.database.getBlocksByAddress(addressForStorage, 100)
        .filter(b => !b.paid)
        .map(b => b.hash)

      // Get miner info for payment record
      const minerInfo = this.database.getMiner(addressForStorage)

      // Calculate pool fee and coinbase amount for this payment
      const paymentAmount = BigInt(payment.amount)
      const poolFeePercent = poolFee
      const poolFeeForPayment = (paymentAmount * BigInt(poolFeePercent * 100)) / BigInt(10000 - (poolFeePercent * 100))
      const coinbaseForPayment = paymentAmount + poolFeeForPayment

      // Record payment in database
      const paymentRecord = this.database.createPaymentRecord({
        id: txHash,
        address: addressForStorage,
        amount: payment.amount,
        coinbaseAmount: coinbaseAmount.toString(),
        status: 'sent',
        txId: txHash,
        blockHashes: relatedBlocks.length > 0 ? relatedBlocks : undefined,
        poolFee: poolFeeForPayment.toString(),
        balanceBefore: minerInfo.balance,
        paymentThreshold: minerInfo.paymentThreshold?.toString(),
        paymentIntervalHours: minerInfo.paymentIntervalHours
      })
      this.database.addPayment(paymentRecord)

      // Update last payout time (only after successful payment)
      const miner = this.database.getMiner(addressForStorage)
      if (miner.paymentIntervalHours && miner.paymentIntervalHours > 0) {
        this.database.setLastPayoutTime(addressForStorage, Date.now())
      }
    }
  }

  /**
   * Mark blocks as paid for addresses that received payments
   */
  private async markBlocksAsPaid(payments: IPaymentOutput[]): Promise<void> {
    const addressesPaid = new Set<string>()

    // Collect addresses that received payments
    for (const payment of payments) {
      const addressStr = typeof payment.address === 'string' ? payment.address : payment.address.toString()
      const addressForStorage = addressStr.replace(/^(kaspa:?|kaspatest:?)/i, '')
      addressesPaid.add(addressForStorage)
    }

    // Mark blocks as paid for all blocks found by addresses that received payments
    for (const address of addressesPaid) {
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

