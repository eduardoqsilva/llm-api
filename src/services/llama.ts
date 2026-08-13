import { env } from '../config/env.js'

export async function chatCompletion(body: any, thinking?: boolean) {
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