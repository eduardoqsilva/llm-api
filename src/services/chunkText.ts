const LINE_PATTERN = /[^\r\n]*(?:\r\n|\n|$)/g
const TOKEN_PATTERN = /\s+|\S+/g

function splitOversizedToken(token: string, maxChars: number): string[] {
  const pieces: string[] = []

  for (let index = 0; index < token.length; index += maxChars) {
    pieces.push(token.slice(index, index + maxChars))
  }

  return pieces
}

function packTokens(tokens: string[], maxChars: number): string[] {
  const pieces: string[] = []
  let current = ''

  for (const token of tokens) {
    if (token.length === 0) {
      continue
    }

    // Token maior que o limite: precisamos quebrá-lo.
    // Isso pode acontecer com URLs muito grandes, linhas de código etc.
    if (token.length > maxChars) {
      if (current.length > 0) {
        pieces.push(current)
        current = ''
      }

      pieces.push(...splitOversizedToken(token, maxChars))
      continue
    }

    if (current.length === 0) {
      current = token
      continue
    }

    if (current.length + token.length <= maxChars) {
      current += token
      continue
    }

    pieces.push(current)
    current = token
  }

  if (current.length > 0) {
    pieces.push(current)
  }

  return pieces
}

function splitLine(line: string, maxChars: number): string[] {
  const newline = line.endsWith('\r\n')
    ? '\r\n'
    : line.endsWith('\n')
      ? '\n'
      : ''

  const content = newline.length > 0 ? line.slice(0, -newline.length) : line

  // A linha inteira cabe no limite.
  if (line.length <= maxChars) {
    return [line]
  }

  // Linha vazia + newline.
  if (content.length === 0) {
    return [newline]
  }

  const tokens = content.match(TOKEN_PATTERN) ?? []

  const contentMaxChars =
    newline.length > 0 ? Math.max(1, maxChars - newline.length) : maxChars

  const pieces = packTokens(tokens, contentMaxChars)

  if (newline.length === 0) {
    return pieces
  }

  if (pieces.length === 0) {
    return [newline]
  }

  const lastIndex = pieces.length - 1
  const lastPiece = pieces[lastIndex]

  // Normalmente a quebra cabe no último pedaço.
  if (lastPiece.length + newline.length <= maxChars) {
    pieces[lastIndex] = lastPiece + newline
    return pieces
  }

  // Caso extremo: o último pedaço já está cheio.
  pieces.push(newline)

  return pieces
}

export function splitIntoChunks(text: string, maxChars: number): string[] {
  if (maxChars <= 0) {
    throw new Error('maxChars must be greater than zero')
  }

  if (text.length === 0) {
    return ['']
  }

  const lines = text.match(LINE_PATTERN) ?? []
  const chunks: string[] = []

  let current = ''

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current)
      current = ''
    }
  }

  for (const line of lines) {
    const pieces = splitLine(line, maxChars)

    for (const piece of pieces) {
      if (piece.length > maxChars) {
        throw new Error(
          `Internal error: generated chunk exceeds maxChars (${piece.length} > ${maxChars})`
        )
      }

      if (current.length === 0) {
        current = piece
        continue
      }

      if (current.length + piece.length <= maxChars) {
        current += piece
        continue
      }

      flush()
      current = piece
    }
  }

  flush()

  return chunks
}
