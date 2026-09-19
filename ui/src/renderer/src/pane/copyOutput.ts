export interface BufferLineLike {
  isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

export interface BufferLike {
  length: number
  getLine(y: number): BufferLineLike | undefined
}

export const COPY_OUTPUT_CHOICES = [100, 200, 500, 1000, 'all'] as const
export type CopyOutputChoice = (typeof COPY_OUTPUT_CHOICES)[number]

const STORAGE_KEY = 'tr-copy-output-lines'
const DEFAULT_CHOICE: CopyOutputChoice = 200

const BOX_CHAR = /[\u2500-\u257F]/
const BOX_CHAR_G = /[\u2500-\u257F]/g
const PURE_BOX_LINE = /^[\u2500-\u257F]+$/

const WALL_CHAR = /[│┃║]/

const MAX_PASSES = 5 // repeat until stable so a nested box fully unwraps

export function stripBoxGlyphs(text: string): string {
  // A box glyph is stripped only when it sits at a line edge (the first/last
  // non-space char); one interior to the line is content (a table separator,
  // a wall in prose), not framing, and is left alone.
  if (!BOX_CHAR.test(text)) return text
  const out: string[] = []
  for (const line of text.split('\n')) {
    let current: string | null = line
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const next = stripLineOnce(current)
      if (next === current) break
      current = next
      if (current === null) break
    }
    if (current !== null) out.push(current)
  }
  return out.join('\n')
}

function stripLineOnce(line: string): string | null {
  if (!BOX_CHAR.test(line)) return line
  const trimmed = line.trim()
  if (trimmed.length > 0 && PURE_BOX_LINE.test(trimmed)) {
    return null
  }
  const first = line.search(/\S/)
  const lastMatch = /\S\s*$/.exec(line)
  const last = lastMatch ? lastMatch.index : first
  const firstIsBox = first >= 0 && BOX_CHAR.test(line[first])
  const lastIsBox = last >= 0 && BOX_CHAR.test(line[last])
  const firstIsWall = first >= 0 && WALL_CHAR.test(line[first])
  const lastIsWall = last >= 0 && WALL_CHAR.test(line[last])

  if (first !== last && firstIsWall && lastIsWall) {
    let start = first + 1
    if (line[start] === ' ' || line[start] === '\t') start++
    return line.slice(start, last).replace(/[ \t]+$/, '')
  }

  if (trimmed.length > 0 && (firstIsBox || lastIsBox)) {
    let start = 0
    let end = line.length
    if (firstIsBox) {
      start = first + 1
      if (line[start] === ' ' || line[start] === '\t') start++
    }
    if (lastIsBox) {
      end = last
    }
    const middle = line.slice(start, end)
    const withoutRules = middle.replace(BOX_CHAR_G, '')
    return withoutRules === middle ? middle.trim() : withoutRules.trim()
  }

  return line
}

export function getCopyOutputDefault(): CopyOutputChoice {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === 'all') return 'all'
  const n = Number(raw)
  return (COPY_OUTPUT_CHOICES as readonly (number | string)[]).includes(n)
    ? (n as CopyOutputChoice)
    : DEFAULT_CHOICE
}

export function setCopyOutputDefault(choice: CopyOutputChoice): void {
  localStorage.setItem(STORAGE_KEY, String(choice))
}

export function trimToLastLines(
  text: string,
  lines: number | 'all',
  stripBox = true
): string {
  const logical = text.split('\n')
  while (logical.length > 0 && logical[logical.length - 1].trim() === '') {
    logical.pop()
  }
  const take = lines === 'all' ? logical.length : lines
  const joined = logical.slice(Math.max(0, logical.length - take)).join('\n')
  return stripBox ? stripBoxGlyphs(joined) : joined
}

export function lastOutputLines(
  buf: BufferLike,
  lines: number | 'all',
  stripBox = true
): string {
  const logical: string[] = []
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    const next = buf.getLine(y + 1)
    const text = line.translateToString(!(next && next.isWrapped))
    if (line.isWrapped && logical.length > 0) {
      logical[logical.length - 1] += text
    } else {
      logical.push(text)
    }
  }
  while (logical.length > 0 && logical[logical.length - 1].trim() === '') {
    logical.pop()
  }
  const take = lines === 'all' ? logical.length : lines
  const joined = logical.slice(Math.max(0, logical.length - take)).join('\n')
  return stripBox ? stripBoxGlyphs(joined) : joined
}

// Reads from the engine's own scrollback text when attached, else the buffer
// rows the terminal exposes -- the one branch both "Copy output" and Handoff
// share instead of each repeating it.
export function outputText(
  full: string | undefined,
  buf: BufferLike,
  lines: number | 'all',
  stripBox = true
): string {
  return full === undefined
    ? lastOutputLines(buf, lines, stripBox)
    : trimToLastLines(full, lines, stripBox)
}
