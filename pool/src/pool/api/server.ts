// Bun runtime - these will be available at runtime even if TypeScript doesn't recognize them
// @ts-ignore - Bun runtime global, types not needed
declare const Bun: {
  serve(options: { port: number; fetch: (request: Request) => Promise<Response> | Response }): { port: number }
}

export type RouteHandler = (params: Record<string, any>) => any | Promise<any>
export type Route = {
  get?: RouteHandler
  post?: (body: any) => any | Promise<any>
}

export type Mappings = Record<string, RouteHandler | Route>

export default class Server {
  server: { port: number }
  private mappings: Mappings

  constructor (mappings: Mappings, port: number) {
    this.mappings = mappings
    // @ts-ignore - Bun is available at runtime
    this.server = Bun.serve({
      port,
      fetch: this.serve.bind(this),
    })
  }

  private async serve(request: Request) {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method
    
    // Try exact match first
    let route = this.mappings[path]
    let routeParams: Record<string, any> = {}
    
    // If no exact match, try parameterized routes (e.g., /blocks/:address)
    if (!route) {
      for (const routePattern in this.mappings) {
        const patternRegex = new RegExp('^' + routePattern.replace(/:[^/]+/g, '([^/]+)') + '$')
        const match = path.match(patternRegex)
        if (match) {
          route = this.mappings[routePattern]
          // Extract parameter names and values
          const paramNames = routePattern.match(/:[^/]+/g) || []
          paramNames.forEach((paramName, index) => {
            const key = paramName.substring(1) // Remove :
            routeParams[key] = match[index + 1]
          })
          break
        }
      }
    }
    
    if (!route) {
      return new Response('Not Found', { status: 404 })
    }

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { 
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      })
    }

    // Handle GET requests
    if (method === 'GET') {
      try {
        // Check if route supports GET (it might be a function or an object with a get method)
        let handler: RouteHandler | undefined
        if (typeof route === 'function') {
          handler = route
        } else if (typeof route === 'object' && route.get) {
          handler = route.get
        } else {
          return new Response(`${method} method not allowed`, { status: 405 })
        }

        if (!handler) {
          return new Response(`${method} method not allowed`, { status: 405 })
        }

        const params = { ...Object.fromEntries(url.searchParams), ...routeParams }
        const result = await handler(params)

        return Response.json(result, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
          }
        })
      } catch (err) {
        if (err instanceof Error) {
          return Response.json({ error: err.message }, { 
            status: 400,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Content-Type': 'application/json'
            }
          })
        } else if (typeof err === 'string') {
          return Response.json({ error: err }, { 
            status: 400,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Content-Type': 'application/json'
            }
          })
        } else throw err
      }
    }
    
    // Handle POST requests
    if (method === 'POST') {
      try {
        // Check if route supports POST (it might be an object with a post method)
        let handler: ((body: any) => any | Promise<any>) | undefined
        if (typeof route === 'function') {
          // Functions are typically for GET, but allow it for backward compatibility
          handler = route as any
        } else if (typeof route === 'object' && route.post) {
          handler = route.post
        } else {
          return Response.json({ error: `${method} method not allowed` }, { 
            status: 405,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Content-Type': 'application/json'
            }
          })
        }

        if (!handler) {
          return Response.json({ error: `${method} method not allowed` }, { 
            status: 405,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Content-Type': 'application/json'
            }
          })
        }

            // Parse request body (if present)
            let body = {}
            try {
              // Try to read request body as text first
              const text = await request.text()
              if (text && text.trim().length > 0) {
                // Parse JSON if we have content
                body = JSON.parse(text)
              }
              // Empty body is fine - use empty object (already set)
            } catch (parseErr) {
              // If JSON parse fails, return error
              return Response.json({ error: 'Invalid JSON in request body', success: false }, { 
                status: 400,
                headers: {
                  'Access-Control-Allow-Origin': '*',
                  'Content-Type': 'application/json'
                }
              })
            }

            const result = await handler(body)

        // Ensure result has success field if it doesn't already
        const response = typeof result === 'object' && result !== null && 'success' in result 
          ? result 
          : { success: true, ...result }

        return Response.json(response, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
          }
        })
      } catch (err) {
        console.error('[Server] POST handler error:', err)
        const errorMsg = err instanceof Error ? err.message : (typeof err === 'string' ? err : 'Unknown error')
        return Response.json({ error: errorMsg, success: false }, { 
          status: 400,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
          }
        })
      }
    }
    
    return new Response(`${method} method not allowed`, { status: 405 })
  }
}
