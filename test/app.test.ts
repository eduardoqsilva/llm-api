import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'

const API_URL = 'http://llama:8080/v1/chat/completions'

function buildFetchMock(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('buildApp', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('GET /health', () => {
    it('responde ok sem autenticação', async () => {
      const app = buildApp({ logger: false })

      const response = await app.inject({
        method: 'GET',
        url: '/health',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ status: 'ok' })

      await app.close()
    })
  })

  describe('POST /v1/chat/completions', () => {
    const payload = {
      model: 'model.gguf',
      messages: [{ role: 'user', content: 'oi' }],
    }

    it('rejeita sem Authorization', async () => {
      const app = buildApp({ logger: false })

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload,
      })

      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({
        error: {
          message: 'Unauthorized',
          type: 'authentication_error',
        },
      })

      await app.close()
    })

    it('rejeita token inválido', async () => {
      const app = buildApp({ logger: false })

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer token-errado' },
        payload,
      })

      expect(response.statusCode).toBe(401)

      await app.close()
    })

    it('repassa o body ao llama-server e devolve a resposta', async () => {
      const fetchMock = buildFetchMock(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'oi' } }],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      )

      const app = buildApp({ logger: false })

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-token' },
        payload,
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        choices: [{ message: { role: 'assistant', content: 'oi' } }],
      })

      const [, init] = fetchMock.mock.calls[0]
      expect(fetchMock).toHaveBeenCalledWith(
        API_URL,
        expect.objectContaining({ method: 'POST' })
      )
      expect(JSON.parse(init.body)).toEqual(payload)

      await app.close()
    })

    it('propaga erros do llama-server (ex.: 500)', async () => {
      buildFetchMock(
        new Response(
          JSON.stringify({
            error: { message: 'internal error' },
          }),
          { status: 500 }
        )
      )

      const app = buildApp({ logger: false })

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-token' },
        payload,
      })

      expect(response.statusCode).toBe(500)
      expect(response.json()).toEqual({
        error: { message: 'internal error' },
      })

      await app.close()
    })

    it('em streaming devolve SSE com headers CORS', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"oi"}}]}\n\n')
          )
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })

      buildFetchMock(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )

      const app = buildApp({ logger: false })

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: 'Bearer test-token',
          origin: 'http://localhost:5173',
        },
        payload: {
          ...payload,
          stream: true,
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173'
      )
      expect(response.body).toContain(
        'data: {"choices":[{"delta":{"content":"oi"}}]}'
      )
      expect(response.body).toContain('data: [DONE]')

      await app.close()
    })
  })
})
