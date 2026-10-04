// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../../houston/client'
import type { LayoutNode } from '../../layout/tree'
import type { SessionSlot } from '../sessionPresets'
import { LaunchGridPreview } from './LaunchGridPreview'

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
  })

  it('shows only new slots when the target is a new grid', () => {
    const { container } = render(<div className="relative"><LaunchGridPreview tree={tree} slots={slots} target="new-grid" sessions={sessions} /></div>)
    expect(container.querySelectorAll('[data-layout-slot]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-new="true"]')).toHaveLength(2)
  })
})
