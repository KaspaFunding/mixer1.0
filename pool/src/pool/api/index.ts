import Server from './server'
import type Stratum from '../../stratum'
import type Treasury from '../../treasury'
import type Database from '../database'

type Worker = {
  name: string,
  agent: string,
  difficulty: number
}

export default class Api extends Server {
  private treasury: Treasury
  private stratum: Stratum
  private database: Database

  constructor (port: number, treasury: Treasury, stratum: Stratum, database: Database) {
    super({
      '/status': () => this.status(),
      '/miner': ({ address }) => this.getMiner(address)
    }, port)

    this.treasury = treasury
    this.stratum = stratum
    this.database = database
  }

  private status () {
    return {
      networkId: this.treasury.processor.networkId!,
      miners: this.stratum.miners.size,
      workers: this.stratum.subscriptors.size
    }
  }

  private getMiner (address: string) {
    const miner = this.database.getMiner(address)
    const connections = this.stratum.miners.get(address)

    const workers = connections ? Array.from(connections).flatMap((session) => {
      const { agent, difficulty, workers } = session.data

      return Array.from(workers, ([, workerName ]) => ({
          name: workerName,
          agent,
          difficulty: difficulty.toNumber()
      }))
    }) : []

    return {
      balance: miner.balance.toString(),
      connections: connections?.size ?? 0,
      workers
    }
  }
}
