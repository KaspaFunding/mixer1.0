let lmdbOpen: any = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  lmdbOpen = require('lmdb').open
} catch (_) {
  lmdbOpen = null
}
import fs from 'fs'
import path from 'path'
import type { RootDatabase, Database as SubDatabase, Key } from 'lmdb'

type Miner = {
  balance: bigint
  paymentThreshold?: bigint
  paymentIntervalHours?: number
  lastPayoutTime?: number
  blocksFound?: number
}

const defaultMiner: Miner = {
  balance: 0n,
  blocksFound: 0
}

type Block = {
  hash: string
  address: string
  timestamp: number
  difficulty?: string
  paid?: boolean
}

type Payment = {
  hash: string
  address: string
  amount: string
  timestamp: number
}

export default class Database {
  db: RootDatabase<any, Key> | null
  miners: SubDatabase<Miner, string> | null
  blocks: SubDatabase<Block, string> | null
  payments: SubDatabase<Payment, string> | null
  useLmdb: boolean
  jsonPath: string
  blocksJsonPath: string
  paymentsJsonPath: string

  constructor (dirPath: string) {
    this.useLmdb = Boolean(lmdbOpen)
    if (this.useLmdb) {
      this.db = lmdbOpen({ path: dirPath })
      // @ts-ignore
      this.miners = this.db.openDB('miners', {})
      // @ts-ignore
      this.blocks = this.db.openDB('blocks', {})
      // @ts-ignore
      this.payments = this.db.openDB('payments', {})
    } else {
      this.db = null
      this.miners = null
      this.blocks = null
      this.payments = null
      // ensure directory
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true })
      this.jsonPath = path.join(dirPath, 'miners.json')
      this.blocksJsonPath = path.join(dirPath, 'blocks.json')
      this.paymentsJsonPath = path.join(dirPath, 'payments.json')
      if (!fs.existsSync(this.jsonPath)) fs.writeFileSync(this.jsonPath, JSON.stringify({}), 'utf-8')
      if (!fs.existsSync(this.blocksJsonPath)) fs.writeFileSync(this.blocksJsonPath, JSON.stringify({}), 'utf-8')
      if (!fs.existsSync(this.paymentsJsonPath)) fs.writeFileSync(this.paymentsJsonPath, JSON.stringify({}), 'utf-8')
    }
  }

  getMiner (address: string) {
    if (this.useLmdb && this.miners) {
      // @ts-ignore
      return this.miners.get(address) ?? { ...defaultMiner }
    }
    const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
    const minerData = data[address]
    if (!minerData) {
      return { ...defaultMiner }
    }
    // Convert balance from string/number to BigInt when reading from JSON
    return {
      ...minerData,
      balance: typeof minerData.balance === 'string' ? BigInt(minerData.balance) : BigInt(minerData.balance || 0),
      paymentThreshold: minerData.paymentThreshold ? (typeof minerData.paymentThreshold === 'string' ? BigInt(minerData.paymentThreshold) : BigInt(minerData.paymentThreshold)) : undefined,
      blocksFound: minerData.blocksFound ?? 0
    } as Miner
  }

  addBalance (address: string, balance: bigint) {
    if (this.useLmdb && this.miners) {
      // @ts-ignore
      return this.miners.transactionSync(() => {
        const miner = this.getMiner(address)
        miner.balance += balance
        // @ts-ignore
        this.miners.putSync(address, miner)
      })
    }
    const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
    const miner = this.getMiner(address)
    miner.balance = miner.balance + balance
    data[address] = this.serializeMiner(miner)
    fs.writeFileSync(this.jsonPath, JSON.stringify(data), 'utf-8')
  }

  // Helper to convert Miner (with BigInt) to JSON-serializable object
  private serializeMiner(miner: Miner) {
    return {
      balance: miner.balance.toString(),
      paymentThreshold: miner.paymentThreshold ? miner.paymentThreshold.toString() : undefined,
      paymentIntervalHours: miner.paymentIntervalHours,
      lastPayoutTime: miner.lastPayoutTime,
      blocksFound: miner.blocksFound ?? 0
    }
  }

  setPaymentInterval(address: string, intervalHours: number | undefined) {
    try {
      if (this.useLmdb && this.miners) {
        // @ts-ignore
        return this.miners.transactionSync(() => {
          const miner = this.getMiner(address)
          miner.paymentIntervalHours = intervalHours
          // @ts-ignore
          this.miners.putSync(address, miner)
        })
      }
      const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
      const miner = this.getMiner(address)
      miner.paymentIntervalHours = intervalHours
      data[address] = this.serializeMiner(miner)
      fs.writeFileSync(this.jsonPath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (error) {
      console.error('[Database] Error setting payment interval for', address, ':', error)
      throw new Error(`Failed to save payment interval: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  getPaymentInterval(address: string): number | undefined {
    const miner = this.getMiner(address)
    return miner.paymentIntervalHours
  }

  setLastPayoutTime(address: string, timestamp: number) {
    if (this.useLmdb && this.miners) {
      // @ts-ignore
      return this.miners.transactionSync(() => {
        const miner = this.getMiner(address)
        miner.lastPayoutTime = timestamp
        // @ts-ignore
        this.miners.putSync(address, miner)
      })
    }
    const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
    const miner = this.getMiner(address)
    miner.lastPayoutTime = timestamp
    data[address] = this.serializeMiner(miner)
    fs.writeFileSync(this.jsonPath, JSON.stringify(data), 'utf-8')
  }

  getLastPayoutTime(address: string): number | undefined {
    const miner = this.getMiner(address)
    return miner.lastPayoutTime
  }

  incrementBlockCount(address: string) {
    if (this.useLmdb && this.miners) {
      // @ts-ignore
      return this.miners.transactionSync(() => {
        const miner = this.getMiner(address)
        miner.blocksFound = (miner.blocksFound ?? 0) + 1
        // @ts-ignore
        this.miners.putSync(address, miner)
      })
    }
    const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
    const miner = this.getMiner(address)
    miner.blocksFound = (miner.blocksFound ?? 0) + 1
    data[address] = this.serializeMiner(miner)
    fs.writeFileSync(this.jsonPath, JSON.stringify(data), 'utf-8')
  }

  getBlockCount(address: string): number {
    const miner = this.getMiner(address)
    return miner.blocksFound ?? 0
  }

  getTotalBlockCount(): number {
    if (this.useLmdb && this.miners) {
      let total = 0
      // @ts-ignore
      this.miners.getKeys().forEach((key: string) => {
        const miner = this.getMiner(key)
        total += miner.blocksFound ?? 0
      })
      return total
    }
    const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
    let total = 0
    for (const address in data) {
      const minerData = data[address]
      total += minerData?.blocksFound ?? 0
    }
    return total
  }

  getAllMiners(): Map<string, Miner> {
    const miners = new Map<string, Miner>()
    if (this.useLmdb && this.miners) {
      // @ts-ignore
      this.miners.getKeys().forEach((key: string) => {
        if (key !== 'me') { // Exclude pool's own balance
          const miner = this.getMiner(key)
          miners.set(key, miner)
        }
      })
    } else {
      const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
      for (const address in data) {
        if (address !== 'me') { // Exclude pool's own balance
          const miner = this.getMiner(address)
          miners.set(address, miner)
        }
      }
    }
    return miners
  }

  addBlock(block: Block) {
    if (this.useLmdb && this.blocks) {
      // @ts-ignore
      return this.blocks.transactionSync(() => {
        // @ts-ignore
        const existing = this.blocks.get(block.hash)
        if (existing) return // Don't duplicate
        // @ts-ignore
        this.blocks.putSync(block.hash, block)
      })
    }
    const data = JSON.parse(fs.readFileSync(this.blocksJsonPath, 'utf-8') || '{}')
    if (data[block.hash]) return // Don't duplicate
    data[block.hash] = block
    // Keep only last 1000 blocks to prevent file growth
    const entries = Object.entries(data).sort((a: [string, any], b: [string, any]) => 
      (b[1].timestamp || 0) - (a[1].timestamp || 0))
    const limited = Object.fromEntries(entries.slice(0, 1000))
    fs.writeFileSync(this.blocksJsonPath, JSON.stringify(limited), 'utf-8')
  }

  getBlocks(limit: number = 100): Block[] {
    if (this.useLmdb && this.blocks) {
      const blocks: Block[] = []
      // @ts-ignore
      this.blocks.getKeys({ limit, reverse: true }).forEach((key: string) => {
        // @ts-ignore
        const block = this.blocks.get(key)
        if (block) blocks.push(block)
      })
      return blocks
    }
    const data = JSON.parse(fs.readFileSync(this.blocksJsonPath, 'utf-8') || '{}')
    return Object.values(data).sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, limit) as Block[]
  }

  getBlocksByAddress(address: string, limit: number = 100): Block[] {
    const allBlocks = this.getBlocks(1000)
    const addressBlocks = allBlocks.filter(b => b.address === address)
    return addressBlocks.slice(0, limit)
  }

  addPayment(payment: Payment) {
    if (this.useLmdb && this.payments) {
      // @ts-ignore
      return this.payments.transactionSync(() => {
        // @ts-ignore
        this.payments.putSync(payment.hash, payment)
      })
    }
    const data = JSON.parse(fs.readFileSync(this.paymentsJsonPath, 'utf-8') || '{}')
    data[payment.hash] = payment
    // Keep only last 1000 payments
    const entries = Object.entries(data).sort((a: [string, any], b: [string, any]) => 
      (b[1].timestamp || 0) - (a[1].timestamp || 0))
    const limited = Object.fromEntries(entries.slice(0, 1000))
    fs.writeFileSync(this.paymentsJsonPath, JSON.stringify(limited), 'utf-8')
  }

  getPaymentsByAddress(address: string, limit: number = 100): Payment[] {
    if (this.useLmdb && this.payments) {
      const payments: Payment[] = []
      // @ts-ignore
      this.payments.getKeys({ limit: 1000, reverse: true }).forEach((key: string) => {
        // @ts-ignore
        const payment = this.payments.get(key)
        if (payment && payment.address === address) payments.push(payment)
      })
      return payments.slice(0, limit)
    }
    const data = JSON.parse(fs.readFileSync(this.paymentsJsonPath, 'utf-8') || '{}')
    return Object.values(data)
      .filter((p: any) => p.address === address)
      .sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit) as Payment[]
  }

  getRecentPayments(limit: number = 100): Payment[] {
    if (this.useLmdb && this.payments) {
      const payments: Payment[] = []
      // @ts-ignore
      this.payments.getKeys({ limit, reverse: true }).forEach((key: string) => {
        // @ts-ignore
        const payment = this.payments.get(key)
        if (payment) payments.push(payment)
      })
      return payments
    }
    const data = JSON.parse(fs.readFileSync(this.paymentsJsonPath, 'utf-8') || '{}')
    return Object.values(data)
      .sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit) as Payment[]
  }

  setPaymentThreshold(address: string, threshold: bigint | undefined) {
    if (this.useLmdb && this.miners) {
      // @ts-ignore
      return this.miners.transactionSync(() => {
        const miner = this.getMiner(address)
        miner.paymentThreshold = threshold
        // @ts-ignore
        this.miners.putSync(address, miner)
      })
    }
    const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
    const miner = this.getMiner(address)
    miner.paymentThreshold = threshold
    data[address] = this.serializeMiner(miner)
    fs.writeFileSync(this.jsonPath, JSON.stringify(data), 'utf-8')
  }

  getPaymentThreshold(address: string): bigint | undefined {
    const miner = this.getMiner(address)
    return miner.paymentThreshold
  }
}