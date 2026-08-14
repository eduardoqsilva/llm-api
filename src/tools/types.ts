export type ToolParameters = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export type ToolSchema = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ToolParameters
  }
}

export type ToolArgs = Record<string, unknown>

export type ToolHandler = (args: ToolArgs) => Promise<string>

export type Tool = {
  schema: ToolSchema
  handler: ToolHandler
}
