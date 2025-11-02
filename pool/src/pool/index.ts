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
    this.treasury.on('coinbase', (amount: bigint) => this.distribute(amount))
    this.treasury.on('revenue', (amount: bigint) => this.revenuize(amount))
  
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

  private record (hash: string, contribution: Contribution) {
    const contributions = this.stratum.dump()
    contributions.push(contribution)

    const contributorCount = this.rewarding.recordContributions(hash, contributions)

    // Record block found for the miner who found it
    this.database.incrementBlockCount(contribution.address)

    // Store block details
    this.database.addBlock({
      hash,
      address: contribution.address,
      timestamp: Date.now(),
      difficulty: contribution.difficulty.toString(),
      paid: false
    })

    const addressWithPrefix = contribution.address.startsWith('kaspa:') ? contribution.address : `kaspa:${contribution.address}`
    this.monitoring.log(`Block ${hash.substring(0, 16)}... found by ${addressWithPrefix}, ${contributorCount} contributor(s) recorded for rewards distribution.`)
    this.monitoring.log(`Rewards will mature in ~200 DAA blocks (~33 minutes) and then be distributed to miners.`)
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
      
      this.monitoring.log(`[DISTRIBUTE] Processing ${payments.length} payout(s) totaling ${sompiToKaspaStringWithSuffix(payments.reduce((sum, p) => sum + BigInt(p.amount), 0n), this.treasury.processor.networkId!)}`)
      const txHashes = await this.treasury.send(payments)
      
      // Record payments in database
      // treasury.send returns string[] - convert to ensure it's string
      const txHashStrings: string[] = txHashes.map(h => String(h))
      for (let i = 0; i < payments.length; i++) {
        const payment = payments[i]
        const txHash = txHashStrings[i] || txHashStrings[0] // Use first hash if array mismatch
        // Ensure address is string (IPaymentOutput.address may be string | Address)
        const addressStr = typeof payment.address === 'string' ? payment.address : payment.address.toString()
        this.database.addPayment({
          hash: txHash,
          address: addressStr,
          amount: payment.amount.toString(),
          timestamp: Date.now()
        })
      }
      
      this.monitoring.log(`Reward threshold exceeded by miner(s), individual rewards sent: \n${txHashes.map(h => `           - ${h}`).join('\n')}`)
    })
  }

  async forcePayoutAll(): Promise<{ success: boolean, paymentsCount: number, totalAmount: bigint, txHashes: string[], error?: string }> {
    try {
      const allMiners = this.database.getAllMiners()
      const payments: Array<{ address: string, amount: bigint }> = []

      // Debug: Log all miners found
      this.monitoring.log(`Force payout: Found ${allMiners.size} miner(s) in database`)
      
      // Collect all miners with balance > 0
      for (const [address, miner] of allMiners) {
        const balanceKAS = (Number(miner.balance) / 100000000).toFixed(8)
        const addressWithPrefix = address.startsWith('kaspa:') ? address : `kaspa:${address}`
        this.monitoring.log(`  Miner: ${addressWithPrefix}, Balance: ${balanceKAS} KAS (${miner.balance.toString()} sompi)`)
        
        if (miner.balance > 0n) {
          payments.push({
            address,
            amount: miner.balance
          })
        }
      }

      if (payments.length === 0) {
        this.monitoring.log('Force payout: No miners with pending balance')
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
        
        // Record payment
        this.database.addPayment({
          hash: txHash,
          address: payment.address,
          amount: payment.amount.toString(),
          timestamp: Date.now()
        })

        // Deduct balance and update last payout time
        this.database.addBalance(payment.address, -payment.amount)
        const miner = this.database.getMiner(payment.address)
        if (miner.paymentIntervalHours && miner.paymentIntervalHours > 0) {
          this.database.setLastPayoutTime(payment.address, Date.now())
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