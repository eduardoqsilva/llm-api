import { calculatorHandler } from './calculator.js'
import { fetchPageHandler } from './fetchPage.js'
import { getCurrentTimeHandler } from './getCurrentTime.js'
import { randomUuidHandler } from './randomUuid.js'
import type { Tool, ToolArgs } from './types.js'
import { webSearchHandler } from './webSearch.js'

const tools: Tool[] = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          'Busca na web usando o DuckDuckGo e retorna os principais resultados (título, URL e resumo). Use para informações recentes ou fatos que você não conhece.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Termo de busca.' },
            max_results: {
              type: 'integer',
              description: 'Número máximo de resultados (1-10). Opcional.',
            },
          },
          required: ['query'],
        },
      },
    },
    handler: webSearchHandler,
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'fetch_page',
        description:
          'Abre o conteúdo de uma página da web (URL) e retorna o texto legível extraído. Use quando precisar do conteúdo completo de uma página encontrada na busca.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'URL completa (http/https) da página.',
            },
            max_chars: {
              type: 'integer',
              description:
                'Máximo de caracteres a retornar (500-20000). Opcional.',
            },
          },
          required: ['url'],
        },
      },
    },
    handler: fetchPageHandler,
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'calculator',
        description:
          'Calculadora avançada. Avalia uma expressão matemática com +, -, *, /, % (resto), ^ (potência), parênteses, funções (sin, cos, tan, asin, acos, atan, ln, log, sqrt, cbrt, abs, round, floor, ceil, min, max) e constantes (pi, e). Ex.: "2 ^ 10", "sqrt(144) + pi".',
        parameters: {
          type: 'object',
          properties: {
            expression: {
              type: 'string',
              description: 'Expressão matemática a avaliar.',
            },
          },
          required: ['expression'],
        },
      },
    },
    handler: calculatorHandler,
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'get_current_time',
        description:
          'Retorna a data e a hora atuais. Por padrão usa o fuso de Brasília (America/Sao_Paulo). Opcionalmente informe "timezone" (IANA, ex.: "America/New_York") para usar outro fuso horário.',
        parameters: {
          type: 'object',
          properties: {
            timezone: {
              type: 'string',
              description:
                "Fuso horário IANA (ex.: 'America/Sao_Paulo', 'America/New_York', 'Europe/Lisbon'). Opcional; padrão 'America/Sao_Paulo'.",
            },
          },
        },
      },
    },
    handler: getCurrentTimeHandler,
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'random_uuid',
        description: 'Gera um UUID v4 aleatório.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    handler: randomUuidHandler,
  },
]

export function getBuiltinSchemas(): Tool['schema'][] {
  return tools.map((tool) => tool.schema)
}

export async function executeTool(
  name: string,
  args: ToolArgs
): Promise<string> {
  const tool = tools.find(
    (candidate) => candidate.schema.function.name === name
  )

  if (!tool) {
    return `Erro: a tool "${name}" não está disponível neste servidor.`
  }

  try {
    const result = await tool.handler(args ?? {})
    return typeof result === 'string' ? result : JSON.stringify(result)
  } catch (error) {
    return `Erro ao executar a tool "${name}": ${
      error instanceof Error ? error.message : String(error)
    }`
  }
}
