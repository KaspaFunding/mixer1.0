export interface RequestMappings {
  'mining.subscribe': [ string?, string? ] // miner identifier (optional) & protocol (optional) - Iceriver may send empty
  'mining.authorize': [ string, string ] // address.name & passwd
  'mining.submit': [ string, string, string ] // address.name of worker & jobid & nonce 
}

export interface RequestMessage<M extends keyof ResponseMappings = keyof ResponseMappings> {
  id: number
  method: M
  params: RequestMappings[M]
}

export type Request<M extends keyof ResponseMappings = keyof ResponseMappings> = {
  [ K in M]: RequestMessage<K>
}[ M ]

export enum ErrorCodes {
  "unknown" = 20,
  "job-not-found" = 21,
  "duplicate-share" = 22,
  "low-difficulty-share" = 23,
  "unauthorized-worker" = 24,
  "not-subscribed" = 25,
}

export class StratumError extends Error {
  code: number

  constructor(code: keyof typeof ErrorCodes) {
    super(code)
    this.code = ErrorCodes[code]

    // @ts-ignore - captureStackTrace is a V8-specific feature available at runtime
    if (Error.captureStackTrace) {
      // @ts-ignore - captureStackTrace is a V8-specific feature available at runtime
      Error.captureStackTrace(this, StratumError)
    }
  }

  toDump (): [ number, string, string | null ] { // TODO: error type
    return [ 
      this.code,
      this.message,
      this.stack ?? null 
    ]
  }
}

export interface ResponseMappings {
  "mining.subscribe": [ boolean | null, string, number? ] // Standard: [true, 'EthereumStratum/1.0.0'], Bitmain: [null, extranonce, size]
  'mining.authorize': boolean // TRUE
  'mining.submit': boolean // TRUE
}

export interface Response<M extends keyof RequestMappings = keyof RequestMappings> {
  id: number | null  // Can be null for notifications/errors
  result: ResponseMappings[M] | null
  error: null | [
    number, // Error code
    string, // Human-readable explanation
    string | null // Stack trace
  ]
}

export interface EventMappings {
  'set_extranonce': [ string ] | [ string, number ] // Standard: [extranonce], Bitmain: [extranonce, size]
  'mining.set_difficulty': [ number ] // difficulty
  'mining.notify': [ string, string ] | [ string, string, bigint ] // job id + header, Bitmain: + timestamp
}

export interface Event<M extends keyof EventMappings = keyof EventMappings> {
  method: M
  params: EventMappings[M]
}

export function validateRequest (request: any): request is Request {
  return typeof request === 'object' &&
    request !== null &&
    (typeof request.id === 'number' || request.id === null) && // Some ASICs send null id
    typeof request.method === 'string' &&
    Array.isArray(request.params)
}

export function parseMessage (message: string) {
  try {
    const parsedMessage = JSON.parse(message)
    
    if (!validateRequest(parsedMessage)) {
      return undefined
    }
    
    return parsedMessage
  } catch (err) {
    return undefined
  }
}