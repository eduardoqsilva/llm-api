import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chatCompletionWithTools,
  clampRounds,
  continueToolStream,
  prepareToolBody,
} from '../src/services/chatTools.js'
import { getBuiltinSchemas } from '../src/tools/index.js'

describe('clampRounds', () => {
  it('limita o número de rodadas entre 1 e 20', () => {
    expect(clampRounds(0, 8)).toBe(1)
    expect(clampRounds(5, 8)).toBe(5)
    expect(clampRounds(99, 8)).toBe(20)
    expect(clampRounds(undefined, 8)).toBe(8)
  })
})

describe('prepareToolBody', () => {
  it('injeta schemas embutidos com enable_tools: true', () => {
    const raw = {
      model: 'model.gguf',
      messages: [{ role: 'user', content: 'oi' }],
      enable_tools: true,
      max_tool_rounds: 3,
      stateless: true,
    }

    const { body, toolsEnabled, maxRounds } = prepareToolBody(raw, 8)

    expect(toolsEnabled).toBe(true)
    expect(maxRounds).toBe(3)
    expect(body.tools).toEqual(getBuiltinSchemas())
    expect(body).not.toHaveProperty('enable_tools')
    expect(body).not.toHaveProperty('max_tool_rounds')
    expect(body).not.toHaveProperty('stateless')
  })

  it('preserva tools enviadas pelo cliente', () => {
    const tools = [{ type: 'function', function: { name: 'custom' } }]
    const { body, toolsEnabled } = prepareToolBody({ messages: [], tools }, 8)

    expect(toolsEnabled).toBe(true)
    expect(body.tools).toBe(tools)
  })

  it('não altera o body quando tools não são solicitadas', () => {
    const raw = { model: 'model.gguf', messages: [] }
    const { body, toolsEnabled, maxRounds } = prepareToolBody(raw, 8)

    expect(toolsEnabled).toBe(false)
    expect(maxRounds).toBe(1)
    expect(body).toBe(raw)
  })
})

describe('chatCompletionWithTools', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const llamaUrl = 'http://llama:8080/v1/chat/completions'

  function mockLlamaResponses(...responses: Response[]) {
    const fetchMock = vi.fn()
    for (const response of responses) {
      fetchMock.mockResolvedValueOnce(response)
    }
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function toolCallResponse(name: string, args: string): Response {
    return new Response(
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
                  function: { name, arguments: args },
                },
              ],
            },
          },
        ],
      }),
      { status: 200 }
    )
  }

  function finalResponse(content: string): Response {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
      }),
      { status: 200 }
    )
  }

  it('executa tools e retorna a resposta final', async () => {
    const fetchMock = mockLlamaResponses(
      toolCallResponse('calculator', JSON.stringify({ expression: '2 + 2' })),
      finalResponse('O resultado é 4.')
    )

    const body = {
      messages: [{ role: 'user', content: 'Quanto é 2+2?' }],
      tools: getBuiltinSchemas(),
    }

    const response = await chatCompletionWithTools(
      body,
      undefined,
      undefined,
      8
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      choices: [
        {
          message: { role: 'assistant', content: 'O resultado é 4.' },
        },
      ],
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      llamaUrl,
      expect.objectContaining({ method: 'POST' })
    )

    const [, secondInit] = fetchMock.mock.calls[1]
    const secondBody = JSON.parse(secondInit.body)

    expect(secondBody.messages).toContainEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'calculator', arguments: '{"expression":"2 + 2"}' },
        },
      ],
    })
    expect(secondBody.messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '4',
    })
  })

  it('ignora stateless quando há tools', async () => {
    const fetchMock = mockLlamaResponses(
      toolCallResponse('calculator', JSON.stringify({ expression: '1 + 1' })),
      finalResponse('2')
    )

    await chatCompletionWithTools(
      {
        messages: [{ role: 'user', content: 'quanto é 1+1?' }],
        tools: getBuiltinSchemas(),
      },
      undefined,
      true,
      8
    )

    const [, secondInit] = fetchMock.mock.calls[1]
    const secondBody = JSON.parse(secondInit.body)

    expect(secondBody.messages).toContainEqual({
      role: 'user',
      content: 'quanto é 1+1?',
    })
    expect(secondBody.messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '2',
    })
  })

  it('propaga erros HTTP sem executar tools', async () => {
    const fetchMock = mockLlamaResponses(
      new Response(JSON.stringify({ error: { message: 'internal error' } }), {
        status: 500,
      })
    )

    const response = await chatCompletionWithTools(
      { messages: [], tools: getBuiltinSchemas() },
      undefined,
      undefined,
      8
    )

    expect(response.status).toBe(500)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('respeita o limite de rodadas', async () => {
    const fetchMock = mockLlamaResponses(
      toolCallResponse('calculator', JSON.stringify({ expression: '1 + 1' })),
      toolCallResponse('calculator', JSON.stringify({ expression: '1 + 1' })),
      finalResponse('resposta final')
    )

    const response = await chatCompletionWithTools(
      { messages: [], tools: getBuiltinSchemas() },
      undefined,
      undefined,
      2
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const [, thirdInit] = fetchMock.mock.calls[2]
    const thirdBody = JSON.parse(thirdInit.body)

    expect(thirdBody).not.toHaveProperty('tools')
    expect(thirdBody.messages.at(-1).role).toBe('user')
  })

  it('retorna direto quando o modelo não chama tools', async () => {
    const fetchMock = mockLlamaResponses(finalResponse('oi'))

    const response = await chatCompletionWithTools(
      { messages: [] },
      undefined,
      undefined,
      1
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('continueToolStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

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
    return new Response(stream, { status: 200 })
  }

  const toolCallEvents = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"calculator","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"expression\\":\\"1+1\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  ]

  const finalEvents = [
    'data: {"choices":[{"delta":{"content":"resposta final"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]

  it('faz streaming dos tool_calls e continua até a resposta final', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sseResponse(...finalEvents))
    vi.stubGlobal('fetch', fetchMock)

    const written: string[] = []

    await continueToolStream(
      sseResponse(...toolCallEvents),
      { messages: [], tools: getBuiltinSchemas() },
      undefined,
      undefined,
      2,
      (text) => written.push(text)
    )

    const output = written.join('')
    expect(output).toContain('calculator')
    expect(output).toContain('resposta final')
    expect(output).toContain('data: [DONE]')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body).messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '2',
    })
  })

  it('consome a resposta final quando o limite de rounds é atingido', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(...finalEvents))
    vi.stubGlobal('fetch', fetchMock)

    const written: string[] = []

    await continueToolStream(
      sseResponse(...toolCallEvents),
      { messages: [], tools: getBuiltinSchemas() },
      undefined,
      undefined,
      1,
      (text) => written.push(text)
    )

    expect(written.join('')).toContain('resposta final')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).not.toHaveProperty('tools')
  })
})
