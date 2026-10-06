import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '..', '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('container and media query conditions', () => {
  // CSS rejects var() in a query condition, so the browser drops the whole rule and the
  // breakpoint silently stops applying.
  it('use literal lengths, never a custom property', () => {
    const hits = sources(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\[@(?:container|media)[^\]\s]*var\(--[^\]\s]*\]/g)].map(
        (m) => `${relative(SRC, file)}: ${m[0]}`
      )
    )
    expect(hits, 'expected a literal length such as [@container_(max-width:280px)]').toEqual([])
  })
})
