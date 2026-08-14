import { env } from '../config/env.js'

type ChatBody = {
  thinking?: boolean
  chat_template_kwargs?: Record<string, unknown>
  reasoning_effort?: string
  messages?: unknown[]
  [key: string]: unknown
}

export async function chatCompletion(
  body: ChatBody,
  thinking?: boolean,
  stateless?: boolean
) {
  if (typeof thinking === 'boolean') {
    body.chat_template_kwargs = {
      ...(body.chat_template_kwargs ?? {}),
      enable_thinking: thinking,
    }

    if (!thinking) {
      body.reasoning_effort = 'none'
    }

    delete body.thinking
  }

  if (stateless === true && Array.isArray(body.messages)) {
    body.messages = body.messages.slice(-1)
  }

  const response = await fetch(`${env.llamaUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  return response
}
