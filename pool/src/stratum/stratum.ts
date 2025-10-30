import type { Socket } from 'bun'
import { EventEmitter } from 'events' 
import { randomBytes } from 'crypto'
import { type Miner } from './index.ts'
import { StratumError, type Event } from './protocol.ts'
import type Templates from '../templates/index.ts'
import { calculateTarget, Address } from "../../wasm/kaspa"
import { Decimal } from 'decimal.js'

export type Contribution = { address: string, difficulty: Decimal }

export default class Stratum extends EventEmitter {
  private templates: Templates
  private contributions: Map<bigint, Contribution> = new Map() // TODO: Apply PPLNS maybe?
  subscriptors: Set<Socket<Miner>> = new Set()
  miners: Map<string, Set<Socket<Miner>>> = new Map()

  constructor (templates: Templates) {
    super()

    this.templates = templates
    this.templates.register((id, hash, timestamp) => this.announce(id, hash, timestamp))
  }

  private announce (id: string, hash: string, timestamp: bigint) {
    const timestampLE = Buffer.alloc(8)
    timestampLE.writeBigUInt64LE(timestamp)

    const task: Event<'mining.notify'> = {
      method: 'mining.notify',
      params: [ id, hash + timestampLE.toString('hex') ]
    }

    const job = JSON.stringify(task)

    this.subscriptors.forEach((socket) => {
      // @ts-ignore
      if (socket.readyState === 1) {
        socket.write(job + '\n')
      } else {
        for (const [ address ] of socket.data.workers) {
          const miners = this.miners.get(address)!
          miners.delete(socket)

          if (miners.size === 0) {
            this.miners.delete(address)
          }
        }

        this.subscriptors.delete(socket)
      }
    })
  }

  subscribe (socket: Socket<Miner>, agent: string) {
    if (this.subscriptors.has(socket)) throw Error('Already subscribed')

    socket.data.agent = agent
    this.subscriptors.add(socket)

    this.emit('subscription', socket.remoteAddress, agent)
  }

  authorize (socket: Socket<Miner>, identity: string) {
    const [ address, name ] = identity.split('.')
    if (!Address.validate(address)) throw Error('Invalid address') // TODO: network check
  
    const workers = this.miners.get(address)

    if (workers) {
      if (!workers.has(socket)) workers.add(socket)
    } else {
      const workers = this.miners.set(address, new Set<Socket<Miner>>()).get(address)!
      workers.add(socket)
    }

    socket.data.workers.add([ address, name ])

    this.deriveNonce(socket)
    this.updateDifficulty(socket)
  }

  private deriveNonce (socket: Socket<Miner>) {
    const event: Event<'set_extranonce'> = {
      method: 'set_extranonce',
      params: [ randomBytes(4).toString('hex') ]
    }

    socket.write(JSON.stringify(event) + '\n')
  }

  private updateDifficulty (socket: Socket<Miner>) {
    const event: Event<'mining.set_difficulty'> = {
      method: 'mining.set_difficulty',
      params: [ socket.data.difficulty.toNumber() ]
    }

    socket.write(JSON.stringify(event) + '\n')
  }

  async submit (socket: Socket<Miner>, identity: string, id: string, work: string) {
    const [ address ] = identity.split('.') // TBD: possibly store share count on worker data over socket by name
    const hash = this.templates.getHash(id)!
    const state = this.templates.getPoW(hash)
    if (!state) throw new StratumError('job-not-found')

    const nonce = BigInt('0x' + work)
    if (this.contributions.has(nonce)) throw new StratumError('duplicate-share')

    const [ isBlock, target ] = state.checkWork(nonce)
    if (target > calculateTarget(socket.data.difficulty.toNumber())) throw new StratumError('low-difficulty-share')

    if (isBlock) {
      const block = await this.templates.submit(hash, nonce)
  
      this.emit('block', block, { address, difficulty: socket.data.difficulty })
    } else {
      this.contributions.set(nonce, { address, difficulty: socket.data.difficulty })
    }
  }

  dump () {
    const contributions = Array.from(this.contributions.values())
    this.contributions.clear()

    return contributions
  }
}
