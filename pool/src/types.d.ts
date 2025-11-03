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

// Node.js types available in Bun
// Note: EventEmitter is provided by @types/node, so we don't redeclare it here
// If you see errors, ensure @types/node is installed or use @ts-ignore comments where needed

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

