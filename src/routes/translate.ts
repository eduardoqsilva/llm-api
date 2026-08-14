import type { FastifyPluginAsync } from 'fastify'
import { translate } from '../services/translate.js'

type TranslateBody = {
  text?: string
  to?: string
  from?: string
  thinking?: boolean
}

const translateRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/translate', async (request, reply) => {
    const body = (request.body ?? {}) as TranslateBody

    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const to = typeof body.to === 'string' ? body.to.trim() : ''

    if (!text) {
      return reply.code(400).send({
        error: {
          message: 'The "text" field is required.',
          type: 'invalid_request_error',
        },
      })
    }

    if (!to) {
      return reply.code(400).send({
        error: {
          message: 'The "to" field is required.',
          type: 'invalid_request_error',
        },
      })
    }

    const result = await fastify.translateQueue.enqueue(() =>
      translate({
        text,
        to,
        from: typeof body.from === 'string' ? body.from : undefined,
        thinking:
          typeof body.thinking === 'boolean' ? body.thinking : undefined,
      })
    )

    return reply.code(result.status).send(result.body)
  })
}

export default translateRoute
