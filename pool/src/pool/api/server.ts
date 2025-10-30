import type { Server as HttpServer } from 'bun'

export type Mappings = Record<string, (params: Record<string, any>) => any>

export default class Server {
  server: HttpServer
  private mappings: Mappings

  constructor (mappings: Mappings, port: number) {
    this.mappings = mappings
    this.server = Bun.serve({
      port,
      fetch: this.serve.bind(this),
    })
  }

  private async serve(request: Request) {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method
    const route = this.mappings[path]
    
    if (!route) {
      return new Response('Not Found', { status: 404 })
    }

    if (method === 'GET') {
      try {
        const params = Object.fromEntries(url.searchParams)
        const result = await route(params)

        return Response.json(result)
      } catch (err) {
        if (err instanceof Error) {
          return new Response(`Error: ${err.message}`, { status: 400 })
        } else if (typeof err === 'string') {
          return new Response(`Error: ${err}`, { status: 400 })
        } else throw err
      }
    } else if (method === 'OPTIONS') {
      return new Response(null, { status: 204 })
    }
    
    return new Response(`${method} method not allowed`, { status: 405 })
  }
}
