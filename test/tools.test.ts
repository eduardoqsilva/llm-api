import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateExpression, formatNumber } from '../src/tools/calculator.js'
import { fetchPageText } from '../src/tools/fetchPage.js'
import {
  DEFAULT_TIMEZONE,
  getCurrentTimeHandler,
} from '../src/tools/getCurrentTime.js'
import { executeTool, getBuiltinSchemas } from '../src/tools/index.js'
import { extractReadableText } from '../src/tools/reader.js'
import { searchWeb } from '../src/tools/webSearch.js'

describe('calculator', () => {
  it('avalia operações básicas e precedência', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14)
    expect(evaluateExpression('(2 + 3) * 4')).toBe(20)
    expect(evaluateExpression('10 / 4')).toBe(2.5)
    expect(evaluateExpression('10 % 3')).toBe(1)
    expect(evaluateExpression('2 ^ 10')).toBe(1024)
  })

  it('suporta unário e potência direita-associativa', () => {
    expect(evaluateExpression('-2 ^ 2')).toBe(-4)
    expect(evaluateExpression('2 ^ 3 ^ 2')).toBe(512)
    expect(evaluateExpression('+5')).toBe(5)
  })

  it('suporta funções e constantes', () => {
    expect(evaluateExpression('sqrt(144)')).toBe(12)
    expect(evaluateExpression('abs(-7)')).toBe(7)
    expect(evaluateExpression('round(3.7)')).toBe(4)
    expect(evaluateExpression('min(3, 1, 2)')).toBe(1)
    expect(evaluateExpression('max(3, 1, 2)')).toBe(3)
    expect(evaluateExpression('pi')).toBeCloseTo(Math.PI)
    expect(evaluateExpression('ln(e)')).toBeCloseTo(1)
  })

  it('lança erros para expressões inválidas', () => {
    expect(() => evaluateExpression('')).toThrow()
    expect(() => evaluateExpression('2 +')).toThrow()
    expect(() => evaluateExpression('2 $ 3')).toThrow()
    expect(() => evaluateExpression('(2 + 3')).toThrow()
    expect(() => evaluateExpression('1/0')).toThrow()
    expect(() => evaluateExpression('foo(2)')).toThrow()
  })

  it('formata números grandes e inteiros', () => {
    expect(formatNumber(4)).toBe('4')
    expect(formatNumber(1 / 3)).toBe('0.3333333333')
  })
})

describe('getBuiltinSchemas', () => {
  it('expõe as tools embutidas em formato OpenAI', () => {
    const schemas = getBuiltinSchemas()
    const names = schemas.map((schema) => schema.function.name)

    expect(names).toEqual(
      expect.arrayContaining([
        'web_search',
        'fetch_page',
        'calculator',
        'get_current_time',
        'random_uuid',
      ])
    )
  })
})

describe('getCurrentTimeHandler', () => {
  it('usa Brasília por padrão com offset GMT-03:00', async () => {
    const result = JSON.parse(await getCurrentTimeHandler({}))
    expect(result.timezone).toBe(DEFAULT_TIMEZONE)
    expect(result.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(result.local).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT-03:00$/
    )
  })

  it('aceita um fuso horário IANA via parâmetro', async () => {
    const result = JSON.parse(
      await getCurrentTimeHandler({ timezone: 'America/New_York' })
    )
    expect(result.timezone).toBe('America/New_York')
    expect(result.local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT/)
  })

  it('retorna erro para fuso inválido', async () => {
    const result = await executeTool('get_current_time', {
      timezone: 'Fuso/Invalido',
    })
    expect(result).toContain('Erro')
  })
})

describe('executeTool', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('executa a calculadora', async () => {
    await expect(
      executeTool('calculator', { expression: '2 + 2' })
    ).resolves.toBe('4')
  })

  it('retorna erro para tool desconhecida', async () => {
    const result = await executeTool('nao_existe', {})
    expect(result).toContain('não está disponível')
  })

  it('retorna erro do handler como resultado', async () => {
    const result = await executeTool('calculator', { expression: '1/0' })
    expect(result).toContain('Erro')
  })
})

describe('searchWeb', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('faz scraping do DuckDuckGo e decodifica resultados', async () => {
    const html = `
      <div class="result">
        <a rel="nofollow" class="result__a"
          href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=x">Example &amp; Page</a>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Some snippet &amp; text.</a>
      </div>
    `
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      )
    )

    const results = await searchWeb('exemplo', 1)

    expect(results).toEqual([
      {
        title: 'Example & Page',
        url: 'https://example.com/page',
        snippet: 'Some snippet & text.',
      },
    ])
  })

  it('retorna erro quando o HTTP falha', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('erro', { status: 429 }))
    )

    await expect(searchWeb('exemplo', 1)).rejects.toThrow('HTTP 429')
  })
})

describe('fetchPageText', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('extrai texto legível de uma página HTML', async () => {
    const html = `
      <html><body>
        <script>var x = 1;</script>
        <style>body { color: red; }</style>
        <h1>Título</h1>
        <p>Primeiro &amp; segundo parágrafo.</p>
      </body></html>
    `
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      )
    )

    const text = await fetchPageText('https://example.com', 20000)
    expect(text).toContain('Título')
    expect(text).toContain('Primeiro & segundo parágrafo.')
    expect(text).not.toContain('var x')
  })

  it('trunca textos longos', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('texto'.repeat(1000), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      )
    )

    const text = await fetchPageText('https://example.com', 100)
    expect(text.length).toBeLessThanOrEqual(102)
  })

  it('decodifica charset declarado no meta (latin-1)', async () => {
    const prefix = '<html><head><meta charset="iso-8859-1"></head><body><p>caf'
    const suffix = '</p></body></html>'
    const data = new Uint8Array(prefix.length + 1 + suffix.length)
    data.set(new TextEncoder().encode(prefix), 0)
    data[prefix.length] = 0xe9
    data.set(new TextEncoder().encode(suffix), prefix.length + 1)

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(data, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      )
    )

    const text = await fetchPageText('https://example.com', 20000)
    expect(text).toContain('café')
  })
})

describe('extractReadableText', () => {
  it('remove scripts, estilos, navegação, rodapés e anúncios', () => {
    const html = `
      <html><body>
        <script>var x = 1;</script>
        <style>body { color: red; }</style>
        <nav><a href="/">Início</a></nav>
        <aside>Barra lateral</aside>
        <footer>Rodapé © 2024</footer>
        <div class="ad-slot">Compre já!</div>
        <div aria-hidden="true">Conteúdo escondido</div>
        <main>
          <h1>Artigo</h1>
          <p>Texto essencial.</p>
        </main>
      </body></html>
    `

    const text = extractReadableText(html, 'https://example.com')
    expect(text).toContain('# Artigo')
    expect(text).toContain('Texto essencial.')
    expect(text).not.toContain('var x')
    expect(text).not.toContain('color: red')
    expect(text).not.toContain('Início')
    expect(text).not.toContain('Barra lateral')
    expect(text).not.toContain('Rodapé')
    expect(text).not.toContain('Compre já!')
    expect(text).not.toContain('Conteúdo escondido')
  })

  it('preserva estrutura de headings, listas, citações, links, imagens e código', () => {
    const html = `
      <html><body>
        <h2>Subseção</h2>
        <ul>
          <li>Item um</li>
          <li>Item dois</li>
        </ul>
        <p>Veja <a href="/wiki/pagina">esta página</a> e o
          <a href="https://externo.com/docs">docs externo</a>.</p>
        <img src="foto.png" alt="foto do local">
        <blockquote>Citação importante</blockquote>
        <pre><code>const a = 1;
  if (a) b();</code></pre>
      </body></html>
    `

    const text = extractReadableText(html, 'https://example.com')
    expect(text).toContain('## Subseção')
    expect(text).toContain('- Item um')
    expect(text).toContain('- Item dois')
    expect(text).toContain('esta página (https://example.com/wiki/pagina)')
    expect(text).toContain('docs externo (https://externo.com/docs)')
    expect(text).toContain('[foto do local]')
    expect(text).toContain('> Citação importante')
    expect(text).toContain('const a = 1;\n  if (a) b();')
  })

  it('decodifica entidades nominais e numéricas', () => {
    const html =
      '<html><body><p>&copy; 2024 &mdash; caf&#233; &amp; ch&aacute;</p></body></html>'

    const text = extractReadableText(html, 'https://example.com')
    expect(text).toContain('© 2024 — café & chá')
  })

  it('formata tabelas com células separadas', () => {
    const html = `
      <html><body>
        <table>
          <tr><th>Nome</th><th>Idade</th></tr>
          <tr><td>Ana</td><td>30</td></tr>
        </table>
      </body></html>
    `

    const text = extractReadableText(html, 'https://example.com')
    expect(text).toContain('Nome | Idade')
    expect(text).toContain('Ana | 30')
  })
})
