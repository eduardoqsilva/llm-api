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

  describe('GET /v1/tools', () => {
    it('rejeita sem autenticação', async () => {
      const app = buildApp({ logger: false })

      const response = await app.inject({
        method: 'GET',
        url: '/v1/tools',
      })

      expect(response.statusCode).toBe(401)

      await app.close()
    })

    it('lista as tools embutidas', async () => {
      const app = buildApp({ logger: false })

      const response = await app.inject({
        method: 'GET',
        url: '/v1/tools',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const names = response
        .json()
        .data.map((tool: { function: { name: string } }) => tool.function.name)
      expect(names).toContain('web_search')
      expect(names).toContain('fetch_page')
      expect(names).toContain('calculator')

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

    it('executa tools em streaming e continua o SSE', async () => {
      const encoder = new TextEncoder()

      function sseResponse(...events: string[]): Response {
        const stream = new ReadableStream({
          start(controller) {
            for (const event of events) {
              controller.enqueue(encoder.encode(event))
            }
            controller.close()
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }

      const firstRound = [
        'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"calculator","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"expression\\":\\"2+2\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ]
      const secondRound = [
        'data: {"choices":[{"delta":{"content":"O resultado é 4."}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(sseResponse(...firstRound))
        .mockResolvedValueOnce(sseResponse(...secondRound))
      vi.stubGlobal('fetch', fetchMock)

      const app = buildApp({ logger: false })

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          ...payload,
          stream: true,
          enable_tools: true,
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('calculator')
      expect(response.body).toContain('O resultado é 4.')
      expect(response.body).toContain('data: [DONE]')

      const [, secondInit] = fetchMock.mock.calls[1]
      const secondBody = JSON.parse(secondInit.body)
      expect(secondBody).not.toHaveProperty('enable_tools')
      expect(secondBody.messages).toContainEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: '4',
      })

      await app.close()
    })

    it('executa tools sem streaming e retorna a resposta final', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                      {
                        id: 'call_1',
                        type: 'function',
                        function: {
                          name: 'calculator',
                          arguments: JSON.stringify({ expression: '7 * 6' }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'O resultado é 42.',
                  },
                },
              ],
            }),
            { status: 200 }
          )
        )
      vi.stubGlobal('fetch', fetchMock)

      const app = buildApp({ logger: false })

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          ...payload,
          enable_tools: true,
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'O resultado é 42.',
            },
          },
        ],
      })

      await app.close()
    })
  })
})
