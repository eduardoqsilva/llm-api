import 'dotenv/config'

export const env = {
  port: Number(process.env.PORT ?? 3000),

  apiToken: process.env.API_TOKEN ?? '',

  llamaUrl: process.env.LLAMA_URL ?? 'http://localhost:8080',

  bodyLimit: Number(process.env.BODY_LIMIT ?? 25 * 1024 * 1024),

  maxToolRounds: Number(process.env.MAX_TOOL_ROUNDS ?? 8),

  toolTimeoutMs: Number(process.env.TOOL_TIMEOUT_MS ?? 15000),

  searchResults: Number(process.env.SEARCH_RESULTS ?? 5),

  maxPageChars: Number(process.env.MAX_PAGE_CHARS ?? 8000),
}

if (!env.apiToken) {
  throw new Error('API_TOKEN is required')
}
