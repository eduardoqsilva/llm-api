import 'dotenv/config'

export const env = {
  port: Number(process.env.PORT ?? 3000),

  apiToken: process.env.API_TOKEN ?? '',

  llamaUrl: process.env.LLAMA_URL ?? 'http://localhost:8080',

  bodyLimit: Number(process.env.BODY_LIMIT ?? 25 * 1024 * 1024),
}

if (!env.apiToken) {
  throw new Error('API_TOKEN is required')
}