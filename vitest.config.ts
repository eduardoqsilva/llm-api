import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      API_TOKEN: 'test-token',
      LLAMA_URL: 'http://llama:8080',
    },
  },
})
