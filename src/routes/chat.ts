import type { FastifyPluginAsync } from 'fastify'
import { env } from '../config/env.js'
import {
  chatCompletionWithTools,
  continueToolStream,
  prepareToolBody,
} from '../services/chatTools.js'
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

type ChatBody = {
  stream?: boolean
  thinking?: boolean
  stateless?: boolean
  tools?: unknown[]
  enable_tools?: boolean
  max_tool_rounds?: number
  messages?: ChatMessage[]
}

const chatRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/chat/completions', async (request, reply) => {
    const rawBody = request.body as ChatBody

    const thinking =
      typeof rawBody.thinking === 'boolean' ? rawBody.thinking : undefined
    const stateless =
      typeof rawBody.stateless === 'boolean' ? rawBody.stateless : undefined

    const { body, toolsEnabled, maxRounds } = prepareToolBody(
      rawBody as Record<string, unknown>,
      env.maxToolRounds
    )

    const effectiveStateless = toolsEnabled ? undefined : stateless

    if (!rawBody.stream) {
      const response = toolsEnabled
        ? await chatCompletionWithTools(
            body,
            thinking,
            effectiveStateless,
            maxRounds
          )
        : await chatCompletion(body, thinking, effectiveStateless)

      const data = await response.json()
      return reply.code(response.status).send(data)
    }

    const firstResponse = await chatCompletion(
      body,
      thinking,
      effectiveStateless
    )

    if (!firstResponse.ok || !firstResponse.body) {
      const data = await firstResponse.text()
      return reply
        .code(firstResponse.status)
        .type('application/json')
        .send(data)
    }

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

    reply.raw.setHeader(
      'Content-Type',
      firstResponse.headers.get('content-type') ?? 'text/event-stream'
    )

    reply.raw.statusCode = firstResponse.status

    reply.hijack()

    try {
      await continueToolStream(
        firstResponse,
        body,
        thinking,
        effectiveStateless,
        maxRounds,
        (text) => reply.raw.write(text)
      )
    } finally {
      reply.raw.end()
    }
  })
}

export default chatRoute
