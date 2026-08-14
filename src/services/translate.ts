import { chatCompletion } from './llama.js'

type TranslateInput = {
  text: string
  to: string
  from?: string
  thinking?: boolean
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

export async function translate(input: TranslateInput) {
  const response = await chatCompletion(
    {
      messages: buildMessages(input),
      temperature: 0.3,
    },
    input.thinking ?? false
  )

  return response
}
