// @ts-ignore - Bun types available at runtime
import type { Socket } from 'bun'
// @ts-ignore - events module available at runtime
import { EventEmitter } from 'events' 
// @ts-ignore - crypto module available at runtime
import { randomBytes } from 'crypto'
import { type Miner, Encoding } from './index.ts'
import { StratumError, type Event } from './protocol.ts'
import type Templates from '../templates/index.ts'
import { calculateTarget, Address } from "../../wasm/kaspa"
import { Decimal } from 'decimal.js'

export type Contribution = { address: string, difficulty: Decimal }

// @ts-ignore - EventEmitter is available at runtime in Bun
export default class Stratum extends EventEmitter {
  private templates: Templates
  private contributions: Map<bigint, Contribution> = new Map() // TODO: Apply PPLNS maybe?
  subscriptors: Set<Socket<Miner>> = new Set()
  miners: Map<string, Set<Socket<Miner>>> = new Map()

  constructor (templates: Templates) {
    super()

    this.templates = templates
    this.templates.register((id, hash, timestamp, header) => this.announce(id, hash, timestamp, header))
  }

  private announce (id: string, hash: string, timestamp: bigint, header: any) {
    // Create job for standard BigHeader encoding (most miners)
    // @ts-ignore - Buffer is available at runtime in Bun
    const timestampLE = Buffer.alloc(8)
    timestampLE.writeBigUInt64LE(timestamp)
    
    const standardTask: Event<'mining.notify'> = {
      method: 'mining.notify',
      params: [ id, hash + timestampLE.toString('hex') ]
    }
    
    const standardJob = JSON.stringify(standardTask) + '\n'

    this.subscriptors.forEach((socket) => {
      // Check socket state - Bun uses number (1 = open), but be defensive
      // @ts-ignore
      const isOpen = socket.readyState === 1 || socket.readyState === 'open'
      
      if (!isOpen) {
        // Socket is closed, clean up
        for (const [ address ] of (socket.data?.workers || [])) {
          const miners = this.miners.get(address)
          if (miners) {
            miners.delete(socket)
            if (miners.size === 0) {
              this.miners.delete(address)
            }
          }
        }
        this.subscriptors.delete(socket)
        return
      }

      try {
        // Send appropriate job format based on encoding type
        if (socket.data.encoding === Encoding.Bitmain) {
          // Bitmain format uses serialized header as bigint array
          // For now, send standard format as fallback (proper Bitmain encoding requires blake2b library)
          // TODO: Implement full Bitmain encoding if needed
          socket.write(standardJob)
        } else {
          // Standard EthereumStratum format (BigHeader)
          socket.write(standardJob)
        }
      } catch (err) {
        console.error(`Failed to send job to ${socket.remoteAddress || 'unknown'}:`, err)
        // Clean up on write error
        for (const [ address ] of (socket.data?.workers || [])) {
          const miners = this.miners.get(address)
          if (miners) {
            miners.delete(socket)
            if (miners.size === 0) {
              this.miners.delete(address)
            }
          }
        }
        this.subscriptors.delete(socket)
      }
    })
  }

  subscribe (socket: Socket<Miner>, agent: string) {
    if (this.subscriptors.has(socket)) {
      throw Error('Already subscribed')
    }

    socket.data.agent = agent || "Unknown"
    this.subscriptors.add(socket)

    // @ts-ignore - EventEmitter emit is available at runtime
    this.emit('subscription', socket.remoteAddress || 'unknown', agent || "Unknown")
  }

  authorize (socket: Socket<Miner>, identity: string) {
    // Parse like reference: split on first dot only
    const dotIndex = identity.indexOf('.')
    if (dotIndex <= 0) {
      throw Error(`Worker name is not set. Request: ${identity}`)
    }
    
    const address = identity.substring(0, dotIndex)
    const name = identity.substring(dotIndex + 1)
    
    // Reference validates address directly without requiring kaspa: prefix
    // Address.validate should handle it internally
    let addressToValidate = address
    // Remove kaspa: prefix if present, validate, then store without prefix
    const addressClean = address.replace(/^(kaspa:?|kaspatest:?)/i, '')
    
    // Try validation with and without prefix (reference is more lenient)
    if (!Address.validate(`kaspa:${addressClean}`) && !Address.validate(address)) {
      throw Error(`Invalid address, parsed address: ${addressClean}, request: ${identity}`)
    }
    
    if (!name || name.trim().length === 0) {
      throw Error(`Worker name is not set. Request: ${identity}`)
    }
    
    // Store address without prefix internally (consistent with reference)
    const addressForStorage = addressClean
    
    const workers = this.miners.get(addressForStorage)

    if (workers) {
      if (!workers.has(socket)) workers.add(socket)
    } else {
      const workers = this.miners.set(addressForStorage, new Set<Socket<Miner>>()).get(addressForStorage)!
      workers.add(socket)
    }

    socket.data.workers.add([ addressForStorage, name ])

    // NOTE: deriveNonce and updateDifficulty are already sent during subscribe
    // Don't send them again here - ASICs expect them only after subscribe, not after authorize
    // Only call these if they weren't sent during subscribe (shouldn't happen, but defensive)
    // this.deriveNonce(socket)
    // this.updateDifficulty(socket)
  }

  private deriveNonce (socket: Socket<Miner>) {
    // @ts-ignore
    if (socket.readyState !== 1) return
    
    try {
      // Reference approach: always send extranonce, format based on encoding
      // TypeScript-friendly approach: create event with proper union type matching
      let event: Event<'set_extranonce'>
      
      if (socket.data.encoding === Encoding.Bitmain && socket.data.extraNonce !== '') {
        const extranonce2Size = 8 - Math.floor(socket.data.extraNonce.length / 2)
        // Create params tuple that matches the union type [string, number]
        const params: [string, number] = [socket.data.extraNonce, extranonce2Size]
        event = {
          method: 'set_extranonce',
          params: params
        }
      } else {
        // Create params tuple that matches the union type [string]
        const params: [string] = [socket.data.extraNonce]
        event = {
          method: 'set_extranonce',
          params: params
        }
      }

      socket.write(JSON.stringify(event) + '\n')
    } catch (err) {
      console.error(`Failed to send extranonce to ${socket.remoteAddress || 'unknown'}:`, err)
    }
  }

  private updateDifficulty (socket: Socket<Miner>) {
    // @ts-ignore
    if (socket.readyState !== 1) return
    
    try {
      const event: Event<'mining.set_difficulty'> = {
        method: 'mining.set_difficulty',
        params: [ socket.data.difficulty.toNumber() ]
      }

      socket.write(JSON.stringify(event) + '\n')
    } catch (err) {
      console.error(`Failed to send difficulty to ${socket.remoteAddress}:`, err)
    }
  }

  async submit (socket: Socket<Miner>, identity: string, id: string, work: string) {
    // Parse like reference: split on first dot
    const dotIndex = identity.indexOf('.')
    if (dotIndex <= 0) {
      throw new StratumError('unauthorized-worker')
    }
    
    const addressRaw = identity.substring(0, dotIndex)
    const name = identity.substring(dotIndex + 1)
    const address = addressRaw.replace(/^(kaspa:?|kaspatest:?)/i, '') // Remove prefix for lookup
    
    // Validate worker exists and matches (like reference)
    let workerFound = false
    for (const [addr, workerName] of socket.data.workers) {
      if (addr === address && workerName === name) {
        workerFound = true
        break
      }
    }
    
    if (!workerFound) {
      throw Error(`Mismatching worker details - Address: ${address}, Worker Name: ${name}`)
    }
    
    const hash = this.templates.getHash(id)
    if (!hash) {
      throw new StratumError('job-not-found')
    }
    
    const state = this.templates.getPoW(hash)
    if (!state) {
      throw new StratumError('job-not-found')
    }

    // Handle extranonce2 padding like reference (before parsing nonce)
    let workToParse = work
    if (socket.data.extraNonce && socket.data.extraNonce !== '') {
      const extranonce2Len = 16 - socket.data.extraNonce.length
      if (work.length <= extranonce2Len) {
        workToParse = socket.data.extraNonce + work.padStart(extranonce2Len, '0')
      }
    }

    // Parse nonce based on encoding (reference approach)
    let nonce: bigint
    try {
      if (socket.data.encoding === Encoding.Bitmain) {
        // Bitmain sends nonce as decimal string
        nonce = BigInt(work)
      } else {
        // Standard format: hex string
        nonce = BigInt('0x' + workToParse.replace(/^0x/i, ''))
      }
    } catch (err) {
      throw new StratumError('unknown')
    }

    if (this.contributions.has(nonce)) {
      throw new StratumError('duplicate-share')
    }

    const [ isBlock, target ] = state.checkWork(nonce)
    if (target > calculateTarget(socket.data.difficulty.toNumber())) {
      throw new StratumError('low-difficulty-share')
    }

    if (isBlock) {
      const block = await this.templates.submit(hash, nonce)
      // @ts-ignore - EventEmitter emit is available at runtime
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
