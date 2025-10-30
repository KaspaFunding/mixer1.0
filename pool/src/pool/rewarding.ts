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
    if (this.payments.length === 0 || this.processing) return
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
      const newBalance = share.plus(miner.balance.toString())

      if (newBalance.gt(this.paymentThreshold)) {
        this.database.addBalance(address, -miner.balance)

        payments.push({
          address,
          amount: BigInt(newBalance.toFixed(0))
        })
      } else {
        this.database.addBalance(address, BigInt(share.toFixed(0)))
      }
    }

    return { contributors: contributors.size, payments }
  }
}