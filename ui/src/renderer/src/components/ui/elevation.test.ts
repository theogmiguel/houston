import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('floating elevation', () => {
  it('lets each surface choose its themed elevation', () => {
    expect(source('./floatingSurface.css').split('}')[0]).not.toContain('box-shadow:')
    expect(source('./Tooltip.tsx')).toContain('shadow-[var(--shadow-1)]')
    expect(source('./OrchestrationNotice.tsx')).toContain('shadow-[var(--shadow-1)]')
  })
  it('uses the shared ladder for file and panel overlays', () => {
    for (const path of ['./filesSurface.css', './panel.css', './prs.css', './inspector.css']) {
      expect(source(path)).not.toMatch(/--shadow-(files-(menu|dialog|modal|explorer)|panel-check-popover)/)
    }
    expect(source('./filesSurface.css')).toContain('box-shadow: var(--shadow-2)')
  })
})
