import type { ToolArgs, ToolHandler } from './types.js'

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  ln: Math.log,
  log: Math.log10,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
}

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
}

type Token = {
  kind: 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma'
  value: string
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < input.length) {
    const ch = input[i]

    if (/\s/.test(ch)) {
      i++
      continue
    }

    if (/[0-9.]/.test(ch)) {
      let j = i
      while (j < input.length && /[0-9.]/.test(input[j])) j++
      const value = input.slice(i, j)
      const parsed = Number(value)
      if (value === '.' || Number.isNaN(parsed)) {
        throw new Error(`número inválido: "${value}"`)
      }
      tokens.push({ kind: 'number', value })
      i = j
      continue
    }

    if (/[a-zA-Z]/.test(ch)) {
      let j = i
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j])) j++
      tokens.push({ kind: 'ident', value: input.slice(i, j) })
      i = j
      continue
    }

    if (
      ch === '+' ||
      ch === '-' ||
      ch === '*' ||
      ch === '/' ||
      ch === '%' ||
      ch === '^'
    ) {
      tokens.push({ kind: 'op', value: ch })
      i++
      continue
    }

    if (ch === '(') {
      tokens.push({ kind: 'lparen', value: ch })
      i++
      continue
    }

    if (ch === ')') {
      tokens.push({ kind: 'rparen', value: ch })
      i++
      continue
    }

    if (ch === ',') {
      tokens.push({ kind: 'comma', value: ch })
      i++
      continue
    }

    throw new Error(`caractere inesperado: "${ch}"`)
  }

  return tokens
}

type ParserState = {
  tokens: Token[]
  pos: number
}

function peek(state: ParserState, offset = 0): Token | undefined {
  return state.tokens[state.pos + offset]
}

function matchOp(state: ParserState, value: string): boolean {
  const token = peek(state)
  if (token && token.kind === 'op' && token.value === value) {
    state.pos++
    return true
  }
  return false
}

function matchComma(state: ParserState): boolean {
  const token = peek(state)
  if (token && token.kind === 'comma') {
    state.pos++
    return true
  }
  return false
}

function expect(
  state: ParserState,
  kind: Token['kind'],
  value?: string
): Token {
  const token = state.tokens[state.pos]
  if (
    !token ||
    token.kind !== kind ||
    (value !== undefined && token.value !== value)
  ) {
    throw new Error(`esperado "${value ?? kind}"`)
  }
  state.pos++
  return token
}

function parseExpression(state: ParserState): number {
  let value = parseTerm(state)

  while (true) {
    if (matchOp(state, '+')) {
      value += parseTerm(state)
    } else if (matchOp(state, '-')) {
      value -= parseTerm(state)
    } else {
      break
    }
  }

  return value
}

function parseTerm(state: ParserState): number {
  let value = parseUnary(state)

  while (true) {
    if (matchOp(state, '*')) {
      value *= parseUnary(state)
    } else if (matchOp(state, '/')) {
      value /= parseUnary(state)
    } else if (matchOp(state, '%')) {
      value %= parseUnary(state)
    } else {
      break
    }
  }

  return value
}

function parseUnary(state: ParserState): number {
  if (matchOp(state, '-')) {
    return -parseUnary(state)
  }
  if (matchOp(state, '+')) {
    return parseUnary(state)
  }
  return parsePower(state)
}

function parsePower(state: ParserState): number {
  const base = parseAtom(state)
  if (matchOp(state, '^')) {
    return base ** parseUnary(state)
  }
  return base
}

function parseAtom(state: ParserState): number {
  const token = peek(state)
  if (!token) {
    throw new Error('expressão incompleta')
  }

  if (token.kind === 'number') {
    state.pos++
    return Number(token.value)
  }

  if (token.kind === 'lparen') {
    state.pos++
    const value = parseExpression(state)
    expect(state, 'rparen')
    return value
  }

  if (token.kind === 'ident') {
    state.pos++

    if (peek(state)?.kind === 'lparen') {
      state.pos++
      const args: number[] = []
      if (peek(state)?.kind !== 'rparen') {
        args.push(parseExpression(state))
        while (matchComma(state)) {
          args.push(parseExpression(state))
        }
      }
      expect(state, 'rparen')

      const fn = FUNCTIONS[token.value]
      if (!fn) {
        throw new Error(`função desconhecida: "${token.value}"`)
      }
      return fn(...args)
    }

    const constant = CONSTANTS[token.value]
    if (constant === undefined) {
      throw new Error(`constante desconhecida: "${token.value}"`)
    }
    return constant
  }

  throw new Error(`token inesperado: "${token.value}"`)
}

export function evaluateExpression(input: string): number {
  const tokens = tokenize(input)
  if (tokens.length === 0) {
    throw new Error('expressão vazia')
  }

  const state: ParserState = { tokens, pos: 0 }
  const value = parseExpression(state)

  if (state.pos !== tokens.length) {
    throw new Error(`token inesperado: "${tokens[state.pos].value}"`)
  }

  if (!Number.isFinite(value)) {
    throw new Error('resultado não finito')
  }

  return value
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return value.toString()
  }
  return String(Math.round(value * 1e10) / 1e10)
}

export const calculatorHandler: ToolHandler = async (
  args: ToolArgs
): Promise<string> => {
  const expression = String(args.expression ?? '').trim()
  try {
    return formatNumber(evaluateExpression(expression))
  } catch (error) {
    return `Erro: ${error instanceof Error ? error.message : String(error)}`
  }
}
