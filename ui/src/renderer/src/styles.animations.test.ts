import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname)

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const files = walk(SRC)
const cssFiles = files.filter((p) => p.endsWith('.css'))
const codeFiles = files.filter(
  (p) => (p.endsWith('.tsx') || p.endsWith('.ts')) && !/\.test\.tsx?$/.test(p)
)

const blankComments = (css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

const TAILWIND_BUILTIN_KEYFRAMES = ['spin', 'ping', 'pulse', 'bounce']

function definedNames(): Set<string> {
  const names = new Set<string>(TAILWIND_BUILTIN_KEYFRAMES)
  for (const p of cssFiles) {
    for (const m of blankComments(readFileSync(p, 'utf8')).matchAll(
      /@keyframes\s+([\w-]+)/g
    )) {
      names.add(m[1])
    }
  }
  return names
}

function cssReferences(): { name: string; where: string }[] {
  const out: { name: string; where: string }[] = []
  for (const p of cssFiles) {
    const css = blankComments(readFileSync(p, 'utf8'))
    for (const m of css.matchAll(/\banimation(?:-name)?\s*:\s*([^;{}]+)/g)) {
      for (const tok of m[1].split(',')) {
        const name = animationNameOf(tok)
        if (name) out.push({ name, where: p.replace(SRC, '') })
      }
    }
  }
  return out
}

const isCustomIdent = (t: string): boolean => /^-?[A-Za-z_][\w-]*$/.test(t)

function classStringReferences(): { name: string; where: string }[] {
  const out: { name: string; where: string }[] = []
  const push = (name: string, p: string): void => {
    if (name && !isKeyword(name) && isCustomIdent(name)) out.push({ name, where: p.replace(SRC, '') })
  }
  for (const p of codeFiles) {
    const src = readFileSync(p, 'utf8')
    for (const m of src.matchAll(/\[animation(?:-name)?:([^\]]+)\]/g)) {
      push(m[1].split('_')[0].trim(), p)
    }
    for (const m of src.matchAll(/\banimate-\[([^\]]+)\]/g)) {
      push(m[1].split('_')[0].trim(), p)
    }
  }
  return out
}

const KEYWORDS = new Set([
  'none', 'inherit', 'initial', 'unset', 'revert', 'infinite', 'normal', 'reverse',
  'alternate', 'alternate-reverse', 'forwards', 'backwards', 'both', 'running',
  'paused', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start',
  'step-end'
])
const isKeyword = (t: string): boolean =>
  KEYWORDS.has(t) || /^-?[\d.]/.test(t) || t.includes('(') || t.startsWith('var')

function animationNameOf(decl: string): string | null {
  const tokens = decl
    .trim()
    .replace(/\([^)]*\)/g, (m) => m.replace(/\s/g, ''))
    .split(/\s+/)
    .map((t) => t.replace(//g, ' '))
  for (const t of tokens) if (t && !isKeyword(t)) return t
  return null
}

describe('animation names', () => {
  it('every @keyframes name referenced from CSS is defined', () => {
    const defined = definedNames()
    const missing = cssReferences().filter((r) => !defined.has(r.name))
    expect(
      missing.map((m) => `${m.where}: animation "${m.name}" has no @keyframes`),
      `Defined: ${[...defined].sort().join(', ')}`
    ).toEqual([])
  })

  it('every animation named in a Tailwind class string is defined', () => {
    const defined = definedNames()
    const refs = classStringReferences()
    expect(refs.length).toBeGreaterThanOrEqual(10)
    const missing = refs.filter((r) => !defined.has(r.name))
    expect(
      missing.map((m) => `${m.where}: animation "${m.name}" has no @keyframes`),
      `Defined: ${[...defined].sort().join(', ')}`
    ).toEqual([])
  })

  const ALLOWED: Record<string, string> = {}

  function infiniteAnimationNames(): Set<string> {
    const infiniteNames = new Set<string>()
    for (const p of cssFiles) {
      const css = blankComments(readFileSync(p, 'utf8'))
      for (const m of css.matchAll(/\banimation(?:-name)?\s*:\s*([^;{}]+)/g)) {
        if (!/\binfinite\b/.test(m[1])) continue
        for (const tok of m[1].split(',')) {
          const name = animationNameOf(tok)
          if (name) infiniteNames.add(name)
        }
      }
    }
    for (const p of codeFiles) {
      const src = readFileSync(p, 'utf8')
      for (const m of [
        ...src.matchAll(/\[animation(?:-name)?:([^\]]+)\]/g),
        ...src.matchAll(/\banimate-\[([^\]]+)\]/g)
      ]) {
        if (!m[1].includes('infinite')) continue
        const name = m[1].split('_')[0].trim()
        if (name && !isKeyword(name) && isCustomIdent(name)) infiniteNames.add(name)
      }
    }
    return infiniteNames
  }

  it('every infinite animation is compositor-only, unless allowed by name with a reason', () => {
    const COMPOSITED = new Set(['opacity', 'transform', 'filter'])
    const infiniteNames = infiniteAnimationNames()
    expect(infiniteNames.size).toBeGreaterThanOrEqual(5)

    const bodies = new Map<string, string>()
    for (const p of cssFiles) {
      const css = blankComments(readFileSync(p, 'utf8'))
      for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
        let depth = 1
        let i = m.index + m[0].length
        while (i < css.length && depth > 0) {
          if (css[i] === '{') depth++
          else if (css[i] === '}') depth--
          i++
        }
        bodies.set(m[1], css.slice(m.index + m[0].length, i - 1))
      }
    }

    const offenders: string[] = []
    for (const name of infiniteNames) {
      if (name in ALLOWED) continue
      const body = bodies.get(name)
      if (!body) continue
      const bad = [...body.matchAll(/([a-z-]+)\s*:/g)]
        .map((m) => m[1])
        .filter((prop) => !COMPOSITED.has(prop))
      if (bad.length > 0) {
        offenders.push(
          `@keyframes ${name} runs infinite but animates non-composited: ${[...new Set(bad)].join(', ')}`
        )
      }
    }
    expect(offenders, 'add to ALLOWED only with a recorded reason (PERF-ADOPTION §2b)').toEqual([])
  })

  it('ALLOWED entries name an animation that still runs infinite (no stale entries)', () => {
    const infiniteNames = infiniteAnimationNames()
    for (const name of Object.keys(ALLOWED)) {
      expect(
        infiniteNames.has(name),
        `"${name}" is in ALLOWED but nothing runs it \`infinite\` any more — remove the stale entry`
      ).toBe(true)
    }
  })

  it('keyframes.css is what defines them, so it outlives styles.css', () => {
    const inKeyframesFile = new Set(
      [...blankComments(readFileSync(join(SRC, 'keyframes.css'), 'utf8')).matchAll(
        /@keyframes\s+([\w-]+)/g
      )].map((m) => m[1])
    )
    expect(inKeyframesFile.size).toBeGreaterThanOrEqual(18)
  })
})
