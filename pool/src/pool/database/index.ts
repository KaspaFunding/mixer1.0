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
}

const defaultMiner: Miner = {
  balance: 0n
}

export default class Database {
  db: RootDatabase<any, Key> | null
  miners: SubDatabase<Miner, string> | null
  useLmdb: boolean
  jsonPath: string

  constructor (dirPath: string) {
    this.useLmdb = Boolean(lmdbOpen)
    if (this.useLmdb) {
      this.db = lmdbOpen({ path: dirPath })
      // @ts-ignore
      this.miners = this.db.openDB('miners', {})
    } else {
      this.db = null
      this.miners = null
      // ensure directory
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true })
      this.jsonPath = path.join(dirPath, 'miners.json')
      if (!fs.existsSync(this.jsonPath)) fs.writeFileSync(this.jsonPath, JSON.stringify({}), 'utf-8')
    }
  }

  getMiner (address: string) {
    if (this.useLmdb && this.miners) {
      // @ts-ignore
      return this.miners.get(address) ?? { ...defaultMiner }
    }
    const data = JSON.parse(fs.readFileSync(this.jsonPath, 'utf-8') || '{}')
    return (data[address] as Miner) ?? { ...defaultMiner }
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
    const miner: Miner = (data[address] as Miner) ?? { ...defaultMiner }
    miner.balance = BigInt(miner.balance || 0) + balance
    data[address] = miner
    fs.writeFileSync(this.jsonPath, JSON.stringify(data), 'utf-8')
  }
}