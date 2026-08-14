import type { FastifyPluginAsync } from 'fastify'
import { type TranslateResult, translate } from '../services/translate.js'

type TranslateBody = {
  text?: string
  to?: string
  from?: string
  thinking?: boolean
  stream?: boolean
}

const HEARTBEAT_MS = 15000

function errorMessage(body: unknown): string {
  if (typeof body === 'string') return body
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const nested = record.error as Record<string, unknown> | undefined
    if (typeof nested?.message === 'string') return nested.message
    if (typeof record.message === 'string') return record.message
  }
  return 'Erro ao traduzir.'
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

    const from = typeof body.from === 'string' ? body.from : undefined
    const thinking =
      typeof body.thinking === 'boolean' ? body.thinking : undefined

    if (body.stream !== true) {
      const result = await fastify.translateQueue.enqueue(() =>
        translate({ text, to, from, thinking })
      )
      return reply.code(result.status).send(result.body)
    }

    let aborted = false
    request.raw.on('close', () => {
      aborted = true
    })

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
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.statusCode = 200
    reply.hijack()

    const write = (chunk: string) => {
      if (!aborted) {
        reply.raw.write(chunk)
      }
    }

    const sse = (event: string, data: unknown) => {
      write(`event: ${event}\n`)
      write(`data: ${JSON.stringify(data)}\n\n`)
    }

    const position = fastify.translateQueue.size() + 1
    sse('queued', { position })

    const heartbeat = setInterval(() => {
      write(': keepalive\n\n')
    }, HEARTBEAT_MS)

    try {
      const result = (await fastify.translateQueue.enqueue(() =>
        translate(
          { text, to, from, thinking },
          {
            stream: true,
            aborted: () => aborted,
            onEvent: (event) => {
              switch (event.type) {
                case 'start':
                  sse('start', { chunks: event.chunks })
                  break
                case 'chunk_start':
                  sse('chunk_start', {
                    index: event.index,
                    chunks: event.chunks,
                  })
                  break
                case 'chunk_retry':
                  sse('chunk_retry', {
                    index: event.index,
                    attempt: event.attempt,
                  })
                  break
                case 'delta':
                  sse('delta', { text: event.text })
                  break
                case 'chunk_end':
                  sse('chunk_end', {
                    index: event.index,
                    chunks: event.chunks,
                  })
                  break
              }
            },
          }
        )
      )) as TranslateResult

      if (result.ok) {
        sse('done', result.body)
      } else {
        const record = result.body as Record<string, unknown> | undefined
        sse('error', {
          status: result.status,
          message: errorMessage(result.body),
          partial: typeof record?.partial === 'string' ? record.partial : '',
        })
      }
    } catch {
      // aborted or unexpected error — nothing left to send
    } finally {
      clearInterval(heartbeat)
      reply.raw.end()
    }
  })
}

export default translateRoute
