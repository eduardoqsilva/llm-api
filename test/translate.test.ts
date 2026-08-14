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
      url: '/v1/translate',
      headers: { authorization: 'Bearer test-token' },
      payload: { text: 'Bom dia', to: 'en' },
    })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({
      error: { message: 'internal error' },
    })

    await app.close()
  })
})
