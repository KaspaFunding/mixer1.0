import type { Socket, TCPSocketListener } from 'bun'
import { parseMessage, type Request, type Response, type ResponseMappings, StratumError } from './protocol'
import { Decimal } from 'decimal.js'
import Stratum from './stratum'
import type Templates from '../templates'

export type Miner = {
  agent: string // Only used within API.
  difficulty: Decimal
  workers: Set<[ string, string ]>
  cachedBytes: string
}

export default class Server extends Stratum {
  socket: TCPSocketListener<Miner>
  difficulty: string

  constructor (templates: Templates, hostName: string, port: number, difficulty: string) {
    super(templates)

    this.difficulty = difficulty

    this.socket = Bun.listen({
      hostname: hostName,
      port: port,
      socket: {
        open: this.onConnect.bind(this),
        data: this.onData.bind(this)
      }
    })
  }

  private onConnect (socket: Socket<Miner>) {
    socket.data = {
      agent: "Unknown",
      difficulty: new Decimal(this.difficulty),
      workers: new Set(),
      cachedBytes: "",
    }
  }

  private onData (socket: Socket<Miner>, data: Buffer) {
    socket.data.cachedBytes += data
    const messages = socket.data.cachedBytes.split('\n')

    while (messages.length > 1) {
      const message = parseMessage(messages.shift()!)

      if (message) {
        this.onMessage(socket, message).then((response) => {
          socket.write(JSON.stringify(response) + '\n')
        }).catch((error) => {
          let response: Response = {
            id: message.id,
            result: false,
            error: new StratumError("unknown").toDump()
          }

          if (error instanceof StratumError) {
            response.error = error.toDump()
            socket.write(JSON.stringify(response) + '\n')
          } else if (error instanceof Error) {
            response.error![1] = error.message
            return socket.end(JSON.stringify(response))  
          } else throw error 
        })
      } else {
        socket.end()
      }
    }

    socket.data.cachedBytes = messages[0]

    if (socket.data.cachedBytes.length > 512) {
      socket.end()
    }
  }

  private async onMessage (socket: Socket<Miner>, request: Request<keyof ResponseMappings> ) {
    let response: Response = {
      id: request.id,
      result: true,
      error: null
    }

    if (request.method === 'mining.submit') {
      await this.submit(socket, request.params[0], request.params[1], request.params[2])
    } else if (request.method === 'mining.authorize') {
      this.authorize(socket, request.params[0])
    } else if (request.method === 'mining.subscribe') {
      this.subscribe(socket, request.params[0])
      response.result = [ true, 'EthereumStratum/1.0.0' ]
    }
    
    return response
  }
}
