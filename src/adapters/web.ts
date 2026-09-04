/**
 * Web-standard adapter: `Request` in, `Response` out. For anything that speaks
 * fetch: Hono, Next.js route handlers, Cloudflare Workers, Deno, Bun, Lambda
 * behind a function URL. None of those can hold a WebSocket, which is what
 * the HTTP transport is for (TRANSPORTS.md §3).
 *
 * Hono:
 *
 *   const handle = bellhopFetch(bellhop)
 *   app.all('/bellhop/*', (c) => handle(c.req.raw))
 *
 * Next.js app router, `app/bellhop/[...path]/route.ts`:
 *
 *   const handle = bellhopFetch(bellhop)
 *   export { handle as GET, handle as POST, handle as DELETE }
 *
 * On a platform that will not hold a request open for 25 seconds, set
 * `pollSeconds: 0`. The agent then polls every 3 seconds, and a label arrives
 * within 3 seconds of being created.
 */

import type { Bellhop } from '../bellhop.js'

export function bellhopFetch(bellhop: Bellhop): (request: Request) => Promise<Response> {
  bellhop.autoStartRenewals()
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname.startsWith(bellhop.config.basePath)
      ? url.pathname.slice(bellhop.config.basePath.length) || '/'
      : url.pathname

    let body: unknown
    if (request.method === 'POST' || request.method === 'PUT') {
      body = await request.json().catch(() => undefined)
    }

    const result = await bellhop.handleRequest({
      method: request.method,
      path,
      query: url.searchParams,
      getHeader: (name) => request.headers.get(name) ?? undefined,
      body,
      // Behind a proxy this is the only address there is. Trust it as far as
      // your platform's header handling deserves.
      ip:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        request.headers.get('cf-connecting-ip') ??
        undefined,
    })

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json', ...(result.headers ?? {}) },
    })
  }
}
