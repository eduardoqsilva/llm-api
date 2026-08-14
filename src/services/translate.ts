import { env } from '../config/env.js'
import { splitIntoChunks } from './chunkText.js'
import { chatCompletion } from './llama.js'

type TranslateInput = {
  text: string
  to: string
  from?: string
  thinking?: boolean
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
    `Please translate the following ${source} text into ${target}:`,
  ].join(' ')

  return [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ]
}

async function translateChunk(input: TranslateInput): Promise<string> {
  const response = await chatCompletion(
    {
      messages: buildMessages(input),
      temperature: 0.3,
    },
    input.thinking ?? false
  )

  const data = await response.json()

  if (!response.ok) {
    throw new TranslateError(response.status, data)
  }

  const content = data?.choices?.[0]?.message?.content

  if (typeof content !== 'string') {
    throw new TranslateError(502, {
      error: {
        message: 'Unexpected response from the model.',
        type: 'server_error',
      },
    })
  }

  return content
}

export async function translate(
  input: TranslateInput
): Promise<TranslateResult> {
  try {
    const chunks = splitIntoChunks(input.text, env.translateChunkChars)
    const translated: string[] = []

    for (const chunk of chunks) {
      translated.push(await translateChunk({ ...input, text: chunk }))
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
    if (error instanceof TranslateError) {
      return { ok: false, status: error.status, body: error.body }
    }
    throw error
  }
}
