// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from '../../houston/client'
import type { LayoutNode } from '../../layout/tree'
import { computeRects, launchPreviewTree, tidy } from '../../layout/tree'
import type { SessionSlot } from '../sessionPresets'
import { LaunchGridPreview } from './LaunchGridPreview'

afterEach(cleanup)

const tree: LayoutNode = {
  kind: 'split',
  dir: 'row',
  children: [
    { kind: 'leaf', session: 1, id: 'pane-1' },
    { kind: 'leaf', session: 2, id: 'pane-2' }
  ],
  weights: [1, 1]
}

const slots: SessionSlot[] = [
  { index: 0, agent: 'claude', roleLabel: 'builder', prompt: '', model: null, effort: null, modelSource: 'agent default', effortSource: 'agent default', agentSource: 'preset', headerSource: 'preset', skippedRoute: null, invalidReason: null },
  { index: 1, agent: 'claude', roleLabel: 'reviewer', prompt: '', model: null, effort: null, modelSource: 'agent default', effortSource: 'agent default', agentSource: 'preset', headerSource: 'preset', skippedRoute: null, invalidReason: null }
]

const sessions = new Map<number, SessionInfo>([
  [1, { id: 1, agent: 'claude' } as SessionInfo],
  [2, { id: 2, agent: 'codex' } as SessionInfo]
])

describe('LaunchGridPreview', () => {
  it('uses the tidy grid for existing panes and outlined new slots', () => {
    const { container } = render(<div className="relative"><LaunchGridPreview tree={tree} slots={slots} target="this-grid" sessions={sessions} /></div>)
    const panes = Array.from(container.querySelectorAll<HTMLElement>('[data-layout-slot]'))
    expect(panes).toHaveLength(4)
    expect(Array.from(container.querySelectorAll('[data-layout-slot]:not([data-new])')).map((pane) => pane.textContent?.match(/Session · (?:Claude Code|Codex)/g)?.length ?? 0)).toEqual([1, 1])
    expect(panes.filter((pane) => pane.dataset.new === undefined).map((pane) => pane.textContent)).toEqual(['Session · Claude Code', 'Session · Codex'])
    expect(panes.filter((pane) => pane.dataset.new === 'true').map((pane) => pane.textContent)).toEqual([
      'builderagent default · default effort · this checkout',
      'revieweragent default · default effort · this checkout'
    ])
    expect(panes.map((pane) => pane.style.left)).toEqual([
      'calc(0% + var(--pane-gutter))',
      'calc(50% + calc(var(--pane-gutter) / 2))',
      'calc(0% + var(--pane-gutter))',
      'calc(50% + calc(var(--pane-gutter) / 2))'
    ])
    const layout = tidy(launchPreviewTree(tree, slots.length, 'this-grid'))
    if (!layout) throw new Error('expected a tidy preview layout')
    const rects = computeRects(layout).leaves.map(({ rect }) => `${rect.x},${rect.y},${rect.w},${rect.h}`)
    expect(panes.map((pane) => pane.dataset.previewRect)).toEqual(rects)
  })

  it('shows only new slots when the target is a new grid', () => {
    const { container } = render(<div className="relative"><LaunchGridPreview tree={tree} slots={slots} target="new-grid" sessions={sessions} /></div>)
    expect(container.querySelectorAll('[data-layout-slot]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-new="true"]')).toHaveLength(2)
  })

  it('paints its own backdrop so the live panes never show through the gutters', () => {
    const { container } = render(<div className="relative"><LaunchGridPreview tree={tree} slots={slots} target="this-grid" sessions={sessions} /></div>)
    expect(container.querySelector('[data-testid="launch-grid-preview"]')?.className.split(' ')).toContain('bg-[var(--gutter-bg)]')
  })
})
