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
      '/miners': () => this.getMiners(),
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

  private getMiners () {
    const miners = Array.from(this.stratum.miners.keys()).map((address) => {
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

      // Format address with kaspa: prefix for display
      const formattedAddress = address.startsWith('kaspa:') ? address : `kaspa:${address}`

      return {
        address: formattedAddress,
        balance: miner.balance.toString(),
        connections: connections?.size ?? 0,
        workers: workers.length,
        workersDetail: workers
      }
    })

    return { miners }
  }

  private getMiner (address: string) {
    // Remove kaspa: prefix if present for internal lookup (addresses stored without prefix)
    const addressWithoutPrefix = address.replace(/^(kaspa:?|kaspatest:?)/i, '')
    const miner = this.database.getMiner(addressWithoutPrefix)
    const connections = this.stratum.miners.get(addressWithoutPrefix)

    const workers = connections ? Array.from(connections).flatMap((session) => {
      const { agent, difficulty, workers } = session.data

      return Array.from(workers, ([, workerName ]) => ({
          name: workerName,
          agent,
          difficulty: difficulty.toNumber()
      }))
    }) : []

    // Format address with kaspa: prefix for display
    const formattedAddress = addressWithoutPrefix.startsWith('kaspa:') ? addressWithoutPrefix : `kaspa:${addressWithoutPrefix}`

    return {
      address: formattedAddress,
      balance: miner.balance.toString(),
      connections: connections?.size ?? 0,
      workers
    }
  }
}
