import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = __dirname

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

function bareBackgrounds(text: string): string[] {
  return [...text.matchAll(/(?:^|(?<=[\s'"`]))bg-[\w[(][^\s'"`]*/g)].map((m) => m[0])
}

describe('no same-layer emission-order ties on the background axis', () => {
  it('every conditional fill owns its own neutral branch', () => {
    const offenders: string[] = []
    for (const file of tsxFiles(SRC)) {
      const text = stripComments(readFileSync(file, 'utf8'))
      for (const m of text.matchAll(/className=\{`((?:[^`\\]|\\.)*)`\}/g)) {
        const body = m[1]
        const holes = [...body.matchAll(/\$\{([\s\S]*?)\}(?=[^{]|$)/g)].map((h) => h[1])
        const staticText = body.replace(/\$\{[\s\S]*?\}/g, ' ')
        const statics = bareBackgrounds(staticText)
        const conditionals = holes.flatMap((h) => bareBackgrounds(h))
        if (statics.length > 0 && conditionals.length > 0) {
          const line = text.slice(0, m.index).split('\n').length
          offenders.push(
            `${file.slice(SRC.length + 1)}:${line} — always-on ${statics.join(' ')} ` +
              `ties with conditional ${[...new Set(conditionals)].join(' ')}`
          )
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
