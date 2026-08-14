import { load } from 'cheerio'

interface HtmlNode {
  type: string
  name?: string
  data?: string
  children?: HtmlNode[]
  attribs?: Record<string, string>
}

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'div',
  'dl',
  'dt',
  'dd',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'tr',
  'ul',
])

const NOISE_WORDS = [
  'ad',
  'ads',
  'advert',
  'adverts',
  'advertisement',
  'advertising',
  'banner',
  'comment',
  'comments',
  'consent',
  'cookie',
  'cookiewall',
  'disqus',
  'login',
  'menu',
  'modal',
  'nav',
  'navigation',
  'newsletter',
  'overlay',
  'pagination',
  'popover',
  'popup',
  'recommend',
  'register',
  'related',
  'share',
  'sharing',
  'sidebar',
  'signin',
  'signup',
  'social',
  'socials',
  'sponsor',
  'sponsored',
  'subscribe',
  'subscription',
  'widget',
  'widgets',
]

function normalizeSegment(segment: string): string {
  return segment
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[ \t]+\|(?=\n)/g, '')
    .replace(/^[ \t]*\| ?/gm, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function collectText(nodes: HtmlNode[] | undefined): string {
  let result = ''
  for (const node of nodes ?? []) {
    if (node.type === 'text') {
      result += node.data ?? ''
    } else if (node.type === 'tag' && node.children) {
      result += collectText(node.children)
    }
  }
  return result
}

export function extractReadableText(html: string, baseUrl: string): string {
  const $ = load(html, { scriptingEnabled: false })

  $(
    'script, style, noscript, template, iframe, frame, frameset, object, embed, svg, canvas, math, form, input, button, select, textarea, option, audio, video, source, track, picture, dialog, link, meta, base, map'
  ).remove()
  $('nav, aside, footer').remove()
  $('header')
    .filter(function () {
      return !$(this).find('h1, h2, h3, h4, h5, h6, p').length
    })
    .remove()
  $(
    '[hidden], [aria-hidden="true"], [role="presentation"], [role="banner"], [role="contentinfo"], [role="navigation"], [role="complementary"], [role="dialog"], [tabindex="-1"]'
  ).remove()
  $('[class], [id]')
    .filter(function () {
      const tokens = `${$(this).attr('class') ?? ''} ${
        $(this).attr('id') ?? ''
      }`.toLowerCase()
      return NOISE_WORDS.some((word) => tokens.split(/[\s_-]+/).includes(word))
    })
    .remove()

  const out: string[] = []

  const walk = (node: HtmlNode | undefined): void => {
    if (!node) return
    if (node.type === 'text') {
      out.push(node.data ?? '')
      return
    }
    if (node.type !== 'tag' || !node.name) return

    const name = node.name.toLowerCase()
    const children = node.children

    if (name === 'br') {
      out.push('\n')
      return
    }
    if (name === 'img') {
      const alt = node.attribs?.alt?.trim()
      out.push(alt ? `[${alt}]` : '[imagem]')
      return
    }
    if (name === 'pre') {
      out.push('\n\n```\n')
      out.push(collectText(children))
      out.push('\n```\n\n')
      return
    }
    if (name === 'code') {
      out.push('`')
      out.push(collectText(children).trim())
      out.push('`')
      return
    }
    if (name === 'a') {
      const start = out.length
      for (const child of children ?? []) walk(child)
      const href = node.attribs?.href?.trim()
      if (href) {
        try {
          const resolved = new URL(href, baseUrl)
          if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
            if (out.slice(start).join('').trim()) {
              out.push(` (${resolved.href})`)
            }
          }
        } catch {
          // URL inválida ou âncora: ignora
        }
      }
      return
    }
    if (/^h[1-6]$/.test(name)) {
      const level = Number(name[1])
      out.push(`\n${'#'.repeat(level)} `)
      for (const child of children ?? []) walk(child)
      out.push('\n\n')
      return
    }
    if (name === 'li') {
      out.push('\n- ')
      for (const child of children ?? []) walk(child)
      out.push('\n')
      return
    }
    if (name === 'blockquote') {
      out.push('\n> ')
      for (const child of children ?? []) walk(child)
      out.push('\n\n')
      return
    }
    if (name === 'td' || name === 'th') {
      out.push(' | ')
      for (const child of children ?? []) walk(child)
      return
    }

    const isBlock = BLOCK_TAGS.has(name)
    if (isBlock) out.push('\n\n')
    for (const child of children ?? []) walk(child)
    if (isBlock) out.push('\n\n')
  }

  for (const child of $('body').get(0)?.children ?? []) {
    walk(child as HtmlNode)
  }

  const segments = out.join('').split('```')
  let result = normalizeSegment(segments[0] ?? '')
  for (let i = 1; i < segments.length; i++) {
    if (i % 2 === 1) {
      result = `${result}\`\`\`${segments[i]}\`\`\``
    } else {
      result = `${result}${normalizeSegment(segments[i])}`
    }
  }
  return result.trim()
}
