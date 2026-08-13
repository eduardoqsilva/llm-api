import type { FastifyPluginAsync } from 'fastify'
import { chatCompletion } from '../services/llama.js'

type ContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url'
      image_url: { url: string }
    }
  | {
      type: 'input_audio'
      input_audio: { data: string; format: string }
    }
  | {
      type: 'input_video'
      input_video: { data: string }
    }

type ChatMessage = {
  role: string
  content: string | ContentPart[]
}

const chatRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/chat/completions', async (request, reply) => {
    const body = request.body as {
      stream?: boolean
      thinking?: boolean
      stateless?: boolean
      messages?: ChatMessage[]
    }

    const response = await chatCompletion(body, body.thinking, body.stateless)

    if (body.stream) {
      const origin = request.headers.origin

      if (origin) {
        reply.raw.setHeader('Access-Control-Allow-Origin', origin)
      }

      reply.raw.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type'
      )

      reply.raw.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST')

      reply.raw.setHeader('Cache-Control', 'no-cache')

      reply.raw.setHeader('Connection', 'keep-alive')

      const contentType = response.headers.get('content-type')

      reply.raw.setHeader('Content-Type', contentType ?? 'text/event-stream')

      reply.raw.statusCode = response.status

      reply.hijack()

      if (!response.body) {
        reply.raw.end()
        return
      }

      const reader = response.body.getReader()

      try {
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            break
          }

          reply.raw.write(value)
        }
      } finally {
        reader.releaseLock()
        reply.raw.end()
      }

      return
    }

    const data = await response.json()

    return reply.code(response.status).send(data)
  })
}

export default chatRoute
