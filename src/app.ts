import cors from '@fastify/cors'
import Fastify from 'fastify'
import { env } from './config/env.js'
import { authenticate } from './plugins/auth.js'
import chatRoute from './routes/chat.js'
import toolsRoute from './routes/tools.js'

export function buildApp(options: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: env.bodyLimit,
  })

  app.register(cors, {
    origin: true,
  })

  app.register(async (app) => {
    app.addHook('onRequest', authenticate)

    app.register(chatRoute)
    app.register(toolsRoute)
  })

  app.get('/health', async () => {
    return {
      status: 'ok',
    }
  })

  return app
}
