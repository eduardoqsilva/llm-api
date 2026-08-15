import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'

const API_URL = 'http://llama:8080/v1/chat/completions'

function buildFetchMock(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('POST /v1/translate', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejeita sem autenticação', async () => {
    const app = buildApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      payload: { text: 'Bom dia', to: 'en' },
    })

    expect(response.statusCode).toBe(401)

    await app.close()
  })

  it('rejeita quando text está ausente', async () => {
    const app = buildApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { to: 'en' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: {
        message: 'The "text" field is required.',
        type: 'invalid_request_error',
      },
    })

    await app.close()
  })

  it('rejeita quando to está ausente', async () => {
    const app = buildApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { text: 'Bom dia' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: {
        message: 'The "to" field is required.',
        type: 'invalid_request_error',
      },
    })

    await app.close()
  })

  it('traduz usando o modelo e devolve o texto traduzido', async () => {
    const fetchMock = buildFetchMock(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Good morning.',
              },
            },
          ],
        }),
        { status: 200 }
      )
    )

    const app = buildApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { text: 'Bom dia.', to: 'en', from: 'pt' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      text: 'Good morning.',
      from: 'pt',
      to: 'en',
    })

    const [, init] = fetchMock.mock.calls[0]
    expect(fetchMock).toHaveBeenCalledWith(
      API_URL,
      expect.objectContaining({ method: 'POST' })
    )
    const sent = JSON.parse(init.body)
    expect(sent.messages[0].role).toBe('system')
    expect(sent.messages[0].content).toContain(
      'You are a professional pt to en translator.'
    )
    expect(sent.messages[0].content).toContain(
      'Please translate the following pt text into en:'
    )
    expect(sent.messages[1]).toEqual({
      role: 'user',
      content: 'Bom dia.',
    })
    expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(sent.reasoning_effort).toBe('none')

    await app.close()
  })

  it('detecta o idioma de origem quando from é omitido', async () => {
    const fetchMock = buildFetchMock(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Bom dia.' } }],
        }),
        { status: 200 }
      )
    )

    const app = buildApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { text: 'Good morning.', to: 'pt-BR' },
    })

    expect(response.statusCode).toBe(200)

    const [, init] = fetchMock.mock.calls[0]
    const sent = JSON.parse(init.body)
    expect(sent.messages[0].content).toContain(
      'You are a professional auto to pt-BR translator.'
    )

    await app.close()
  })

  it('propaga erros do llama-server (ex.: 500) após esgotar as tentativas', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ error: { message: 'internal error' } }),
            { status: 500 }
          )
      )
    vi.stubGlobal('fetch', fetchMock)

    const app = buildApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { text: 'Bom dia', to: 'en' },
    })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({
      error: { message: 'internal error' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await app.close()
  })

  it('tenta novamente um chunk que falha e então obtém sucesso', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'boom' } }), {
          status: 500,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'OK.' } }],
          }),
          { status: 200 }
        )
      )
    vi.stubGlobal('fetch', fetchMock)

    const app = buildApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { text: 'Bom dia', to: 'en', from: 'pt' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ text: 'OK.', from: 'pt', to: 'en' })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await app.close()
  })

  it('não tenta novamente em erro 4xx do modelo', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: 'bad request' } }), {
          status: 400,
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = buildApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { text: 'Bom dia', to: 'en' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: { message: 'bad request' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('inclui texto parcial quando um chunk falha depois de outros concluídos', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Primeira ' } }],
          }),
          { status: 200 }
        )
      )
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ error: { message: 'boom' } }), {
            status: 500,
          })
      )
    vi.stubGlobal('fetch', fetchMock)

    const app = buildApp({ logger: false })

    const longText =
      'Esta é uma frase longa que deve ser quebrada em pedaços. '.repeat(20)
    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { text: longText, to: 'en', from: 'pt' },
    })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({
      error: { message: 'boom' },
      partial: 'Primeira',
    })

    await app.close()
  })

  it('em streaming (stream: true) devolve eventos SSE com progresso e resultado', async () => {
    const encoder = new TextEncoder()
    const events = [
      'data: {"choices":[{"delta":{"content":"Bom "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"dia."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const event of events)
              controller.enqueue(encoder.encode(event))
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = buildApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: {
        authorization: 'Bearer test-token',
        origin: 'http://localhost:5173',
      },
      payload: { text: 'Bom dia.', to: 'en', from: 'pt', stream: true },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173'
    )
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.body).toContain('event: queued')
    expect(response.body).toContain('event: start')
    expect(response.body).toContain('event: chunk_start')
    expect(response.body).toContain('event: delta')
    expect(response.body).toContain('"text":"Bom "')
    expect(response.body).toContain('"text":"dia."')
    expect(response.body).toContain('event: chunk_end')
    expect(response.body).toContain('event: done')
    expect(response.body).toContain('"text":"Bom dia."')

    const [, init] = fetchMock.mock.calls[0]
    const sent = JSON.parse(init.body as string)
    expect(sent.stream).toBe(true)

    await app.close()
  })

  it('em streaming quebra texto grande em múltiplos chunks', async () => {
    const encoder = new TextEncoder()

    function sseResponse(content: string): Response {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`
              )
            )
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    }

    let call = 0
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => sseResponse(`parte ${call++} `))
    vi.stubGlobal('fetch', fetchMock)

    const app = buildApp({ logger: false })

    const longText =
      'Esta é uma frase longa que deve ser quebrada em pedaços. '.repeat(20)
    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { text: longText, to: 'en', from: 'pt', stream: true },
    })

    const calls = fetchMock.mock.calls.length

    expect(response.statusCode).toBe(200)
    expect(calls).toBeGreaterThan(1)
    expect(response.body).toContain('event: done')

    const chunkStartCount = (response.body.match(/event: chunk_start/g) ?? [])
      .length
    const deltaCount = (response.body.match(/event: delta/g) ?? []).length
    expect(chunkStartCount).toBe(calls)
    expect(deltaCount).toBe(calls)

    for (const [, init] of fetchMock.mock.calls) {
      const sent = JSON.parse((init as RequestInit).body as string)
      expect(sent.stream).toBe(true)
    }

    await app.close()
  })

  it('em streaming emite evento de erro quando o modelo falha', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: 'boom' } }), {
          status: 500,
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = buildApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { text: 'Bom dia', to: 'en', stream: true },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('event: queued')
    expect(response.body).toContain('event: error')
    expect(response.body).toContain('boom')
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await app.close()
  })

  it('em streaming emite evento de erro quando o fetch falha inesperadamente', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    )

    const app = buildApp({ logger: false })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { text: 'Bom dia', to: 'en', stream: true },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('event: error')
    expect(response.body).toContain('fetch failed')

    await app.close()
  })

  it('quebra texto grande em múltiplas chamadas e junta a resposta', async () => {
    let call = 0

    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: `parte ${call++} `,
                },
              },
            ],
          }),
          { status: 200 }
        )
    )
    vi.stubGlobal('fetch', fetchMock)

    const app = buildApp({ logger: false })

    const longText =
      'Esta é uma frase longa que deve ser quebrada em pedaços. '.repeat(20)
    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { text: longText, to: 'en', from: 'pt' },
    })

    const calls = fetchMock.mock.calls.length

    expect(calls).toBeGreaterThan(1)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      text: Array.from({ length: calls }, (_, i) => `parte ${i} `)
        .join('')
        .trim(),
      from: 'pt',
      to: 'en',
    })

    const sentTexts = fetchMock.mock.calls.map(
      ([, init]) =>
        JSON.parse(init.body as string).messages[1].content as string
    )
    expect(sentTexts.join('')).toBe(longText.trim())
    for (const sent of sentTexts) {
      expect(sent.length).toBeLessThanOrEqual(50)
    }

    await app.close()
  })

  it('processa uma requisição por vez (fila)', async () => {
    let resolveFirst!: (value: Response) => void
    const gate = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })

    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(gate)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Segundo.' } }],
          }),
          { status: 200 }
        )
      )
    vi.stubGlobal('fetch', fetchMock)

    const app = buildApp({ logger: false })

    const first = app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { text: 'Primeiro.', to: 'en' },
    })
    const second = app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { text: 'Segundo.', to: 'en' },
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveFirst(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Primeiro.' } }],
        }),
        { status: 200 }
      )
    )

    const firstResponse = await first
    const secondResponse = await second

    expect(firstResponse.statusCode).toBe(200)
    expect(firstResponse.json()).toEqual({
      text: 'Primeiro.',
      to: 'en',
    })
    expect(secondResponse.statusCode).toBe(200)
    expect(secondResponse.json()).toEqual({
      text: 'Segundo.',
      to: 'en',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await app.close()
  })
})
