const URL_RE = /https?:\/\/[^\s<>"']+/g

const TRAILING_PUNCT_RE = /[.,;:!?'"]+$/

const CLOSER_TO_OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' }

function countChar(s: string, ch: string): number {
  let n = 0
  for (const c of s) if (c === ch) n++
  return n
}

export interface UrlMatch {
  url: string
  start: number
  end: number
}

function authorityOf(url: string): string | undefined {
  const schemeEnd = url.indexOf('://')
  if (schemeEnd === -1) return undefined
  const rest = url.slice(schemeEnd + 3)
  const cut = rest.search(/[/?#]/)
  return cut === -1 ? rest : rest.slice(0, cut)
}

export function findUrls(text: string): UrlMatch[] {
  const matches: UrlMatch[] = []
  for (const m of text.matchAll(URL_RE)) {
    if (m.index === undefined) continue
    let url = m[0]
    const start = m.index
    for (;;) {
      const trimmed = url.replace(TRAILING_PUNCT_RE, '')
      if (trimmed !== url) {
        url = trimmed
        continue
      }
      const last = url[url.length - 1]
      const opener = last ? CLOSER_TO_OPENER[last] : undefined
      if (opener && countChar(url, last) > countChar(url, opener)) {
        url = url.slice(0, -1)
        continue
      }
      break
    }
    if (url.length === 0) continue
    const authority = authorityOf(url)
    if (!authority || !/[A-Za-z0-9]/.test(authority)) continue
    if (authority.includes('@')) continue
    matches.push({ url, start, end: start + url.length })
  }
  return matches
}

export interface WrappedLineSource {
  getLine(y: number): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined
}

export interface JoinedLine {
  text: string
  rows: number[]
  rowStarts: number[]
}

export function joinWrappedLine(buffer: WrappedLineSource, row: number): JoinedLine {
  let start = row
  while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1
  let end = row
  while (buffer.getLine(end + 1)?.isWrapped) end += 1

  const rows: number[] = []
  const rowStarts: number[] = []
  let text = ''
  for (let y = start; y <= end; y++) {
    const line = buffer.getLine(y)
    if (!line) break
    rows.push(y)
    rowStarts.push(text.length)
    text += line.translateToString(y === end)
  }
  return { text, rows, rowStarts }
}

export function mapJoinedOffset(joined: JoinedLine, charIndex: number): { row: number; col: number } {
  let i = 0
  for (let j = 1; j < joined.rowStarts.length; j++) {
    if (joined.rowStarts[j] <= charIndex) i = j
    else break
  }
  return { row: joined.rows[i], col: charIndex - joined.rowStarts[i] }
}

export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}
