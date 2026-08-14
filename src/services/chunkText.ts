const LINE_PATTERN = /[^\r\n]*\r?\n|[^\r\n]+/g
const TOKEN_PATTERN = /\s+|\S+/g

function packTokens(tokens: string[], maxChars: number): string[] {
  const pieces: string[] = []
  let current = ''

  for (const token of tokens) {
    if (current.length === 0 || current.length + token.length <= maxChars) {
      current += token
    } else {
      pieces.push(current)
      current = token
    }
  }

  if (current.length > 0) {
    pieces.push(current)
  }

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
    const tokens =
      line.length > maxChars ? (line.match(TOKEN_PATTERN) ?? []) : [line]

    for (const piece of packTokens(tokens, maxChars)) {
      if (current.length + piece.length <= maxChars) {
        current += piece
      } else {
        flush()
        current = piece
      }
    }
  }

  flush()

  return chunks
}
