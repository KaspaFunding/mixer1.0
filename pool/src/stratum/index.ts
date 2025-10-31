// @ts-ignore - Bun types available at runtime
import type { Socket, TCPSocketListener } from 'bun'
import { parseMessage, type Request, type Response, type ResponseMappings, type Event, StratumError } from './protocol'
import { Decimal } from 'decimal.js'
import Stratum from './stratum'
import type Templates from '../templates'
// @ts-ignore - crypto module available at runtime
import { randomBytes } from 'crypto'

// Encoding types for different ASIC miners
export enum Encoding {
  BigHeader,  // Standard EthereumStratum format
  Bitmain     // Bitmain/GodMiner format
}

// Miner type detection regex
const minerRegexes = {
  bitMain: /.*(GodMiner|Bitmain|Antminer).*/i,
}

export type Miner = {
  agent: string // Only used within API.
  difficulty: Decimal
  workers: Set<[ string, string ]>
  cachedBytes: string
  connectedAt: number
  messageCount: number
  extraNonce: string  // Extranonce for this miner connection
  encoding: Encoding   // Encoding type (BigHeader or Bitmain)
  asicType: string    // ASIC type string from miner
  // Optional runtime fields for connection management
  subscribed?: boolean
  idleTimer?: any
  closeReason?: string
  // Connection info stored for cleanup when socket is closed
  remoteAddress?: string
  remotePort?: string | number
}

export default class Server extends Stratum {
  socket: TCPSocketListener<Miner>
  difficulty: string
  private readonly MAX_BUFFER_SIZE = 8192 // Increased from 512 for ASIC compatibility
  private readonly MAX_MESSAGES_PER_SECOND = 100 // Rate limiting to prevent abuse

  constructor (templates: Templates, hostName: string, port: number, difficulty: string) {
    super(templates)

    this.difficulty = difficulty

    try {
      console.log(`Attempting to start Bun.listen on ${hostName}:${port}`)
      
      // @ts-ignore - Bun global available at runtime
      this.socket = Bun.listen({
        hostname: hostName,
        port: port,
        socket: {
          open: (socket) => {
            const timestamp = new Date().toISOString()
            const remoteAddr = socket?.remoteAddress || 'unknown'
            const remotePort = socket?.remotePort || 'unknown'
            const clientId = `${remoteAddr}:${remotePort}`
            console.log(`[${timestamp}] ========================================`)
            console.log(`[${timestamp}] *** SOCKET OPEN EVENT ***`)
            console.log(`[${timestamp}] Client: ${clientId}`)
            console.log(`[${timestamp}] Remote Address: ${remoteAddr}`)
            console.log(`[${timestamp}] Remote Port: ${remotePort}`)
            console.log(`[${timestamp}] Socket readyState: ${(socket as any)?.readyState || 'unknown'}`)
            
            // Check if this is from the ASIC
            if (remoteAddr === '192.168.1.165') {
              console.log(`[${timestamp}] *** THIS IS THE ASIC CONNECTION! ***`)
            }
            
            console.log(`[${timestamp}] Waiting for data from ${clientId}...`)
            try {
              this.onConnect(socket)
            } catch (err) {
              console.error(`[${timestamp}] ERROR in open handler:`, err)
            }
          },
          data: this.onData.bind(this),
          close: (socket) => {
            const timestamp = new Date().toISOString()
            const clientId = `${socket?.remoteAddress || 'unknown'}:${socket?.remotePort || 'unknown'}`
            console.log(`[${timestamp}] Socket CLOSE event fired for ${clientId}`)
            try {
              this.onClose(socket)
            } catch (err) {
              console.error(`[${timestamp}] ERROR in close handler:`, err)
            }
          },
          error: (socket, error) => {
            const timestamp = new Date().toISOString()
            const clientId = `${socket?.remoteAddress || 'unknown'}:${socket?.remotePort || 'unknown'}`
            console.error(`[${timestamp}] Socket ERROR event fired for ${clientId} - ${error.message}`)
            try {
              this.onError(socket, error)
            } catch (err) {
              console.error(`[${timestamp}] ERROR in error handler:`, err)
            }
          },
          drain: (socket) => {
            const timestamp = new Date().toISOString()
            const clientId = `${socket?.remoteAddress || 'unknown'}:${socket?.remotePort || 'unknown'}`
            console.log(`[${timestamp}] Socket DRAIN event fired for ${clientId}`)
          }
        }
      })
      
      console.log(`Stratum server listening on ${hostName}:${port}`)
      console.log(`Server socket state: ${this.socket ? 'created' : 'failed'}`)
      if (this.socket) {
        console.log(`Server port: ${this.socket.port}`)
        console.log(`Ready to accept connections from any IP address`)
      }
    } catch (error) {
      console.error(`Failed to start stratum server on ${hostName}:${port}:`, error)
      throw error
    }
  }

  private onConnect (socket: Socket<Miner>) {
    const clientId = `${socket.remoteAddress || 'unknown'}:${socket.remotePort || 'unknown'}`
    const timestamp = new Date().toISOString()
    
    console.log(`[${timestamp}] ========================================`)
    console.log(`[${timestamp}] NEW CONNECTION: ${clientId}`)
    console.log(`[${timestamp}] Socket readyState: ${socket.readyState}`)
    console.log(`[${timestamp}] Remote address: ${socket.remoteAddress || 'unknown'}`)
    console.log(`[${timestamp}] Remote port: ${socket.remotePort || 'unknown'}`)
    
    try {
      // Store remote address/port for use in close handler (Bun may clear them on close)
      const remoteAddr = socket.remoteAddress || 'unknown'
      const remotePort = socket.remotePort || 'unknown'
      
      socket.data = {
        agent: "Unknown",
        difficulty: new Decimal(this.difficulty),
        workers: new Set(),
        cachedBytes: "",
        connectedAt: Date.now(),
        messageCount: 0,
        extraNonce: randomBytes(2).toString('hex'), // 2 bytes = 4 hex chars
        encoding: Encoding.BigHeader, // Default to standard encoding
        asicType: "",
        subscribed: false,
        remoteAddress: remoteAddr,
        remotePort: remotePort
      }
      
      console.log(`[${timestamp}] Socket data initialized, extranonce: ${socket.data.extraNonce}`)
      
      // Idle timeout: disconnect clients that do not subscribe within 30s
      try {
        // @ts-ignore - setTimeout available at runtime
        socket.data.idleTimer = setTimeout(() => {
          if (!socket.data?.subscribed) {
            socket.data.closeReason = 'idle-timeout-no-subscribe'
            try { socket.end() } catch (_) {}
          }
        }, 30_000)
      } catch (_) {}
      
      // @ts-ignore - EventEmitter emit is available at runtime
      this.emit('connection', socket.remoteAddress)
      
      console.log(`[${timestamp}] Connection handler completed successfully`)
      console.log(`[${timestamp}] ========================================`)
    } catch (err) {
      console.error(`[${timestamp}] ERROR in onConnect:`, err)
      throw err
    }
  }

  // @ts-ignore - Buffer type available at runtime
  private async onData (socket: Socket<Miner>, data: Buffer) {
    const timestamp = new Date().toISOString()
    
    // Check socket is still open
    // @ts-ignore
    if (socket.readyState !== 1) {
      console.log(`[${timestamp}] onData called but socket readyState is ${socket.readyState} for ${socket.remoteAddress}:${socket.remotePort}`)
      return
    }

    // Log first data received for debugging
    if (socket.data.messageCount === 0) {
      console.log(`[${timestamp}] ========================================`)
      console.log(`[${timestamp}] First data received from ${socket.remoteAddress}:${socket.remotePort} (${data.length} bytes)`)
      console.log(`[${timestamp}] Raw bytes (hex): ${data.toString('hex').substring(0, 200)}`)
      console.log(`[${timestamp}] First data preview: ${data.toString('utf8', 0, Math.min(200, data.length))}`)
      console.log(`[${timestamp}] Full first message (first 500 chars): ${data.toString('utf8', 0, Math.min(500, data.length))}`)
      
      // Check for common issues
      if (data.length === 0) {
        console.warn(`[${timestamp}] WARNING: Received empty data buffer!`)
      }
      if (!data.toString('utf8').includes('{')) {
        console.warn(`[${timestamp}] WARNING: First data doesn't contain JSON! May be binary or non-Stratum protocol.`)
      }
    }

    // Rate limiting check (relaxed - only check if excessive)
    socket.data.messageCount++
    const elapsed = Date.now() - socket.data.connectedAt
    if (elapsed > 1000 && socket.data.messageCount / (elapsed / 1000) > this.MAX_MESSAGES_PER_SECOND * 10) {
      console.warn(`Rate limit exceeded for ${socket.remoteAddress}:${socket.remotePort} (${socket.data.messageCount} messages in ${elapsed}ms)`)
      socket.end()
      return
    }

    try {
      // Convert Buffer to string explicitly for proper concatenation
      // @ts-ignore - Buffer.toString is available at runtime
      const dataString = data.toString('utf8')
      socket.data.cachedBytes += dataString
      const messages = socket.data.cachedBytes.split('\n')

      // Keep last incomplete message in buffer
      // CRITICAL: Process messages SEQUENTIALLY (await) so subscribe completes before authorize
      // ASICs like Iceriver send both in one packet and expect immediate responses
      while (messages.length > 1) {
        const messageStr = messages.shift()?.trim()
        
        // Skip empty messages (some ASICs send empty lines)
        if (!messageStr || messageStr.length === 0) {
          continue
        }

        const message = parseMessage(messageStr)

        if (message) {
          console.log(`Received ${message.method} from ${socket.remoteAddress}:${socket.remotePort}`)
          
          // Process messages sequentially to ensure subscribe completes before authorize
          try {
            const response = await this.onMessage(socket, message)
            
            // Log the response we're about to send (especially for subscribe)
            if (message.method === 'mining.subscribe') {
              console.log(`[${new Date().toISOString()}] Sending subscribe response: ${JSON.stringify(response)}`)
            }
            
            // Check socket is still open before writing
            // @ts-ignore
            if (socket.readyState === 1) {
              try {
                const responseJson = JSON.stringify(response) + '\n'
                socket.write(responseJson)
                console.log(`[${new Date().toISOString()}] Response sent to ${socket.remoteAddress}:${socket.remotePort} for ${message.method}`)
              } catch (writeError) {
                console.error(`Failed to write to ${socket.remoteAddress}:${socket.remotePort}:`, writeError)
                socket.end()
                break
              }
            } else {
              console.warn(`[${new Date().toISOString()}] Socket not ready for ${message.method}, readyState: ${(socket as any)?.readyState}`)
            }
          } catch (error) {
            let response: Response = {
              id: message.id || null,
              result: null,
              error: new StratumError("unknown").toDump()
            }

            if (error instanceof StratumError) {
              response.error = error.toDump()
            } else if (error instanceof Error) {
              response.error = [20, error.message, null]
            }

            // Check socket is still open before writing error response
            // @ts-ignore
            if (socket.readyState === 1) {
              try {
                socket.write(JSON.stringify(response) + '\n')
              } catch (writeError) {
                console.error(`Failed to write error response to ${socket.remoteAddress}:${socket.remotePort}:`, writeError)
                socket.end()
                break
              }
            }
          }
        } else {
          // Malformed message - log but don't disconnect immediately
          // Iceriver and other ASICs may send empty lines or non-JSON messages as keepalive
          if (messageStr.trim().length > 0) {
            console.warn(`Malformed message from ${socket.remoteAddress}:${socket.remotePort}: ${messageStr.substring(0, 100)}`)
          }
          // Only disconnect if we've seen many malformed messages
          if (socket.data.messageCount > 10 && socket.data.messageCount % 10 === 0) {
            console.warn(`Too many malformed messages from ${socket.remoteAddress}:${socket.remotePort}, disconnecting`)
            socket.end()
            return
          }
        }
      }

      // Store remaining incomplete message
      socket.data.cachedBytes = messages[0] || ""

      // Check buffer size limit
      if (socket.data.cachedBytes.length > this.MAX_BUFFER_SIZE) {
        console.warn(`Buffer overflow for ${socket.remoteAddress}:${socket.remotePort} (${socket.data.cachedBytes.length} bytes)`)
        socket.end()
      }
    } catch (err) {
      console.error(`Error processing data from ${socket.remoteAddress}:${socket.remotePort}:`, err)
      socket.end()
    }
  }

  private onClose (socket: Socket<Miner>) {
    // Capture remote info before socket might be closed (remotePort may be unavailable after close)
    const remoteAddr = socket.remoteAddress || socket.data?.remoteAddress || 'unknown'
    const remotePort = socket.remotePort || socket.data?.remotePort || 'unknown'
    const clientId = `${remoteAddr}:${remotePort}`
    const timestamp = new Date().toISOString()
    const connectedDuration = socket.data?.connectedAt ? Date.now() - socket.data.connectedAt : 0
    const closeReason = socket.data?.closeReason || 'normal'
    
    console.log(`[${timestamp}] Miner disconnected: ${clientId}`)
    console.log(`[${timestamp}] Connection duration: ${connectedDuration}ms`)
    console.log(`[${timestamp}] Close reason: ${closeReason}`)
    console.log(`[${timestamp}] Messages processed: ${socket.data?.messageCount || 0}`)
    
    // Clean up timers
    try { if (socket.data?.idleTimer) { clearTimeout(socket.data.idleTimer) } } catch (_) {}
    
    // Clean up from subscriptions and miners map
    this.subscriptors.delete(socket)
    for (const [ address ] of (socket.data?.workers || [])) {
      const miners = this.miners.get(address)
      if (miners) {
        miners.delete(socket)
        if (miners.size === 0) {
          this.miners.delete(address)
        }
      }
    }
  }

  private onError (socket: Socket<Miner>, error: Error) {
    const clientId = `${socket.remoteAddress || 'unknown'}:${socket.remotePort || 'unknown'}`
    console.error(`Socket error for ${clientId}:`, error.message)
    
    // Clean up on error
    this.onClose(socket)
  }

  private async onMessage (socket: Socket<Miner>, request: Request<keyof ResponseMappings> ) {
    let response: Response = {
      id: request.id,
      result: true,
      error: null
    }

    try {
      if (request.method === 'mining.submit') {
        await this.submit(socket, request.params[0], request.params[1], request.params[2])
      } else if (request.method === 'mining.authorize') {
        this.authorize(socket, request.params[0])
        response.result = true
      } else if (request.method === 'mining.subscribe') {
        // Handle user agent - Iceriver sends ["IceRiverMiner-v1.1", "EthereumStratum/1.0.0"]
        // First param is the agent, second is the protocol (can be ignored)
        const agent = request.params?.[0] || "Unknown"
        const protocol = request.params?.[1] // Usually "EthereumStratum/1.0.0" - can be used for validation
        
        this.subscribe(socket, agent)
        // Mark as subscribed and clear idle timeout
        socket.data.subscribed = true
        try { if (socket.data.idleTimer) { clearTimeout(socket.data.idleTimer) } } catch (_) {}
        
        // Detect miner type and set encoding
        const minerType = (agent || "").toLowerCase()
        
        // Log what we received for debugging
        console.log(`Subscribe from ${socket.remoteAddress}:${socket.remotePort}, agent: "${agent}", protocol: "${protocol || 'none'}"`)
        
        if (minerRegexes.bitMain.test(minerType)) {
          socket.data.encoding = Encoding.Bitmain
          socket.data.asicType = agent
          // Bitmain format: [null, extranonce, extranonce2_size]
          const extranonce2Size = 8 - Math.floor(socket.data.extraNonce.length / 2)
          response.result = [ null, socket.data.extraNonce, extranonce2Size ]
          console.log(`Bitmain/GodMiner detected: ${agent}, extranonce: ${socket.data.extraNonce}, size: ${extranonce2Size}`)
        } else {
          // Standard EthereumStratum format (for Iceriver, Goldshell, etc.)
          response.result = [ true, 'EthereumStratum/1.0.0' ]
          socket.data.asicType = agent
          if (agent && (agent.toLowerCase().includes('icm') || agent.toLowerCase().includes('iceriver'))) {
            console.log(`Iceriver miner detected: ${agent} - using standard EthereumStratum format`)
          } else if (agent !== "Unknown") {
            console.log(`Standard miner detected: ${agent} - using EthereumStratum format`)
          }
        }
        
        // CRITICAL: Send set_extranonce and difficulty IMMEDIATELY after subscribe response
        // Many ASICs (including Iceriver) timeout if they don't receive these immediately
        // These MUST be sent synchronously before we return from this handler
        // @ts-ignore - socket.readyState check
        if (socket.readyState === 1) {
          try {
            // Send set_extranonce notification
            // TypeScript-friendly approach: create event with proper union type matching
            let extranonceEvent: Event<'set_extranonce'>
            
            if (socket.data.encoding === Encoding.Bitmain && socket.data.extraNonce !== '') {
              const extranonce2Size = 8 - Math.floor(socket.data.extraNonce.length / 2)
              // Create params tuple that matches the union type [string, number]
              const params: [string, number] = [socket.data.extraNonce, extranonce2Size]
              extranonceEvent = {
                method: 'set_extranonce',
                params: params
              }
            } else {
              // Create params tuple that matches the union type [string]
              const params: [string] = [socket.data.extraNonce]
              extranonceEvent = {
                method: 'set_extranonce',
                params: params
              }
            }
            const extranonceJson = JSON.stringify(extranonceEvent) + '\n'
            socket.write(extranonceJson)
            console.log(`[${new Date().toISOString()}] Sent set_extranonce: ${extranonceJson.trim()}`)
            
            // Send mining.set_difficulty notification
            const difficultyEvent: Event<'mining.set_difficulty'> = {
              method: 'mining.set_difficulty',
              params: [socket.data.difficulty.toNumber()]
            }
            const difficultyJson = JSON.stringify(difficultyEvent) + '\n'
            socket.write(difficultyJson)
            console.log(`[${new Date().toISOString()}] Sent mining.set_difficulty: ${difficultyJson.trim()}`)
            
            console.log(`[${new Date().toISOString()}] Subscribe handshake complete for ${socket.remoteAddress}:${socket.remotePort}`)
          } catch (err) {
            console.error(`Failed to send extranonce/difficulty after subscribe:`, err)
          }
        }
      } else {
        // Unknown method - return error instead of silent failure
        const methodName = (request as any).method || 'unknown'
        response.result = null
        response.error = [20, `Unknown method: ${methodName}`, null]
      }
    } catch (error) {
      // Re-throw to be handled by outer catch
      throw error
    }
    
    return response
  }
}
