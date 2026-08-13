import { env } from '../config/env.js'

export async function chatCompletion(
  body: any,
  thinking?: boolean,
  stateless?: boolean,
) {
  if (typeof thinking === 'boolean') {
    body.chat_template_kwargs = {
      ...(body.chat_template_kwargs ?? {}),
      enable_thinking: body.thinking,
    }

    if (!body.thinking) {
      body.reasoning_effort = 'none'
    }

    delete body.thinking
  }

  if (stateless === true && Array.isArray(body.messages)) {
    body.messages = body.messages.slice(-1)
  }

  const response = await fetch(
    `${env.llamaUrl}/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )

  return response
}