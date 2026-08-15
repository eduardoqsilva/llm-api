import { env } from '../config/env.js'
import { splitIntoChunks } from './chunkText.js'
import { chatCompletion } from './llama.js'

type TranslateInput = {
  text: string
  to: string
  from?: string
  thinking?: boolean
}

export type TranslateStreamEvent =
  | { type: 'start'; chunks: number }
  | { type: 'chunk_start'; index: number; chunks: number }
  | { type: 'chunk_retry'; index: number; attempt: number }
  | { type: 'delta'; text: string }
  | { type: 'chunk_end'; index: number; chunks: number }

type TranslateOptions = {
  stream?: boolean
  onEvent?: (event: TranslateStreamEvent) => void
  aborted?: () => boolean
}

export type TranslateResult =
  | {
      ok: true
      status: number
      body: { text: string; from?: string; to: string }
    }
  | { ok: false; status: number; body: unknown }

export class TranslateError extends Error {
  status: number
  body: unknown

  constructor(status: number, body: unknown) {
    super('Translation failed')
    this.status = status
    this.body = body
  }
}

export class TranslateAbortError extends Error {
  constructor() {
    super('Translation aborted')
  }
}

function buildMessages({ text, to, from }: TranslateInput) {
  const source = from?.trim() || 'auto'
  const target = to.trim()

  const system = [
    `You are a professional ${source} to ${target} translator.`,
    'Your goal is to accurately convey the meaning and nuances of the',
    `original ${source} text while adhering to ${target} grammar,`,
    'vocabulary, and cultural sensitivities.',
    `Produce only the ${target} translation, without any additional`,
    'explanations or commentary.',
    `Preserve the original formatting, line breaks, whitespace, Markdown syntax,`,
    `code blocks, lists, links, images, and other structural elements exactly.`,
    `Please translate the following ${source} text into ${target}:`,
  ].join(' ')

  return [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ]
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function isRetryableError(error: unknown): boolean {
  if (error instanceof TranslateError) {
    return error.status >= 500
  }

  return true
}

/**
 * Preserva exatamente o whitespace das bordas do chunk original.
 *
 * Isso é importante porque modelos pequenos podem devolver:
 *
 *   "texto traduzido"
 *
 * quando o chunk original era:
 *
 *   "texto traduzido\n"
 *
 * Sem essa correção, o próximo chunk seria concatenado imediatamente:
 *
 *   "texto traduzidoOutro texto"
 *
 * Também preservamos espaços de indentação no início do chunk.
 */
function preserveChunkBoundaries(source: string, translated: string): string {
  if (source.length === 0) {
    return translated
  }

  const leadingMatch = source.match(/^\s+/)
  const trailingMatch = source.match(/\s+$/)

  const leading = leadingMatch?.[0] ?? ''
  const trailing = trailingMatch?.[0] ?? ''

  // Chunk composto apenas de whitespace.
  if (source.trim().length === 0) {
    return source
  }

  // Removemos sempre o whitespace das bordas produzido pelo modelo e
  // restauramos exatamente o do chunk original. O whitespace interno
  // permanece intocado.
  const core = translated.replace(/^\s+/, '').replace(/\s+$/, '')

  return `${leading}${core}${trailing}`
}

async function consumeStreamedContent(
  response: Response,
  onDelta: (text: string) => void
): Promise<string> {
  const reader = response.body?.getReader()

  if (!reader) {
    throw new TranslateError(502, {
      error: {
        message: 'Unexpected response from the model.',
        type: 'server_error',
      },
    })
  }

  const decoder = new TextDecoder()

  let buffer = ''
  let full = ''

  const handleEvent = (eventText: string) => {
    const dataLine = eventText
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')

    if (!dataLine || dataLine === '[DONE]') {
      return
    }

    try {
      const parsed = JSON.parse(dataLine) as {
        choices?: Array<{
          delta?: {
            content?: string
          }
        }>
      }

      const content = parsed.choices?.[0]?.delta?.content

      if (typeof content === 'string' && content.length > 0) {
        full += content
        onDelta(content)
      }
    } catch {
      // Ignora eventos SSE inválidos.
    }
  }

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

        handleEvent(event)

        separatorIndex = buffer.indexOf('\n\n')
      }
    }

    // Finaliza qualquer evento incompleto que tenha ficado no buffer.
    if (buffer.trim()) {
      handleEvent(buffer)
    }
  } finally {
    reader.releaseLock()
  }

  return full
}

async function translateChunkOnce(
  input: TranslateInput,
  options: TranslateOptions
): Promise<string> {
  const response = await chatCompletion(
    {
      messages: buildMessages(input),
      temperature: 0.3,
      ...(options.stream ? { stream: true } : {}),
    },
    input.thinking ?? false
  )

  if (!response.ok) {
    const text = await response.text().catch(() => null)

    let data: unknown = text

    if (typeof text === 'string') {
      try {
        data = JSON.parse(text)
      } catch {
        // Mantém texto bruto como body.
      }
    }

    throw new TranslateError(response.status, data)
  }

  if (options.stream) {
    const rawContent = await consumeStreamedContent(response, (text) => {
      options.onEvent?.({
        type: 'delta',
        text,
      })
    })

    if (!rawContent) {
      throw new TranslateError(502, {
        error: {
          message: 'Unexpected response from the model.',
          type: 'server_error',
        },
      })
    }

    const content = preserveChunkBoundaries(input.text, rawContent)

    return content
  }

  const data = await response.json()

  const content = data?.choices?.[0]?.message?.content

  if (typeof content !== 'string') {
    throw new TranslateError(502, {
      error: {
        message: 'Unexpected response from the model.',
        type: 'server_error',
      },
    })
  }

  return preserveChunkBoundaries(input.text, content)
}

async function translateChunk(
  input: TranslateInput,
  index: number,
  options: TranslateOptions
): Promise<string> {
  const maxAttempts = Math.max(1, env.translateChunkRetries)

  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.aborted?.()) {
      throw new TranslateAbortError()
    }

    try {
      return await translateChunkOnce(input, options)
    } catch (error) {
      lastError = error

      if (!isRetryableError(error) || attempt >= maxAttempts) {
        throw error
      }

      options.onEvent?.({
        type: 'chunk_retry',
        index,
        attempt,
      })

      await delay(250 * attempt)
    }
  }

  throw lastError
}

export async function translate(
  input: TranslateInput,
  options: TranslateOptions = {}
): Promise<TranslateResult> {
  const translated: string[] = []

  try {
    const chunks = splitIntoChunks(input.text, env.translateChunkChars)

    const total = chunks.length

    options.onEvent?.({
      type: 'start',
      chunks: total,
    })

    for (let i = 0; i < total; i++) {
      if (options.aborted?.()) {
        throw new TranslateAbortError()
      }

      options.onEvent?.({
        type: 'chunk_start',
        index: i,
        chunks: total,
      })

      const content = await translateChunk(
        {
          ...input,
          text: chunks[i],
        },
        i,
        options
      )

      translated.push(content)

      options.onEvent?.({
        type: 'chunk_end',
        index: i,
        chunks: total,
      })
    }

    return {
      ok: true,
      status: 200,
      body: {
        text: translated.join('').trim(),
        from: input.from,
        to: input.to.trim(),
      },
    }
  } catch (error) {
    if (error instanceof TranslateAbortError) {
      throw error
    }

    if (error instanceof TranslateError) {
      const partial = translated.join('').trim()

      let body = error.body

      if (partial && typeof body === 'object' && body !== null) {
        body = {
          ...(body as Record<string, unknown>),
          partial,
        }
      }

      return {
        ok: false,
        status: error.status,
        body,
      }
    }

    throw error
  }
}
