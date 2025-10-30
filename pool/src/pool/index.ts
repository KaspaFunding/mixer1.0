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
    this.api = new Api(port, this.treasury, this.stratum, this.database)
    this.monitoring.log(`JSON/HTTP API is listening on port ${this.api.server.port}.`)
  }

  private async revenuize (amount: bigint) {
    this.database.addBalance('me', amount)
    this.monitoring.log(`Treasury generated ${sompiToKaspaStringWithSuffix(amount, this.treasury.processor.networkId!)} revenue over last coinbase.`)
  }

  private record (hash: string, contribution: Contribution) {
    const contributions = this.stratum.dump()
    contributions.push(contribution)

    const contributorCount = this.rewarding.recordContributions(hash, contributions)

    this.monitoring.log(`Block ${hash} has been successfully submitted to the network, ${contributorCount} contributor(s) recorded for rewards distribution.`)
  }

  private async distribute (amount: bigint) {
    this.rewarding.recordPayment(amount, async (contributors, payments) => {
      this.monitoring.log(
        `Coinbase with ${sompiToKaspaStringWithSuffix(amount, this.treasury.processor.networkId!)} is getting distributed into ${contributors} contributors.`
      )

      if (payments.length === 0) return this.monitoring.log(`No payments found for current distribution cycle.`)
      
      const hash = await this.treasury.send(payments)
      this.monitoring.log(`Reward threshold exceeded by miner(s), individual rewards sent: \n${hash.map(h => `           - ${h}`).join('\n')}`)
    })
  }
}