import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findUndeclaredVars } from './check-undeclared-vars.mjs'

describe('custom property references', () => {
  it('checks fallbacks and accepts CSS, inline style and runtime declarations', () => {
    const root = mkdtempSync(join(tmpdir(), 'houston-css-'))
    try {
      writeFileSync(join(root, 'theme.css'), ':root { --surface: white; } /* var(--comment) */')
      writeFileSync(join(root, 'view.tsx'), `
        // var(--comment)
        const style = { '--local': 'red', ['--typed' as string]: 'blue' }
        node.style.setProperty('--runtime', 'green')
        const cls = '[--tailwind:1] bg-[var(--surface)]'
        const value = 'var(--local) var(--typed) var(--runtime) var(--tailwind) var(--missing, red)'
      `)
      expect([...findUndeclaredVars(root)]).toEqual([['--missing', new Set(['view.tsx'])]])
    } finally {
      rmSync(root, { recursive: true })
    }
  })
  it('has no undeclared references in renderer source', () => {
    expect([...findUndeclaredVars()]).toEqual([])
  })
})
