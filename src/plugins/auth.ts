import type { FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../config/env.js'

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const authorization = request.headers.authorization

  if (!authorization) {
    return reply.code(401).send({
      error: {
        message: 'Unauthorized',
        type: 'authentication_error',
      },
    })
  }

  const [scheme, token] = authorization.split(' ')

  if (scheme?.toLowerCase() !== 'bearer' || !token || token !== env.apiToken) {
    return reply.code(401).send({
      error: {
        message: 'Unauthorized',
        type: 'authentication_error',
      },
    })
  }
}
