import type { RpcClient } from "../../wasm/kaspa";
import type { IPaymentOutput } from "../../wasm/kaspa"
import type Database from "./database"
import { Decimal } from 'decimal.js'

type PaymentCallback = (contributors: number, payments: IPaymentOutput[]) => void

export default class Rewarding {
  node: RpcClient
  database: Database
  paymentThreshold: Decimal

  rewards: Map<string, Map<string, Decimal>> = new Map()
  accumulatedWork: Map<string, Decimal> = new Map()
  payments: [ bigint, PaymentCallback ][] = []
  processing: boolean = false

  constructor (node: RpcClient, database: Database, paymentThreshold: string) {
    this.node = node
    this.database = database
    this.paymentThreshold = new Decimal(paymentThreshold)
  }

  recordContributions (hash: string, contributions: {
    address: string
    difficulty: Decimal
  }[]) {
    // Store contributions per address (aggregate work by address)
    let miners = new Map<string, Decimal>()
    const totalWork = contributions.reduce((knownWork, { address, difficulty }) => {
      const currentWork = miners.get(address) ?? new Decimal(0)
      miners.set(address, currentWork.plus(difficulty))

      return knownWork.plus(difficulty)
    }, new Decimal(0))

    // Store as Map<string, Decimal> - address -> work mapping
    this.rewards.set(hash, miners)
    this.accumulatedWork.set(hash, totalWork)

    return miners.size
  }

  recordPayment (amount: bigint, callback: PaymentCallback) {
    this.payments.push([ amount, callback ])
    this.processPayments()
  }

  private async processPayments () {
    if (this.payments.length === 0 || this.processing) return
    this.processing = true

    const [ amount, callback ] = this.payments.pop()!
    const { contributors, payments } = await this.determinePayments(amount)

    callback(contributors, payments)

    this.processing = false
    this.processPayments()
  }

  private async determinePayments (amount: bigint) {
    // CRITICAL: Always restore contributions from database before calculating payments
    // This ensures contributions are available even after pool restart
    // We restore ALL unpaid blocks to ensure miners get paid correctly
    if (this.rewards.size === 0) {
      console.log(`[Rewarding] Rewards map is empty, restoring contributions from database...`)
    } else {
      console.log(`[Rewarding] Rewards map has ${this.rewards.size} block(s), but checking for missing contributions...`)
    }
    
    // Always restore - even if map has some entries, we might be missing blocks
    await this.restoreContributionsFromDatabase()
    
    let contributors: Map<string, Decimal> = new Map()
    let accumulatedWork = new Decimal(0)
    let payments: IPaymentOutput[] = []

    // Log how many blocks we're processing
    console.log(`[Rewarding] Processing ${this.rewards.size} block(s) for distribution`)

    for (const hash of this.rewards.keys()) {
      for (const [ address, work ] of this.rewards.get(hash)!) {
        const currentWork = contributors.get(address) ?? new Decimal(0)
        contributors.set(address, currentWork.plus(work))
      }

      accumulatedWork = accumulatedWork.plus(this.accumulatedWork.get(hash)!)

      this.rewards.delete(hash)
      this.accumulatedWork.delete(hash)

      const { blue } = await this.node.getCurrentBlockColor({ hash }).catch(() => ({ blue: false }))
      if (blue) break
    }

    for (const [ address, work ] of contributors) {
      const share = work.div(accumulatedWork).mul(amount.toString())
      const miner = this.database.getMiner(address)
      const oldBalance = miner.balance.toString()
      const newBalance = share.plus(miner.balance.toString())
      const shareSompi = BigInt(share.toFixed(0))
      const shareKAS = (Number(shareSompi) / 100000000).toFixed(8)

      // Get payment interval early so we can use it for both checks and updates
      const paymentIntervalHours = miner.paymentIntervalHours

      let shouldPay = false

      // Check threshold-based payout
      if (newBalance.gt(this.paymentThreshold)) {
        shouldPay = true
      }

      // Check time-based payout
      if (paymentIntervalHours && paymentIntervalHours > 0 && newBalance.gt(0)) {
        const lastPayoutTime = this.database.getLastPayoutTime(address)
        const now = Date.now()
        const intervalMs = paymentIntervalHours * 60 * 60 * 1000

        // If never paid before, or interval has passed, trigger payout
        if (!lastPayoutTime || (now - lastPayoutTime) >= intervalMs) {
          shouldPay = true
        }
      }

      if (shouldPay) {
        // Deduct the full balance before payment (this happens BEFORE payment is sent)
        // If payment fails, balance will be restored or handled by error recovery
        this.database.addBalance(address, -miner.balance)

        // NOTE: lastPayoutTime should NOT be set here - it will be set AFTER successful payment
        // Setting it here would mark payment as sent even if treasury.send() fails

        // Ensure address has kaspa: prefix for payment (required by Kaspa SDK)
        const addressForPayment = address.startsWith('kaspa:') ? address : `kaspa:${address}`
        payments.push({
          address: addressForPayment,
          amount: BigInt(newBalance.toFixed(0))
        })
        console.log(`[DISTRIBUTE] Added payout for ${address}: ${(Number(newBalance.toFixed(0)) / 100000000).toFixed(8)} KAS (old: ${(Number(oldBalance) / 100000000).toFixed(8)} KAS, share: ${shareKAS} KAS)`)
      } else {
        // Just add the share to the balance
        this.database.addBalance(address, shareSompi)
        const addressWithPrefix = address.startsWith('kaspa:') ? address : `kaspa:${address}`
        console.log(`[DISTRIBUTE] Added ${shareKAS} KAS to ${addressWithPrefix} balance (old: ${(Number(oldBalance) / 100000000).toFixed(8)} KAS, new: ${(Number(newBalance.toFixed(0)) / 100000000).toFixed(8)} KAS)`)
      }
    }

    return { contributors: contributors.size, payments }
  }

  // Restore contributions from database blocks
  private async restoreContributionsFromDatabase() {
    try {
      // Get all blocks from database
      const allBlocks = this.database.getBlocks(1000)
      
      if (allBlocks.length === 0) {
        console.log(`[Rewarding] No blocks found in database to restore contributions`)
        return
      }

      // Import Decimal
      const Decimal = (await import('decimal.js')).default

      // Restore contributions for each block
      // IMPORTANT: Only restore UNPAID blocks - paid blocks don't need contributions anymore
      let restoredCount = 0
      let skippedPaidCount = 0
      let skippedDuplicateCount = 0
      
      for (const block of allBlocks) {
        // Skip blocks that are already marked as paid
        if (block.paid) {
          skippedPaidCount++
          continue
        }
        
        const addressClean = block.address.replace(/^(kaspa:?|kaspatest:?)/i, '')
        const contribution = {
          address: addressClean,
          difficulty: new Decimal(block.difficulty || '0')
        }

        // Check if this block hash is already in rewards (don't duplicate)
        if (!this.rewards.has(block.hash)) {
          this.recordContributions(block.hash, [contribution])
          restoredCount++
          console.log(`[Rewarding] ✓ Restored contribution for block ${block.hash.substring(0, 16)}... from ${addressClean} (difficulty: ${block.difficulty})`)
        } else {
          skippedDuplicateCount++
        }
      }

      console.log(`[Rewarding] Restored ${restoredCount} unpaid block contribution(s) from database`)
      if (skippedPaidCount > 0) {
        console.log(`[Rewarding] Skipped ${skippedPaidCount} paid block(s)`)
      }
      if (skippedDuplicateCount > 0) {
        console.log(`[Rewarding] Skipped ${skippedDuplicateCount} duplicate block(s) already in rewards map`)
      }
      
      // Log final state
      if (this.rewards.size > 0) {
        console.log(`[Rewarding] Rewards map now has ${this.rewards.size} block(s) ready for distribution`)
        // Log which addresses will receive rewards
        const addresses = new Set<string>()
        for (const [hash, miners] of this.rewards) {
          for (const [address] of miners) {
            addresses.add(address)
          }
        }
        if (addresses.size > 0) {
          console.log(`[Rewarding] Contributors: ${addresses.size} address(es): ${Array.from(addresses).slice(0, 5).map(a => a.substring(0, 16) + '...').join(', ')}${addresses.size > 5 ? '...' : ''}`)
        }
      } else {
        console.warn(`[Rewarding] ⚠️ WARNING: Rewards map is still empty after restoration! No contributions found for unpaid blocks.`)
      }
    } catch (error) {
      console.error(`[Rewarding] Error restoring contributions from database:`, error)
    }
  }
}