import Fastify from 'fastify'

import authPlugin from './plugins/auth.js'
import chatRoute from './routes/chat.js'
import cors from '@fastify/cors'
import { env } from './config/env.js'

export function buildApp() {
  const app = Fastify({
    logger: true,
    bodyLimit: env.bodyLimit,
  })

  app.register(cors, {
    origin: true,
  })


  app.register(authPlugin)

  app.register(chatRoute)

  app.get('/health', async () => {
    return {
      status: 'ok',
    }
  })

  return app
}