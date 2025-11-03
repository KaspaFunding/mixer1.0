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
  // Pending notifications and job flags (for Stratum protocol ordering)
  pendingNotifications?: boolean
  pendingJob?: boolean
  // Vardiff tracking fields (only used when vardiff enabled)
  vardiff?: {
    lastShare: number  // Timestamp of last share
    lastDifficultyChange: number  // Timestamp of last change
    currentDifficulty: Decimal  // Current vardiff difficulty
    initialized: boolean  // Whether vardiff has been initialized
    shareCount: number  // Total shares submitted (for statistics)
  }
}

export default class Server extends Stratum {
  socket: TCPSocketListener<Miner>
  difficulty: string
  private readonly MAX_BUFFER_SIZE = 8192 // Increased from 512 for ASIC compatibility
  private readonly MAX_MESSAGES_PER_SECOND = 100 // Rate limiting to prevent abuse
  private vardiffConfig: any
  private vardiffMonitorInterval: any = null

  constructor (templates: Templates, treasuryAddress: string, hostName: string, port: number, difficulty: string, vardiffConfig?: any) {
    super(templates, treasuryAddress)

    this.difficulty = difficulty
    this.vardiffConfig = vardiffConfig || { enabled: false }
    
    // Start periodic monitoring for stuck miners (if vardiff enabled)
    if (this.vardiffConfig?.enabled) {
      this.startVardiffMonitoring()
    }

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
        extraNonce: (randomBytes(2) as any).toString('hex'), // 2 bytes = 4 hex chars
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
      console.log(`[${timestamp}] Raw bytes (hex): ${(data as any).toString('hex').substring(0, 200)}`)
      console.log(`[${timestamp}] First data preview: ${(data as any).toString('utf8', 0, Math.min(200, data.length))}`)
      console.log(`[${timestamp}] Full first message (first 500 chars): ${(data as any).toString('utf8', 0, Math.min(500, data.length))}`)
      
      // Check for common issues
      if (data.length === 0) {
        console.warn(`[${timestamp}] WARNING: Received empty data buffer!`)
      }
      if (!(data as any).toString('utf8').includes('{')) {
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
                
                // Send notifications and job AFTER subscribe response (correct Stratum order)
                if (message.method === 'mining.subscribe' && socket.data?.pendingNotifications) {
                  // @ts-ignore
                  if (socket.readyState === 1) {
                    try {
                      // Send set_extranonce notification (after subscribe response)
                      let extranonceEvent: Event<'set_extranonce'>
                      
                      if (socket.data.encoding === Encoding.Bitmain && socket.data.extraNonce !== '') {
                        const extranonce2Size = 8 - Math.floor(socket.data.extraNonce.length / 2)
                        const params: [string, number] = [socket.data.extraNonce, extranonce2Size]
                        extranonceEvent = { method: 'set_extranonce', params: params }
                      } else {
                        const params: [string] = [socket.data.extraNonce]
                        extranonceEvent = { method: 'set_extranonce', params: params }
                      }
                      const extranonceJson = JSON.stringify(extranonceEvent) + '\n'
                      socket.write(extranonceJson)
                      console.log(`[${new Date().toISOString()}] Sent set_extranonce: ${extranonceJson.trim()}`)
                      
                      // Initialize vardiff if enabled (before sending difficulty)
                      if (this.vardiffConfig?.enabled) {
                        socket.data.vardiff = {
                          lastShare: socket.data.connectedAt,
                          lastDifficultyChange: Date.now(),
                          currentDifficulty: new Decimal(this.difficulty), // Start with pool default
                          initialized: true,
                          shareCount: 0
                        }
                        // Use vardiff difficulty instead of fixed
                        socket.data.difficulty = socket.data.vardiff.currentDifficulty
                      }
                      
                      // Send mining.set_difficulty notification
                      const difficultyEvent: Event<'mining.set_difficulty'> = {
                        method: 'mining.set_difficulty',
                        params: [socket.data.difficulty.toNumber()]
                      }
                      const difficultyJson = JSON.stringify(difficultyEvent) + '\n'
                      socket.write(difficultyJson)
                      console.log(`[${new Date().toISOString()}] Sent mining.set_difficulty: ${difficultyJson.trim()}`)
                      
                      // Now send the job (after notifications)
                      if (socket.data?.pendingJob) {
                        console.log(`[${new Date().toISOString()}] Sending job after notifications to ${socket.remoteAddress}:${socket.remotePort}`)
                        this.sendCurrentJobToSocket(socket)
                      }
                      
                      socket.data.pendingNotifications = false
                      console.log(`[${new Date().toISOString()}] Subscribe handshake complete for ${socket.remoteAddress}:${socket.remotePort}`)
                    } catch (err) {
                      console.error(`Failed to send notifications/job after subscribe response:`, err)
                    }
                  }
                }
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
        
        // Store flags for sending notifications and job AFTER the subscribe response
        // CRITICAL: Order must be: 1) Subscribe response, 2) Notifications, 3) Job
        // Some ASICs (like KS5) are strict about message ordering
        socket.data.pendingJob = true
        socket.data.pendingNotifications = true
      } else if ((request as any).method === 'mining.authorize') {
        this.authorize(socket, (request as any).params[0])
        response.result = true
        
        // CRITICAL: Send job immediately after authorize for KS5 compatibility
        // KS5 appears to require authorize before accepting jobs
        // @ts-ignore
        if (socket.readyState === 1) {
          console.log(`[${new Date().toISOString()}] Sending job after mining.authorize for ${socket.remoteAddress}:${socket.remotePort}`)
          this.sendCurrentJobToSocket(socket)
        }
        
        // Clear pending job flag
        if (socket.data?.pendingJob) {
          socket.data.pendingJob = false
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

  // Vardiff difficulty adjustment (only called if vardiff enabled)
  private adjustDifficulty(socket: Socket<Miner>, timeSinceLastShare: number): void {
    if (!socket.data.vardiff?.initialized || !this.vardiffConfig?.enabled) {
      return
    }
    
    const vardiff = socket.data.vardiff
    const config = this.vardiffConfig
    const now = Date.now()
    
    // Don't adjust too frequently (throttle changes)
    if (now - vardiff.lastDifficultyChange < (config.changeInterval * 1000)) {
      return
    }
    
    // Need at least 2 shares to make meaningful adjustments
    if (vardiff.shareCount < 2) {
      return
    }
    
    const timeSinceLastShareSeconds = timeSinceLastShare / 1000
    const targetTime = config.targetTime
    const variance = (config.variancePercent / 100) * targetTime
    const minTarget = targetTime - variance
    const maxTarget = targetTime + variance
    
    // CRITICAL SAFEGUARD: If no shares for too long, aggressively reduce difficulty
    // Prevents ASICs from being locked out by too-high difficulty
    const NO_SHARE_TIMEOUT_SECONDS = 3 * 60 // 3 minutes without shares
    const CRITICAL_TIMEOUT_SECONDS = 5 * 60 // 5 minutes = emergency reset
    const EMERGENCY_RESET_DIFFICULTY_MULTIPLIER = 0.5 // Drop to 50% if no shares for 5+ min
    
    if (timeSinceLastShareSeconds >= CRITICAL_TIMEOUT_SECONDS) {
      // Emergency: No shares for 5+ minutes - reset difficulty to prevent ASIC lockout
      const emergencyDiff = vardiff.currentDifficulty.mul(EMERGENCY_RESET_DIFFICULTY_MULTIPLIER)
      const minDiff = new Decimal(config.minDifficulty)
      const newDifficulty = emergencyDiff.gt(minDiff) ? emergencyDiff : minDiff
      
      const oldDiff = vardiff.currentDifficulty.toNumber()
      vardiff.currentDifficulty = newDifficulty
      vardiff.lastDifficultyChange = now
      socket.data.difficulty = newDifficulty
      
      this.sendDifficultyUpdate(socket)
      console.log(`[Vardiff] EMERGENCY RESET: No shares for ${(timeSinceLastShareSeconds / 60).toFixed(1)}min - reduced difficulty for ${socket.remoteAddress}: ${oldDiff.toFixed(0)} -> ${newDifficulty.toNumber().toFixed(0)} to prevent ASIC lockout`)
      return
    }
    
    let newDifficulty = new Decimal(vardiff.currentDifficulty)
    let shouldChange = false
    
    // Adjust based on share frequency (reference code pattern)
    if (timeSinceLastShareSeconds < minTarget) {
      // Miner submitting too fast - increase difficulty
      const ratio = targetTime / timeSinceLastShareSeconds
      
      // SAFEGUARD: Cap difficulty increases more aggressively if already high
      // If difficulty is already >50% of max, limit increases to prevent overshooting
      const maxDiff = new Decimal(config.maxDifficulty)
      const currentPercentOfMax = vardiff.currentDifficulty.div(maxDiff).toNumber()
      let effectiveMaxChange = config.maxChange
      
      if (currentPercentOfMax > 0.5) {
        // If difficulty is already above 50% of max, reduce max increase rate
        effectiveMaxChange = 1.5 // Cap at 1.5x instead of 2.0x
        console.log(`[Vardiff] Difficulty is high (${(currentPercentOfMax * 100).toFixed(1)}% of max), capping increase to ${effectiveMaxChange}x`)
      }
      
      const changeMultiplier = Math.min(ratio, effectiveMaxChange)
      newDifficulty = vardiff.currentDifficulty.mul(changeMultiplier)
      shouldChange = true
    } else if (timeSinceLastShareSeconds > maxTarget) {
      // Miner submitting too slow - decrease difficulty
      
      // SAFEGUARD: If no shares for significant time (>3 min), reduce more aggressively
      let changeMultiplier = 1.0
      if (timeSinceLastShareSeconds >= NO_SHARE_TIMEOUT_SECONDS) {
        // No shares for 3+ minutes - reduce by larger amount to prevent ASIC lockout
        const timeoutRatio = timeSinceLastShareSeconds / NO_SHARE_TIMEOUT_SECONDS
        const aggressiveReduction = Math.min(0.7, 1 / timeoutRatio) // Reduce to at most 70% of current
        changeMultiplier = aggressiveReduction
        console.log(`[Vardiff] No shares for ${(timeSinceLastShareSeconds / 60).toFixed(1)}min - aggressive reduction for ${socket.remoteAddress}`)
      } else {
        // Use smooth scaling like reference code (prevents sudden drops)
        const MAX_ELAPSED_MS = 5 * 60 * 1000 // 5 minutes cap
        const cappedTime = Math.min(timeSinceLastShare, MAX_ELAPSED_MS)
        const timeWeight = cappedTime / MAX_ELAPSED_MS // 0 to 1
        
        // Scale down based on time weight (smooth ramp-down)
        const scaledRatio = timeSinceLastShareSeconds / targetTime
        changeMultiplier = Math.max(1 / scaledRatio, 1 / config.maxChange) * timeWeight
      }
      
      newDifficulty = vardiff.currentDifficulty.mul(changeMultiplier)
      shouldChange = true
    }
    
    // Clamp to min/max difficulty
    const minDiff = new Decimal(config.minDifficulty)
    const maxDiff = new Decimal(config.maxDifficulty)
    if (newDifficulty.lt(minDiff)) newDifficulty = minDiff
    if (newDifficulty.gt(maxDiff)) newDifficulty = maxDiff
    
    // SAFEGUARD: Never exceed 90% of maxDifficulty to leave room for increases
    // This prevents difficulty from hitting the absolute maximum and becoming stuck
    const safeMaxDiff = maxDiff.mul(0.9)
    if (newDifficulty.gt(safeMaxDiff)) {
      newDifficulty = safeMaxDiff
      console.log(`[Vardiff] Capped difficulty at 90% of max (${safeMaxDiff.toNumber().toFixed(0)}) to prevent ASIC lockout`)
    }
    
    // Only change if difference is significant (avoid tiny adjustments)
    const diffPercent = newDifficulty.div(vardiff.currentDifficulty).minus(1).abs().mul(100)
    if (shouldChange && diffPercent.gte(5)) { // At least 5% change
      const oldDiff = vardiff.currentDifficulty.toNumber()
      vardiff.currentDifficulty = newDifficulty
      vardiff.lastDifficultyChange = now
      socket.data.difficulty = newDifficulty // Update socket difficulty
      
      // Send new difficulty to miner
      this.sendDifficultyUpdate(socket)
      
      console.log(`[Vardiff] Adjusted difficulty for ${socket.remoteAddress}: ${oldDiff.toFixed(0)} -> ${newDifficulty.toNumber().toFixed(0)} (interval: ${timeSinceLastShareSeconds.toFixed(1)}s, target: ${targetTime}s)`)
    }
  }

  // Periodic monitoring to detect miners stuck due to high difficulty
  // Checks every minute for miners who haven't submitted shares
  // CRITICAL: This catches cases where difficulty is too high and ASIC can't submit shares
  private startVardiffMonitoring(): void {
    if (this.vardiffMonitorInterval) {
      return // Already monitoring
    }
    
    // Check every 60 seconds for miners without recent shares
    // @ts-ignore - setInterval available at runtime
    this.vardiffMonitorInterval = setInterval(() => {
      if (!this.vardiffConfig?.enabled) return
      
      const now = Date.now()
      const STUCK_MINER_TIMEOUT_MS = 3 * 60 * 1000 // 3 minutes
      const CRITICAL_STUCK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
      
      // Check all subscribed miners via subscriptors (from base Stratum class)
      try {
        // @ts-ignore - subscriptors available from base class
        const activeSockets = Array.from(this.subscriptors || [])
        let stuckMinersFound = 0
        let emergencyResets = 0
        
        for (const socket of activeSockets) {
          if (!socket.data?.vardiff?.initialized) continue
          
          const timeSinceLastShare = now - (socket.data.vardiff.lastShare || socket.data.connectedAt)
          const timeSinceLastShareSeconds = timeSinceLastShare / 1000
          
          // If no shares for critical timeout, force emergency reset
          // This is CRITICAL - if difficulty is too high, ASIC can't submit shares
          // So we must proactively check and reduce difficulty
          if (timeSinceLastShare >= CRITICAL_STUCK_TIMEOUT_MS) {
            console.log(`[Vardiff Monitor] CRITICAL: Stuck miner detected ${socket.remoteAddress} (no shares for ${(timeSinceLastShareSeconds / 60).toFixed(1)}min) - forcing emergency difficulty reset`)
            // Force an adjustment check (pass large timeSinceLastShare to trigger emergency reset)
            this.adjustDifficulty(socket, timeSinceLastShare)
            emergencyResets++
            stuckMinersFound++
          } else if (timeSinceLastShare >= STUCK_MINER_TIMEOUT_MS) {
            // If no shares for 3+ minutes but less than 5, still trigger adjustment
            // This ensures we proactively reduce difficulty before ASIC gets completely stuck
            console.log(`[Vardiff Monitor] Stuck miner detected ${socket.remoteAddress} (no shares for ${(timeSinceLastShareSeconds / 60).toFixed(1)}min) - reducing difficulty`)
            this.adjustDifficulty(socket, timeSinceLastShare)
            stuckMinersFound++
          }
        }
        
        if (stuckMinersFound > 0 || emergencyResets > 0) {
          console.log(`[Vardiff Monitor] Found ${stuckMinersFound} stuck miner(s), ${emergencyResets} emergency reset(s)`)
        }
      } catch (err) {
        console.error('[Vardiff Monitor] Error in monitoring:', err)
      }
    }, 60000) // Check every 60 seconds
    
    console.log('[Vardiff] Started periodic monitoring for stuck miners (checks every 60s)')
  }

  private sendDifficultyUpdate(socket: Socket<Miner>): void {
    // @ts-ignore
    if (socket.readyState !== 1) return
    
    try {
      const event: Event<'mining.set_difficulty'> = {
        method: 'mining.set_difficulty',
        params: [socket.data.difficulty.toNumber()]
      }
      socket.write(JSON.stringify(event) + '\n')
      console.log(`[Vardiff] Sent difficulty update: ${socket.data.difficulty.toNumber().toFixed(0)} to ${socket.remoteAddress}`)
    } catch (err) {
      console.error(`[Vardiff] Failed to send difficulty update to ${socket.remoteAddress}:`, err)
    }
  }
}
