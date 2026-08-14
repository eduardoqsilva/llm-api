import { randomUUID } from 'node:crypto'
import type { ToolHandler } from './types.js'

export const randomUuidHandler: ToolHandler = async (): Promise<string> =>
  randomUUID()
