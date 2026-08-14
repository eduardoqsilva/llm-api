import { env } from '../config/env.js'
import { decodeHtml } from './html.js'
import type { ToolArgs, ToolHandler } from './types.js'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const DDG_URL = 'https://html.duckduckgo.com/html/'

type SearchResult = {
  title: string
  url: string
  snippet: string
}

const TITLE_RE = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g

const SNIPPET_RE = /class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g

function decodeEntities(value: string): string {
  return decodeHtml(
    value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
  )
}

function extractUrl(raw: string): string {
  const decoded = decodeEntities(raw)
  const uddg = /[?&]uddg=([^&]+)/.exec(decoded)
  if (uddg?.[1]) {
    try {
      return decodeURIComponent(uddg[1])
    } catch {
      return decoded
    }
  }
  return decoded
}

function parseResults(html: string, maxResults: number): SearchResult[] {
  const titles = [...html.matchAll(TITLE_RE)]
  const snippets = [...html.matchAll(SNIPPET_RE)]
  const results: SearchResult[] = []

  for (
    let index = 0;
    index < titles.length && results.length < maxResults;
    index++
  ) {
    const [, rawUrl, rawTitle] = titles[index]
    const title = decodeEntities(rawTitle ?? '').trim()
    const url = extractUrl(rawUrl ?? '')
    const snippet = decodeEntities(snippets[index]?.[1] ?? '').trim()

    if (!title || !url) {
      continue
    }

    results.push({ title, url, snippet })
  }

  return results
}

export async function searchWeb(
  query: string,
  maxResults: number
): Promise<SearchResult[]> {
  const url = `${DDG_URL}?q=${encodeURIComponent(query)}`

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html',
    },
    signal: AbortSignal.timeout(env.toolTimeoutMs),
  })

  if (!response.ok) {
    throw new Error(`DuckDuckGo retornou HTTP ${response.status}`)
  }

  const html = await response.text()
  return parseResults(html, maxResults)
}

export const webSearchHandler: ToolHandler = async (
  args: ToolArgs
): Promise<string> => {
  const query = String(args.query ?? '').trim()

  if (!query) {
    return 'Erro: o parâmetro "query" é obrigatório.'
  }

  const requested = Number(args.max_results)
  const maxResults = Number.isFinite(requested)
    ? Math.min(Math.max(Math.round(requested), 1), 10)
    : env.searchResults

  try {
    const results = await searchWeb(query, maxResults)

    if (results.length === 0) {
      return 'Nenhum resultado encontrado.'
    }

    return results
      .map(
        (result, index) =>
          `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`
      )
      .join('\n')
  } catch (error) {
    return `Erro na busca: ${error instanceof Error ? error.message : String(error)}`
  }
}
