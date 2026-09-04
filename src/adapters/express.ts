/**
 * Express adapter. Mounts the claim, webhook, and HTTP-transport routes under
 * the instance's `basePath`. JSON parsing is handled here, so `express.json()`
 * is not needed for these routes. The WebSocket transport hangs off the HTTP
 * server rather than the app: see `@usefae/bellhop-node/ws`.
 *
 *   import express from 'express'
 *   import { bellhopExpress } from '@usefae/bellhop-node/express'
 *
 *   const app = express()
 *   app.use(bellhopExpress(bellhop))
 */

import express, { type Request, type RequestHandler, type Response, type Router } from 'express'
import type { Bellhop } from '../bellhop.js'

export function bellhopExpress(bellhop: Bellhop): Router {
  const router = express.Router()
  const base = bellhop.config.basePath || '/'

  // Agent-to-server bodies are small: a hello, a batch of acks. Documents
  // travel the other way. 1mb matches Fastify's default.
  router.use(base, express.json({ limit: '1mb' }), handler(bellhop))
  return router
}

/** The bare handler, to mount yourself. */
export function bellhopExpressHandler(bellhop: Bellhop): RequestHandler {
  return handler(bellhop)
}

function handler(bellhop: Bellhop): RequestHandler {
  bellhop.autoStartRenewals()
  return (req: Request, res: Response, next) => {
    const url = new URL(req.originalUrl, 'http://localhost')
    const path = url.pathname.slice(bellhop.config.basePath.length) || '/'

    bellhop
      .handleRequest({
        method: req.method,
        path,
        query: url.searchParams,
        getHeader: (name) => {
          const value = req.headers[name.toLowerCase()]
          return Array.isArray(value) ? value[0] : value
        },
        body: req.body,
        ip: req.ip,
      })
      .then((result) => {
        if (
          result.status === 404 &&
          result.body &&
          (result.body as { error?: string }).error === 'not_found'
        ) {
          // Not one of ours. Let the rest of the app answer.
          return next()
        }
        res.status(result.status)
        if (result.headers) res.set(result.headers)
        res.json(result.body)
      })
      .catch(next)
  }
}
