import cors from '@fastify/cors'
import Fastify from 'fastify'
import { env } from './config/env.js'
import authPlugin from './plugins/auth.js'
import chatRoute from './routes/chat.js'

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
