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
    let miners = new Map<string, Decimal>()
    const totalWork = contributions.reduce((knownWork, { address, difficulty }) => {
      const currentWork = miners.get(address) ?? new Decimal(0)
      miners.set(address, currentWork.plus(difficulty))

      return knownWork.plus(difficulty)
    }, new Decimal(0))

    this.rewards.set(hash, miners)
    this.accumulatedWork.set(hash, totalWork)

    return miners.size
  }

  recordPayment (amount: bigint, callback: PaymentCallback) {
    this.payments.push([ amount, callback ])
    this.processPayments()
  }

  private async processPayments () {
    if (this.payments.length === 0 || this.processing) return
    this.processing = true

    const [ amount, callback ] = this.payments.pop()!
    const { contributors, payments } = await this.determinePayments(amount)

    callback(contributors, payments)

    this.processing = false
    this.processPayments()
  }

  private async determinePayments (amount: bigint) {
    let contributors: Map<string, Decimal> = new Map()
    let accumulatedWork = new Decimal(0)
    let payments: IPaymentOutput[] = []

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
      const shareAmount = BigInt(share.toFixed(0))
      
      // Add the share to the miner's balance first
      this.database.addBalance(address, shareAmount)
      
      // Get the updated balance after adding the share
      const updatedMiner = this.database.getMiner(address)
      const currentBalance = updatedMiner.balance

      // Check if updated balance exceeds payment threshold
      const currentBalanceDecimal = new Decimal(currentBalance.toString())
      if (currentBalanceDecimal.gt(this.paymentThreshold)) {
        // Deduct full balance for payout
        this.database.addBalance(address, -currentBalance)

        // Ensure address has kaspa: prefix for payment
        const addressForPayment = address.startsWith('kaspa:') ? address : `kaspa:${address}`
        payments.push({
          address: addressForPayment,
          amount: currentBalance
        })
      }
      // If threshold not met, balance already updated with share
    }

    return { contributors: contributors.size, payments }
  }

  // Helper methods for external access
  getRewardsCount(): number {
    return this.rewards.size
  }

  clearRewards(): void {
    this.rewards.clear()
    this.accumulatedWork.clear()
  }

  hasReward(hash: string): boolean {
    return this.rewards.has(hash)
  }

  // Restore contributions from database blocks
  async restoreContributionsFromDatabase(singleBlockHash?: string) {
    try {
      const allBlocks = this.database.getBlocks(1000)
      if (allBlocks.length === 0) {
        return
      }

      const Decimal = (await import('decimal.js')).default
      let restoredCount = 0
      let skippedPaidCount = 0
      let skippedDuplicateCount = 0
      
      const uniqueBlocks = new Map<string, typeof allBlocks[0]>()
      for (const block of allBlocks) {
        if (!uniqueBlocks.has(block.hash)) {
          uniqueBlocks.set(block.hash, block)
        }
      }

      for (const block of uniqueBlocks.values()) {
        if (singleBlockHash && block.hash !== singleBlockHash) {
          continue
        }
        
        if (block.paid) {
          skippedPaidCount++
          continue
        }
        
        if (this.rewards.has(block.hash)) {
          skippedDuplicateCount++
          continue
        }

        let contributionsToRestore: Array<{ address: string, difficulty: Decimal }> = []
        
        if (block.contributions && Array.isArray(block.contributions) && block.contributions.length > 0) {
          contributionsToRestore = block.contributions.map(c => ({
            address: c.address.replace(/^(kaspa:?|kaspatest:?)/i, ''),
            difficulty: new Decimal(c.difficulty || '0')
          }))
        } else {
          const addressClean = block.address.replace(/^(kaspa:?|kaspatest:?)/i, '')
          contributionsToRestore = [{
            address: addressClean,
            difficulty: new Decimal(block.difficulty || '0')
          }]
        }

        this.recordContributions(block.hash, contributionsToRestore)
        restoredCount++
      }

      if (restoredCount > 0) {
        console.log(`[Rewarding] Restored ${restoredCount} unpaid block(s) from database`)
      }
    } catch (error) {
      console.error(`[Rewarding] Error restoring contributions from database:`, error)
    }
  }
}
