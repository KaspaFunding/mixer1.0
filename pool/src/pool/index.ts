import { sompiToKaspaStringWithSuffix } from '../../wasm/kaspa'
import Database from './database'
import Monitoring from './monitoring'
import Rewarding from './rewarding'
import type Treasury from '../treasury'
import type Stratum from '../stratum'
import type { Contribution } from '../stratum/stratum'
import Api from './api'

export default class Pool {
  private treasury: Treasury
  private stratum: Stratum
  private database: Database
  private rewarding: Rewarding
  private monitoring: Monitoring
  private api: Api | undefined

  constructor (treasury: Treasury, stratum: Stratum, paymentThreshold: string) {
    this.treasury = treasury
    this.stratum = stratum
    
    this.database = new Database('./database')
    this.rewarding = new Rewarding(this.treasury.processor.rpc, this.database, paymentThreshold)
    this.monitoring = new Monitoring()

    this.stratum.on('subscription', (ip: string, agent: string) => this.monitoring.log(`Miner ${ip} subscribed into notifications with ${agent}.`))
    this.stratum.on('block', (hash: string, contribution: Contribution) => this.record(hash, contribution))
    this.treasury.on('coinbase', (amount: bigint) => {
      this.monitoring.log(`[EVENT] Received 'coinbase' event: ${(Number(amount) / 100000000).toFixed(8)} KAS`)
      this.distribute(amount)
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
    const oldBalance = this.database.getMiner('me').balance
    this.database.addBalance('me', amount)
    const newBalance = this.database.getMiner('me').balance
    const amountKAS = (Number(amount) / 100000000).toFixed(8)
    const balanceKAS = (Number(newBalance) / 100000000).toFixed(8)
    this.monitoring.log(`[Treasury] Generated ${amountKAS} KAS revenue (pool fee), treasury balance now: ${balanceKAS} KAS`)
    console.log(`[Treasury] Pool earnings updated: old=${(Number(oldBalance) / 100000000).toFixed(8)} KAS, added=${amountKAS} KAS, new=${balanceKAS} KAS`)
  }

  private async record (hash: string, contribution: Contribution) {
    const contributions = this.stratum.dump()
    contributions.push(contribution)

    const contributorCount = this.rewarding.recordContributions(hash, contributions)

    // Verify block is actually in the chain before recording
    try {
      const blockInfo = await this.treasury.processor.rpc.getBlock({ hash, includeTransactions: false }).catch(() => null)
      
      if (!blockInfo?.block) {
        // Block not found in chain - might be orphaned/rejected
        const addressWithPrefix = contribution.address.startsWith('kaspa:') ? contribution.address : `kaspa:${contribution.address}`
        this.monitoring.log(`⚠️ Block ${hash.substring(0, 16)}... submitted but not found in chain (may be orphaned/rejected)`)
        return // Don't record orphaned blocks
      }
      
      // Use the hash from the block header (ensures we use the canonical hash from the node)
      const confirmedHash = blockInfo.block.header.hash || hash
      
      // Block confirmed in chain - record it
      this.database.incrementBlockCount(contribution.address)
      
      // Store block details with confirmed hash
      this.database.addBlock({
        hash: confirmedHash,
        address: contribution.address,
        timestamp: Date.now(),
        difficulty: contribution.difficulty.toString(),
        paid: false
      })

      const addressWithPrefix = contribution.address.startsWith('kaspa:') ? contribution.address : `kaspa:${contribution.address}`
      this.monitoring.log(`✓ Block ${confirmedHash.substring(0, 16)}... found by ${addressWithPrefix} and confirmed in chain, ${contributorCount} contributor(s) recorded for rewards distribution.`)
      this.monitoring.log(`Rewards will mature after 100 DAA blocks (~10 seconds at 10 blocks/second) and then be distributed to miners.`)
    } catch (err) {
      // If verification fails, still record it but warn
      const addressWithPrefix = contribution.address.startsWith('kaspa:') ? contribution.address : `kaspa:${contribution.address}`
      this.monitoring.log(`⚠️ Could not verify block ${hash.substring(0, 16)}... in chain: ${err instanceof Error ? err.message : String(err)}`)
      this.monitoring.log(`Recording block anyway - verify manually in explorer`)
      
      this.database.incrementBlockCount(contribution.address)
      this.database.addBlock({
        hash,
        address: contribution.address,
        timestamp: Date.now(),
        difficulty: contribution.difficulty.toString(),
        paid: false
      })
    }
  }

  private async distribute (amount: bigint) {
    this.monitoring.log(`[DISTRIBUTE] Coinbase reward matured: ${sompiToKaspaStringWithSuffix(amount, this.treasury.processor.networkId!)}`)
    this.rewarding.recordPayment(amount, async (contributors, payments) => {
      this.monitoring.log(
        `[DISTRIBUTE] Coinbase with ${sompiToKaspaStringWithSuffix(amount, this.treasury.processor.networkId!)} is getting distributed into ${contributors} contributors.`
      )

      if (payments.length === 0) {
        this.monitoring.log(`[DISTRIBUTE] No payments found for current distribution cycle - rewards will be added to miner balances.`)
        return
      }
      
      // Store payment amounts before sending (for error recovery)
      const paymentAmounts = new Map<string, bigint>()
      for (const payment of payments) {
        const addressStr = typeof payment.address === 'string' ? payment.address : payment.address.toString()
        const addressForStorage = addressStr.replace(/^(kaspa:?|kaspatest:?)/i, '')
        paymentAmounts.set(addressForStorage, payment.amount)
      }
      
      this.monitoring.log(`[DISTRIBUTE] Processing ${payments.length} payout(s) totaling ${sompiToKaspaStringWithSuffix(payments.reduce((sum, p) => sum + BigInt(p.amount), 0n), this.treasury.processor.networkId!)}`)
      
      let txHashes: string[]
      try {
        // Log payment details before sending
        for (const payment of payments) {
          const addressStr = typeof payment.address === 'string' ? payment.address : payment.address.toString()
          const addressForStorage = addressStr.replace(/^(kaspa:?|kaspatest:?)/i, '')
          const amountKAS = (Number(payment.amount) / 100000000).toFixed(8)
          this.monitoring.log(`[DISTRIBUTE] Sending ${amountKAS} KAS to ${payment.address}`)
        }
        
        txHashes = await this.treasury.send(payments)
        
        if (!txHashes || txHashes.length === 0) {
          throw new Error('treasury.send() returned no transaction hashes')
        }
        
        this.monitoring.log(`[DISTRIBUTE] Successfully sent ${txHashes.length} transaction(s)`)
      } catch (sendError) {
        const errorMsg = sendError instanceof Error ? sendError.message : String(sendError)
        this.monitoring.log(`[DISTRIBUTE] ERROR: Failed to send payments: ${errorMsg}`)
        this.monitoring.log(`[DISTRIBUTE] Error stack: ${sendError instanceof Error ? sendError.stack : 'N/A'}`)
        
        // CRITICAL: Restore balances if payment failed (balances were deducted before sending)
        this.monitoring.log(`[DISTRIBUTE] Restoring balances after payment failure...`)
        for (const [address, amount] of paymentAmounts) {
          this.database.addBalance(address, amount)
          const amountKAS = (Number(amount) / 100000000).toFixed(8)
          this.monitoring.log(`[DISTRIBUTE] ✓ Restored ${amountKAS} KAS to ${address}`)
        }
        
        // Don't throw - allow pool to continue, balances are restored
        return
      }
      
      // Record payments in database only after successful send
      // treasury.send returns string[] - convert to ensure it's string
      const txHashStrings: string[] = txHashes.map(h => String(h))
      const addressesPaid = new Set<string>()
      
      for (let i = 0; i < payments.length; i++) {
        const payment = payments[i]
        const txHash = txHashStrings[i] || txHashStrings[0] // Use first hash if array mismatch
        // Ensure address is string (IPaymentOutput.address may be string | Address)
        // Address may have kaspa: prefix - remove it for storage (addresses stored without prefix)
        const addressStr = typeof payment.address === 'string' ? payment.address : payment.address.toString()
        const addressForStorage = addressStr.replace(/^(kaspa:?|kaspatest:?)/i, '')
        
        // Record payment in database
        this.database.addPayment({
          hash: txHash,
          address: addressForStorage,
          amount: payment.amount.toString(),
          timestamp: Date.now()
        })
        
        // Track which addresses received payments for block marking
        addressesPaid.add(addressForStorage)
        
        // Update last payout time (only after successful payment)
        const miner = this.database.getMiner(addressForStorage)
        if (miner.paymentIntervalHours && miner.paymentIntervalHours > 0) {
          this.database.setLastPayoutTime(addressForStorage, Date.now())
        }
      }
      
      // Mark blocks as paid for all blocks found by addresses that received payments
      for (const address of addressesPaid) {
        const blocks = this.database.getBlocksByAddress(address, 100)
        for (const block of blocks) {
          if (!block.paid) {
            // Update block to mark as paid
            const updatedBlock = { ...block, paid: true }
            this.database.addBlock(updatedBlock) // This will overwrite the existing block
          }
        }
      }
      
      this.monitoring.log(`Reward threshold exceeded by miner(s), individual rewards sent: \n${txHashes.map(h => `           - ${h}`).join('\n')}`)
    })
  }

  async forcePayoutMiner(address: string): Promise<{ success: boolean, paymentAmount: bigint, txHash: string, error?: string }> {
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
      
      // Record payment in database
      const txHash = txHashes[0]
      this.database.addPayment({
        hash: String(txHash),
        address: addressWithoutPrefix,
        amount: miner.balance.toString(),
        timestamp: Date.now()
      })
      
      // Deduct balance (was already deducted before sending, but ensure it's 0)
      this.database.addBalance(addressWithoutPrefix, -miner.balance)
      
      // Update last payout time if interval is set
      if (miner.paymentIntervalHours && miner.paymentIntervalHours > 0) {
        this.database.setLastPayoutTime(addressWithoutPrefix, Date.now())
      }
      
      // Mark blocks as paid
      const blocks = this.database.getBlocksByAddress(addressWithoutPrefix, 100)
      for (const block of blocks) {
        if (!block.paid) {
          const updatedBlock = { ...block, paid: true }
          this.database.addBlock(updatedBlock)
        }
      }
      
      this.monitoring.log(`Force payout (single miner): Successfully sent ${balanceKAS} KAS to ${addressWithPrefix} (tx: ${String(txHash).substring(0, 16)}...)`)
      
      return {
        success: true,
        paymentAmount: miner.balance,
        txHash: String(txHash)
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.monitoring.log(`Force payout (single miner) failed: ${errorMsg}`)
      console.error('[Pool] Force payout (single miner) error:', error)
      return {
        success: false,
        paymentAmount: 0n,
        txHash: '',
        error: errorMsg
      }
    }
  }

  async forcePayoutAll(): Promise<{ success: boolean, paymentsCount: number, totalAmount: bigint, txHashes: string[], error?: string }> {
    try {
      const allMiners = this.database.getAllMiners()
      const payments: Array<{ address: string, amount: bigint }> = []

      // Debug: Log all miners found
      this.monitoring.log(`Force payout: Found ${allMiners.size} miner(s) in database`)
      
      // Collect all miners with balance > 0
      // Force payout should send ALL pending balances regardless of threshold/time settings
      for (const [address, miner] of allMiners) {
        const balanceKAS = (Number(miner.balance) / 100000000).toFixed(8)
        const addressWithPrefix = address.startsWith('kaspa:') ? address : `kaspa:${address}`
        const balanceSompi = miner.balance.toString()
        
        // Log detailed info for debugging
        const paymentIntervalHours = miner.paymentIntervalHours
        const paymentThreshold = miner.paymentThreshold
        const lastPayoutTime = this.database.getLastPayoutTime(address)
        
        this.monitoring.log(`  Miner: ${addressWithPrefix}, Balance: ${balanceKAS} KAS (${balanceSompi} sompi)`)
        if (paymentIntervalHours) {
          this.monitoring.log(`    Payment interval: ${paymentIntervalHours} hours, Last payout: ${lastPayoutTime ? new Date(lastPayoutTime).toISOString() : 'never'}`)
        }
        if (paymentThreshold) {
          const thresholdKAS = (Number(paymentThreshold) / 100000000).toFixed(8)
          this.monitoring.log(`    Payment threshold: ${thresholdKAS} KAS`)
        }
        
        // Force payout sends ANY balance > 0, regardless of threshold/time
        if (miner.balance > 0n) {
          // Ensure address has kaspa: prefix for payment (required by Kaspa SDK)
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
              const paymentTime = new Date(latestPayment.timestamp).toISOString()
              this.monitoring.log(`  ${addressWithPrefix}: Last payment ${paymentKAS} KAS at ${paymentTime} (tx: ${latestPayment.hash.substring(0, 16)}...)`)
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
      
      // Check treasury balance before attempting payouts
      const treasuryBalance = this.database.getMiner('me').balance
      const requiredAmount = totalAmount
      
      // Note: We don't check if treasury has enough balance because treasury.send will handle UTXO management
      // But we should log warnings if balance seems low
      this.monitoring.log(`Force payout: Processing ${payments.length} payments totaling ${sompiToKaspaStringWithSuffix(totalAmount, this.treasury.processor.networkId!)}`)
      
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
        throw new Error(`Failed to send transactions: ${errorMsg}`)
      }
      
      // Validate that we got transaction hashes back
      if (!txHashes || txHashes.length === 0) {
        throw new Error('No transaction hashes returned from treasury.send - transactions may not have been submitted')
      }
      
      if (txHashes.length < payments.length) {
        this.monitoring.log(`Warning: Expected ${payments.length} transaction hashes, got ${txHashes.length}`)
      }
      
      // Convert txHashes to string array (treasury.send returns string[])
      const txHashStrings: string[] = txHashes.map(h => String(h))

      // Record payments and deduct balances
      for (let i = 0; i < payments.length; i++) {
        const payment = payments[i]
        const txHash = txHashStrings[i] || txHashStrings[txHashStrings.length - 1] // Use last hash if array mismatch
        
        // Validate transaction hash
        if (!txHash || txHash.length === 0) {
          this.monitoring.log(`Warning: Missing transaction hash for payment ${i + 1} to ${payment.address}`)
          continue
        }
        
        // Address may have kaspa: prefix - remove it for storage (addresses stored without prefix)
        const addressForStorage = payment.address.replace(/^(kaspa:?|kaspatest:?)/i, '')
        
        // Record payment
        this.database.addPayment({
          hash: txHash,
          address: addressForStorage,
          amount: payment.amount.toString(),
          timestamp: Date.now()
        })

        // Deduct balance and update last payout time (use address without prefix for database lookup)
        this.database.addBalance(addressForStorage, -payment.amount)
        const miner = this.database.getMiner(addressForStorage)
        if (miner.paymentIntervalHours && miner.paymentIntervalHours > 0) {
          this.database.setLastPayoutTime(addressForStorage, Date.now())
        }
        
        // Mark blocks as paid for this address
        const blocks = this.database.getBlocksByAddress(addressForStorage, 100)
        for (const block of blocks) {
          if (!block.paid) {
            const updatedBlock = { ...block, paid: true }
            this.database.addBlock(updatedBlock) // Overwrite with paid status
          }
        }
        
        // Log successful payment
        const addressWithPrefix = payment.address.startsWith('kaspa:') ? payment.address : `kaspa:${payment.address}`
        this.monitoring.log(`  ✓ Paid ${(Number(payment.amount) / 100000000).toFixed(8)} KAS to ${addressWithPrefix} - tx: ${txHash}`)
      }

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
      console.error('[Pool] Force payout error:', error)
      return {
        success: false,
        paymentsCount: 0,
        totalAmount: 0n,
        txHashes: [] as string[],
        error: errorMsg
      }
    }
  }
}