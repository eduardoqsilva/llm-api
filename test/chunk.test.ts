import { describe, expect, it } from 'vitest'
import { splitIntoChunks } from '../src/services/chunkText.js'

describe('splitIntoChunks', () => {
  it('retorna o texto inteiro quando cabe em um único chunk', () => {
    const text = 'Bom dia, tudo bem?'
    expect(splitIntoChunks(text, 4000)).toEqual([text])
  })

  it('retorna o texto em um chunk quando está no limite exato', () => {
    const text = 'a'.repeat(100)
    expect(splitIntoChunks(text, 100)).toEqual([text])
  })

  it('retorna um chunk vazio para texto vazio', () => {
    expect(splitIntoChunks('', 100)).toEqual([''])
  })

  it('rejeita maxChars inválido', () => {
    expect(() => splitIntoChunks('texto', 0)).toThrow()
  })

  it('reconstrói o texto original ao juntar os chunks', () => {
    const text = `${'palavra '.repeat(40)} fim`
    const chunks = splitIntoChunks(text, 50)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
  })

  it('não corta palavras ao meio (limite em whitespace)', () => {
    const text = Array.from({ length: 30 }, (_, i) => `palavra${i}`).join(' ')
    const chunks = splitIntoChunks(text, 25)

    expect(chunks.join('')).toBe(text)

    for (let i = 0; i < chunks.length - 1; i++) {
      const lastChar = chunks[i].at(-1)
      const firstChar = chunks[i + 1][0]
      const splitInsideWord =
        lastChar !== undefined &&
        firstChar !== undefined &&
        !/\s/.test(lastChar) &&
        !/\s/.test(firstChar)

      expect(splitInsideWord).toBe(false)
    }
  })

  it('mantém uma palavra maior que o limite inteira (sem cortar)', () => {
    const word = 'x'.repeat(200)
    const chunks = splitIntoChunks(word, 50)
    expect(chunks).toEqual([word])
  })

  it('preserva as quebras de linha na reconstrução', () => {
    const text = 'Linha um.\n\nLinha dois.\nLinha três.'
    const chunks = splitIntoChunks(text, 12)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
  })

  it('preserva \r\n na reconstrução', () => {
    const text = 'Linha um.\r\nLinha dois.\r\nLinha três.'
    const chunks = splitIntoChunks(text, 10)
    expect(chunks.join('')).toBe(text)
  })

  it('quebra linhas longas por espaço preservando o conteúdo', () => {
    const text = `${'a'.repeat(30)} ${'b'.repeat(30)} ${'c'.repeat(30)}`
    const chunks = splitIntoChunks(text, 35)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
  })
})
