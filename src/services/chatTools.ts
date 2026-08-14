import { randomUUID } from 'node:crypto'
import { executeTool, getBuiltinSchemas } from '../tools/index.js'
import { chatCompletion } from './llama.js'

type ToolCall = {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

type DeltaToolCall = {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

type ToolCallMap = Map<number, ToolCall>

type PreparedBody = {
  body: Record<string, unknown>
  toolsEnabled: boolean
  maxRounds: number
}

export function clampRounds(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(Math.max(Math.round(parsed), 1), 20)
}

export function prepareToolBody(
  raw: Record<string, unknown>,
  maxToolRounds: number
): PreparedBody {
  const toolsEnabled = raw.enable_tools === true || Array.isArray(raw.tools)

  if (!toolsEnabled) {
    return { body: raw, toolsEnabled: false, maxRounds: 1 }
  }

  const body = { ...raw }
  if (body.enable_tools === true) {
    body.tools = getBuiltinSchemas()
  }
  delete body.enable_tools
  delete body.max_tool_rounds
  delete body.stateless

  return {
    body,
    toolsEnabled: true,
    maxRounds: clampRounds(raw.max_tool_rounds, maxToolRounds),
  }
}

function parseArgs(raw?: string): Record<string, unknown> {
  if (!raw) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

async function appendToolResults(
  messages: unknown,
  assistantMessage: Record<string, unknown>,
  toolCalls: ToolCall[]
): Promise<unknown[]> {
  const base = Array.isArray(messages) ? messages : []

  const normalized = toolCalls.map((call) => ({
    id: call.id ?? `call_${randomUUID()}`,
    type: call.type ?? 'function',
    function: {
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '',
    },
  }))

  const assistant: Record<string, unknown> = {
    role: 'assistant',
    content:
      typeof assistantMessage.content === 'string'
        ? assistantMessage.content
        : '',
    tool_calls: normalized,
  }

  const next = [...base, assistant]

  for (const call of normalized) {
    const args = parseArgs(call.function.arguments)
    const content = await executeTool(call.function.name, args)
    next.push({ role: 'tool', tool_call_id: call.id, content })
  }

  return next
}

function buildFinalBody(
  body: Record<string, unknown>,
  messages: unknown
): Record<string, unknown> {
  const final: Record<string, unknown> = {
    ...body,
    messages: [
      ...(Array.isArray(messages) ? messages : []),
      {
        role: 'user',
        content:
          'Você atingiu o limite de chamadas de ferramentas. Responda com a melhor resposta possível usando as informações já obtidas.',
      },
    ],
  }
  delete final.tools
  return final
}

export async function chatCompletionWithTools(
  body: Record<string, unknown>,
  thinking?: boolean,
  stateless?: boolean,
  maxRounds?: number
): Promise<Response> {
  let current = { ...body }
  const rounds = maxRounds ?? 1
  const effectiveStateless = Array.isArray(body.tools) ? undefined : stateless

  for (let round = 0; round < rounds; round++) {
    const response = await chatCompletion(current, thinking, effectiveStateless)
    if (!response.ok) {
      return response
    }

    const data = (await response
      .clone()
      .json()
      .catch(() => null)) as {
      choices?: Array<{ message?: Record<string, unknown> }>
    } | null

    const message = data?.choices?.[0]?.message
    const toolCalls: ToolCall[] = Array.isArray(message?.tool_calls)
      ? (message.tool_calls as ToolCall[])
      : []

    if (toolCalls.length === 0) {
      return response
    }

    const messages = await appendToolResults(
      current.messages,
      message ?? {},
      toolCalls
    )
    current = { ...current, messages }
  }

  const final = buildFinalBody(current, current.messages)
  return chatCompletion(final, thinking)
}

export async function continueToolStream(
  firstResponse: Response,
  body: Record<string, unknown>,
  thinking: boolean | undefined,
  stateless: boolean | undefined,
  maxRounds: number,
  write: (text: string) => void
): Promise<void> {
  let current = { ...body }
  let response = firstResponse
  const rounds = maxRounds ?? 1
  const effectiveStateless = Array.isArray(body.tools) ? undefined : stateless

  let round = 0

  while (true) {
    if (!response.ok || !response.body) {
      const errorBody = await response.text()
      write(errorBody)
      return
    }

    const { toolCalls } = await consumeSse(response, write)

    if (toolCalls.length === 0) {
      return
    }

    round++

    if (round > rounds) {
      return
    }

    if (round === rounds) {
      const final = buildFinalBody(current, current.messages)
      response = await chatCompletion(final, thinking)
      continue
    }

    const messages = await appendToolResults(
      current.messages,
      { role: 'assistant', content: '' },
      toolCalls
    )
    current = { ...current, messages }
    response = await chatCompletion(current, thinking, effectiveStateless)
  }
}

function parseSseData(line: string): {
  done: boolean
  delta?: { tool_calls?: DeltaToolCall[] }
} {
  if (line === '[DONE]') {
    return { done: true }
  }
  try {
    const parsed = JSON.parse(line) as {
      choices?: Array<{ delta?: { tool_calls?: DeltaToolCall[] } }>
    }
    return { done: false, delta: parsed.choices?.[0]?.delta }
  } catch {
    return { done: false }
  }
}

function handleEvent(
  eventText: string,
  acc: ToolCallMap,
  emit: (text: string) => void
): void {
  const trimmed = eventText.trim()
  if (!trimmed) {
    return
  }

  const dataLine = trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')

  if (!dataLine) {
    return
  }

  const parsed = parseSseData(dataLine)

  if (parsed.done) {
    if (acc.size === 0) {
      emit('data: [DONE]\n\n')
    }
    return
  }

  emit(`${trimmed}\n\n`)

  if (!parsed.delta?.tool_calls) {
    return
  }

  for (const toolCall of parsed.delta.tool_calls) {
    const index = typeof toolCall.index === 'number' ? toolCall.index : 0
    const existing = acc.get(index)
    const entry: ToolCall = existing ?? {
      id: toolCall.id ?? '',
      type: toolCall.type ?? 'function',
      function: { name: '', arguments: '' },
    }
    const fn = entry.function ?? { name: '', arguments: '' }

    if (toolCall.id) {
      entry.id = toolCall.id
    }
    if (toolCall.type) {
      entry.type = toolCall.type
    }
    if (toolCall.function?.name) {
      fn.name += toolCall.function.name
    }
    if (toolCall.function?.arguments) {
      fn.arguments += toolCall.function.arguments
    }

    entry.function = fn
    acc.set(index, entry)
  }
}

async function consumeSse(
  response: Response,
  emit: (text: string) => void
): Promise<{ toolCalls: ToolCall[] }> {
  const reader = response.body?.getReader()
  if (!reader) {
    return { toolCalls: [] }
  }

  const acc: ToolCallMap = new Map()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')

      let separatorIndex = buffer.indexOf('\n\n')
      while (separatorIndex !== -1) {
        const event = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        handleEvent(event, acc, emit)
        separatorIndex = buffer.indexOf('\n\n')
      }
    }

    if (buffer.trim()) {
      handleEvent(buffer, acc, emit)
    }
  } finally {
    reader.releaseLock()
  }

  const toolCalls = [...acc.values()]
    .filter((call) => call.function?.name || call.function?.arguments)
    .map((call) => ({
      id: call.id,
      type: call.type ?? 'function',
      function: {
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? '',
      },
    }))

  return { toolCalls }
}
