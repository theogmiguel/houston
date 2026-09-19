import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = __dirname
const SHARED_CONSTANTS = [join(SRC, 'components/buttonChrome.ts'), join(SRC, 'editor/editorChrome.ts')]

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) tsxFiles(p, out)
    else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) out.push(p)
  }
  return out
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[^\S\n]*\/\/.*$/gm, '')
}

function stringConstants(text: string, into = new Map<string, string>()): Map<string, string> {
  const decl =
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*((?:`[^`]*`|'[^']*'|"[^"]*")(?:\s*\+\s*(?:`[^`]*`|'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*))*)/g
  for (const m of stripComments(text).matchAll(decl)) into.set(m[1], m[2])
  return into
}

function expand(expr: string, table: Map<string, string>, depth = 0): string {
  if (depth > 4) return expr
  return expr.replace(
    /\$\{\s*([A-Za-z_$][\w$]*)\s*\}|(?<![\w$.])([A-Z][A-Z0-9_]{2,})(?![\w$])/g,
    (m, a, b) => {
      const v = table.get(a ?? b)
      return v === undefined ? m : expand(v, table, depth + 1)
    }
  )
}

const MENTIONS_BORDER =
  /(?<![\w-])border(?![\w-])|(?<![\w-])border-(0|none|\[|t|r|b|l|x|y|s|e|current|transparent|solid|dashed|dotted|hidden|\d|[a-z]+-?\d*)/

const SHARED = SHARED_CONSTANTS.reduce(
  (into, file) => stringConstants(readFileSync(file, 'utf8'), into),
  new Map<string, string>()
)

describe('no control draws a container line by accident', () => {
  it('every `.btn` button states its own border decision', () => {
    const offenders: string[] = []
    for (const file of tsxFiles(SRC)) {
      const raw = readFileSync(file, 'utf8')
      const text = stripComments(raw)
      const table = stringConstants(raw, new Map(SHARED))
      for (let i = 0; (i = text.indexOf('<button', i)) !== -1; i++) {
        let depth = 0
        let j = i + '<button'.length
        for (; j < text.length; j++) {
          const c = text[j]
          if (c === '{') depth++
          else if (c === '}') depth--
          else if (c === '>' && depth === 0) break
        }
        const tag = text.slice(i, j)
        const resolved = expand(tag, table)
        if (!/(^|[`'"\s])btn([`'"\s]|$)/.test(resolved)) continue
        if (MENTIONS_BORDER.test(resolved)) continue
        if (/style\s*=\s*\{\{[^}]*border/i.test(tag)) continue
        if (/(^|[`'"\s])ctx-item([`'"\s]|$)/.test(resolved)) continue
        const line = text.slice(0, i).split('\n').length
        offenders.push(`${file.slice(SRC.length + 1)}:${line}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
