// Type definitions for Bun and Node.js globals
// These suppress TypeScript errors for Bun runtime which provides these at runtime

declare namespace Bun {
  interface TCPSocketListener<T = any> {
    port: number
  }
  
  interface Socket<T = any> {
    remoteAddress?: string
    remotePort?: number
    readyState: number | string
    data: T
    write(data: string | Buffer): void
    end(data?: string | Buffer): void
  }
  
  function listen(options: {
    hostname: string
    port: number
    socket: any
  }): TCPSocketListener<any>
}

declare const Bun: typeof Bun
declare const Buffer: typeof Buffer

// Node.js types available in Bun
declare module 'events' {
  export class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this
    emit(event: string, ...args: any[]): boolean
    addEventListener(event: string, listener: (...args: any[]) => void): this
    removeEventListener(event: string, listener: (...args: any[]) => void): this
  }
}

declare module 'crypto' {
  export function randomBytes(size: number): Buffer
}

declare module 'bun' {
  export interface Socket<T = any> {
    remoteAddress?: string
    remotePort?: number
    readyState: number | string
    data: T
    write(data: string | Buffer): void
    end(data?: string | Buffer): void
  }
  
  export interface TCPSocketListener<T = any> {
    port: number
  }
}

