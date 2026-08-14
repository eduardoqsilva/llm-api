import { env } from '../config/env.js'
import { extractReadableText } from './reader.js'
import type { ToolArgs, ToolHandler } from './types.js'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const MAX_BYTES = 5 * 1024 * 1024

function isHtml(contentType: string, body: string): boolean {
  return (
    contentType.includes('text/html') ||
    /<!doctype\s+html|<html/i.test(body.slice(0, 2048))
  )
}

function normalizeCharset(charset: string): string {
  const value = charset.trim().toLowerCase()
  if (value === 'iso-8859-1' || value === 'latin1' || value === 'latin-1') {
    return 'windows-1252'
  }
  return value
}

function detectCharset(contentType: string, head: string): string {
  const headerMatch = /charset=([\w.-]+)/i.exec(contentType)
  if (headerMatch) return normalizeCharset(headerMatch[1])
  const metaCharset = /<meta[^>]+charset=["']?([\w.-]+)/i.exec(head)
  if (metaCharset) return normalizeCharset(metaCharset[1])
  const httpEquiv =
    /<meta[^>]+http-equiv=["']content-type["'][^>]+content=["'][^"']*charset=([\w.-]+)/i.exec(
      head
    )
  if (httpEquiv) return normalizeCharset(httpEquiv[1])
  return 'utf-8'
}

function decodeBody(contentType: string, buffer: ArrayBuffer): string {
  const head = new TextDecoder('latin1').decode(buffer.slice(0, 4096))
  const charset = detectCharset(contentType, head)
  try {
    return new TextDecoder(normalizeCharset(charset)).decode(buffer)
  } catch {
    return new TextDecoder('utf-8').decode(buffer)
  }
}

export async function fetchPageText(
  url: string,
  maxChars: number
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,text/plain;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(env.toolTimeoutMs),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ao abrir ${url}`)
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_BYTES) {
    throw new Error(`página muito grande (${contentLength} bytes)`)
  }

  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(`página muito grande (${buffer.byteLength} bytes)`)
  }

  const contentType = response.headers.get('content-type') ?? ''
  const body = decodeBody(contentType, buffer)

  const text = isHtml(contentType, body) ? extractReadableText(body, url) : body
  const clean = text.replace(/\s+/g, ' ').trim()

  if (clean.length <= maxChars) {
    return clean
  }
  return `${clean.slice(0, maxChars)}\n…`
}

export const fetchPageHandler: ToolHandler = async (
  args: ToolArgs
): Promise<string> => {
  const rawUrl = String(args.url ?? '').trim()

  if (!/^https?:\/\//i.test(rawUrl)) {
    return 'Erro: informe uma URL válida começando com http:// ou https://.'
  }

  const requested = Number(args.max_chars)
  const maxChars = Number.isFinite(requested)
    ? Math.min(Math.max(Math.round(requested), 500), 20000)
    : env.maxPageChars

  try {
    return await fetchPageText(rawUrl, maxChars)
  } catch (error) {
    return `Erro ao abrir a página: ${error instanceof Error ? error.message : String(error)}`
  }
}
