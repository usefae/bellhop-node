/**
 * Fastify adapter.
 *
 *   import Fastify from 'fastify'
 *   import { bellhopFastify } from '@usefae/bellhop-node/fastify'
 *
 *   const app = Fastify()
 *   await app.register(bellhopFastify, { bellhop })
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Bellhop } from '../bellhop.js'

export interface BellhopFastifyOptions {
  bellhop: Bellhop
}

/**
 * Registers the claim, webhook, and HTTP-transport routes under the instance's
 * `basePath`. For the WebSocket transport, call
 * `attachWebSocket(bellhop, app.server)` after `app.ready()`.
 */
export const bellhopFastify: FastifyPluginAsync<BellhopFastifyOptions> = async (
  app: FastifyInstance,
  options: BellhopFastifyOptions
) => {
  const { bellhop } = options
  const base = bellhop.config.basePath
  bellhop.autoStartRenewals()

  const respond = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname.slice(base.length) || '/'

    const result = await bellhop.handleRequest({
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

    await reply
      .status(result.status)
      .headers(result.headers ?? {})
      .send(result.body)
  }

  app.post(`${base}/claim`, respond)
  app.post(`${base}/webhook`, respond)
  app.post(`${base}/sessions`, respond)
  app.get(`${base}/sessions/:id/messages`, respond)
  app.post(`${base}/sessions/:id/messages`, respond)
  app.delete(`${base}/sessions/:id`, respond)
}

// The symbols fastify-plugin would set: the plugin is not encapsulated, Fastify
// checks the version range at register time, and `app.hasPlugin('@usefae/bellhop-node')`
// answers.
Object.defineProperty(bellhopFastify, Symbol.for('skip-override'), { value: true })
Object.defineProperty(bellhopFastify, Symbol.for('plugin-meta'), {
  value: { name: '@usefae/bellhop-node', fastify: '>=4' },
})
Object.defineProperty(bellhopFastify, Symbol.for('fastify.display-name'), {
  value: '@usefae/bellhop-node',
})
