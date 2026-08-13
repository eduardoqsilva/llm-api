import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatCompletion } from '../src/services/llama.js'

describe('chatCompletion', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('envia POST para o llama-server com o body serializado', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const body = {
      model: 'model.gguf',
      messages: [{ role: 'user', content: 'oi' }],
    }

    const response = await chatCompletion(body)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://llama:8080/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
    expect(response.status).toBe(200)
  })

  it('retorna a resposta do llama-server', async () => {
    const expected = new Response('{"choices":[]}', { status: 200 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(expected))

    const response = await chatCompletion({ messages: [] })

    expect(response).toBe(expected)
  })

  describe('thinking', () => {
    it('mapeia thinking: true para enable_thinking', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
      vi.stubGlobal('fetch', fetchMock)

      await chatCompletion({ thinking: true, messages: [] }, true)

      const [, init] = fetchMock.mock.calls[0]
      const sent = JSON.parse(init.body)

      expect(sent.chat_template_kwargs).toEqual({ enable_thinking: true })
      expect(sent).not.toHaveProperty('thinking')
    })

    it('mapeia thinking: false para enable_thinking false e reasoning_effort none', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
      vi.stubGlobal('fetch', fetchMock)

      await chatCompletion({ thinking: false, messages: [] }, false)

      const [, init] = fetchMock.mock.calls[0]
      const sent = JSON.parse(init.body)

      expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false })
      expect(sent.reasoning_effort).toBe('none')
      expect(sent).not.toHaveProperty('thinking')
    })

    it('preserva chat_template_kwargs existentes', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
      vi.stubGlobal('fetch', fetchMock)

      await chatCompletion(
        {
          thinking: true,
          chat_template_kwargs: { foo: 'bar' },
          messages: [],
        },
        true
      )

      const [, init] = fetchMock.mock.calls[0]
      const sent = JSON.parse(init.body)

      expect(sent.chat_template_kwargs).toEqual({
        foo: 'bar',
        enable_thinking: true,
      })
    })

    it('não altera o body quando thinking é undefined', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
      vi.stubGlobal('fetch', fetchMock)

      const body = { thinking: true, messages: [] }
      await chatCompletion(body)

      const [, init] = fetchMock.mock.calls[0]

      expect(JSON.parse(init.body)).toEqual({
        thinking: true,
        messages: [],
      })
    })
  })

  describe('stateless', () => {
    const messages = [
      { role: 'user', content: 'primeira' },
      { role: 'assistant', content: 'resposta' },
      { role: 'user', content: 'segunda' },
    ]

    it('com stateless: true envia apenas a última mensagem', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
      vi.stubGlobal('fetch', fetchMock)

      await chatCompletion({ messages }, undefined, true)

      const [, init] = fetchMock.mock.calls[0]
      const sent = JSON.parse(init.body)

      expect(sent.messages).toEqual([{ role: 'user', content: 'segunda' }])
    })

    it('sem stateless mantém o histórico completo', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
      vi.stubGlobal('fetch', fetchMock)

      await chatCompletion({ messages })

      const [, init] = fetchMock.mock.calls[0]

      expect(JSON.parse(init.body).messages).toEqual(messages)
    })
  })
})
