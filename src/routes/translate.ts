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

    const response = await translate({
      text,
      to,
      from: typeof body.from === 'string' ? body.from : undefined,
      thinking: typeof body.thinking === 'boolean' ? body.thinking : undefined,
    })

    const data = await response.json()

    if (!response.ok) {
      return reply.code(response.status).send(data)
    }

    const content = data?.choices?.[0]?.message?.content

    if (typeof content !== 'string') {
      return reply.code(502).send({
        error: {
          message: 'Unexpected response from the model.',
          type: 'server_error',
        },
      })
    }

    return reply.send({
      text: content.trim(),
      from: body.from,
      to,
    })
  })
}

export default translateRoute
