import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const browserSurfaceSrc = readFileSync(join(__dirname, 'ui/BrowserSurface.tsx'), 'utf8')

describe('motion-k15 — BrowserPane.tsx rbrowser-progress-slide sweep', () => {
  it('gates the sweep behind motion-safe:, never runs it unconditionally', () => {
    expect(browserSurfaceSrc).toContain(
      'motion-safe:[animation:rbrowser-progress-slide_1.15s_cubic-bezier(0.4,0,0.3,1)_infinite]'
    )
    expect(browserSurfaceSrc).not.toMatch(/[^:]\[animation:rbrowser-progress-slide/)
  })

  it('gives the reduced path a real static substitute, not a freeze mid-slide', () => {
    expect(browserSurfaceSrc).toContain('motion-reduce:w-full')
    expect(browserSurfaceSrc).toContain('motion-reduce:bg-[var(--text-primary)]')
  })
})

describe('motion-k16 — browserTabs.tsx favicon pulse (shared dot-pulse keyframe)', () => {
  it('gates the pulse behind motion-safe:, never runs it unconditionally', () => {
    expect(browserSurfaceSrc).toContain(
      'group-data-[loading]/pop:motion-safe:[animation:dot-pulse_1.2s_steps(4,end)_infinite]'
    )
    expect(browserSurfaceSrc).not.toContain('group-data-[loading]/pop:[animation:dot-pulse')
  })

  it('gives the reduced path a static dimmed opacity, not a freeze', () => {
    expect(browserSurfaceSrc).toContain('group-data-[loading]/pop:motion-reduce:opacity-70')
  })
})

describe('motion-k3 — browserTabs.tsx overflow menu (menu-in)', () => {
  it('is gated motion-safe: and uses the shared Menu duration token, not a bespoke literal', () => {
    expect(browserSurfaceSrc).toContain('motion-safe:[animation:menu-in_var(--animate-t-fast)_var(--animate-ease-menu)]')
    expect(browserSurfaceSrc).not.toContain('menu-in_0.14s')
  })
})
