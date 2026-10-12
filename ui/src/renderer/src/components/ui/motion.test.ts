import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('frequent surface motion', () => {
  it('shows panes, palette and rail sections immediately', () => {
    expect(source('../LayoutView.tsx')).not.toContain('paneGrowCls')
    expect(source('./CommandPalette.tsx')).not.toContain('animate-[menu-in')
    expect(source('./NavigationRail.tsx')).not.toContain('animate-[rail-slide-in-right')
    expect(source('./floatingSurface.css')).not.toContain('floating-pop-in')
  })
  it('disables animations and transitions globally under reduced motion', () => {
    const css = source('../../base.css')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('*::before')
    expect(css).toContain('*::after')
    expect(css).toContain('animation: none !important')
    expect(css).toContain('transition: none !important')
  })
  it('keeps reduced-motion settled poses with their component stylesheets', () => {
    const base = source('../../base.css')
    for (const selector of ['.loop-anim', '.pane-inspector', '.mascot-fx', '.browser-surface-load']) expect(base).not.toContain(selector)
    for (const [path, rule] of [
      ['./loopMotion.css', 'opacity: var(--dot-pulse-opacity, 1)'],
      ['./inspector.css', 'transform: none'],
      ['./Mascot.css', '.mascot-fx { display: none; }'],
      ['./browserSurface.css', '.browser-surface-load > span { width: 100%; opacity: 0.6; }']
    ]) {
      expect(source(path)).toContain('@media (prefers-reduced-motion: reduce)')
      expect(source(path)).toContain(rule)
    }
    expect(source('../../keyframes.css')).toContain("@import './components/ui/loopMotion.css'")
  })
  it('limits corner notices to the fast curve and keeps top notices instant', () => {
    expect(source('./NoticeToast.tsx')).toContain("'workspace-top': ''")
    expect(source('../../theme.css')).toContain('--motion-notice-entry-corner: notice-in-corner var(--motion-fast-t)')
    expect(source('./OrchestrationNotice.tsx')).not.toContain('200ms')
  })
})
