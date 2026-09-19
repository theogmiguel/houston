import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const STYLESHEET_RELATIVE_PATHS = [
  'tailwind.css',
  'keyframes.css',
  'theme.css',
  'base.css',
  'global.css'
]
const STYLESHEET_PATHS = STYLESHEET_RELATIVE_PATHS.map((p) => join(__dirname, p))

const RUNTIME_ALLOWLIST = new Set<string>([
  '--pulse-color',
])

interface VarRef {
  name: string
  file: string
  line: number
  hasFallback: boolean
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++
  }
  return line
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    const newlines = match.match(/\n/g)?.length ?? 0
    return '\n'.repeat(newlines)
  })
}

function extractVarRefs(css: string, file: string): VarRef[] {
  const refs: VarRef[] = []
  const re = /var\(\s*(--[a-zA-Z0-9_-]+)\s*(,)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    refs.push({
      name: m[1],
      file,
      line: lineAt(css, m.index),
      hasFallback: m[2] === ','
    })
  }
  return refs
}

function extractDefinedProps(css: string): Set<string> {
  const defined = new Set<string>()
  const re = /(?:^|[{;])\s*(--[a-zA-Z0-9_-]+)\s*:/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    defined.add(m[1])
  }
  return defined
}

describe('renderer stylesheets custom property tokens', () => {
  it('STYLESHEET_PATHS lists existing files (non-empty, no silent gaps from a rename)', () => {
    expect(STYLESHEET_PATHS.length).toBeGreaterThan(0)
    for (const path of STYLESHEET_PATHS) {
      expect(existsSync(path), `stylesheet listed in STYLESHEET_PATHS does not exist: ${path}`).toBe(true)
    }
  })

  const sources = STYLESHEET_PATHS.map((path, i) => ({
    label: STYLESHEET_RELATIVE_PATHS[i],
    raw: readFileSync(path, 'utf8')
  })).map(({ label, raw }) => ({ label, css: stripComments(raw) }))

  const refs = sources.flatMap(({ label, css }) => extractVarRefs(css, label))
  const defined = new Set<string>()
  for (const { css } of sources) {
    for (const name of extractDefinedProps(css)) defined.add(name)
  }

  it('found a non-trivial number of var() references and definitions (sanity check)', () => {
    expect(refs.length).toBeGreaterThan(50)
    expect(defined.size).toBeGreaterThan(10)
  })

  it('every var(--x) reference resolves: defined in one of STYLESHEET_PATHS, has a fallback, or is runtime-allowlisted', () => {
    const byName = new Map<string, { file: string; line: number }[]>()
    for (const ref of refs) {
      if (defined.has(ref.name)) continue
      if (ref.hasFallback) continue
      if (RUNTIME_ALLOWLIST.has(ref.name)) continue
      const locs = byName.get(ref.name) ?? []
      locs.push({ file: ref.file, line: ref.line })
      byName.set(ref.name, locs)
    }

    if (byName.size > 0) {
      const details = [...byName.entries()]
        .map(([name, locs]) => {
          const where = locs.map((l) => `${l.file}:${l.line}`).join(', ')
          return `  ${name} referenced at ${where} — not defined, has no fallback, and is not in RUNTIME_ALLOWLIST`
        })
        .join('\n')
      throw new Error(
        `Unresolved CSS custom property reference(s):\n${details}\n\n` +
          `Expected each var(--x) to either have a matching "--x:" definition somewhere in ` +
          `one of STYLESHEET_PATHS, supply a fallback (var(--x, ...)), or be added to ` +
          `RUNTIME_ALLOWLIST with a comment citing the file:line that sets it via JS.`
      )
    }

    expect(byName.size).toBe(0)
  })

  it('RUNTIME_ALLOWLIST entries are actually referenced without a fallback (no stale entries)', () => {
    for (const name of RUNTIME_ALLOWLIST) {
      const usedWithoutFallback = refs.some((r) => r.name === name && !r.hasFallback)
      expect(
        usedWithoutFallback,
        `${name} is in RUNTIME_ALLOWLIST but every reference to it now has a fallback or no longer exists — remove the stale entry`
      ).toBe(true)
    }
  })
})
