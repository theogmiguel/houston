// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '../houston/client'
import type { DelegationInfo } from '../houston/generated/DelegationInfo'
import type { DelegationState } from '../houston/generated/DelegationState'

import { HeaderDelegationBadge, type PaneRoster } from './DelegationCard'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
})

function delegation(over: Partial<DelegationInfo> = {}): DelegationInfo {
  return {
    parent: 41,
    role: 'docs-sweep',
    state: 'working' as DelegationState,
    stalled: false,
    result_staged: false,
    superseded: 0,
    ended_at: null,
    stop_reason: null,
    turn_end_source: 'stop-hook',
    inbox_owed: 0,
    inbox_provisional: 0,
    ...over
  }
}

function pane(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 58,
    agent: 'gemini',
    project_dir: '/tmp/p',
    cwd: '/tmp/p',
    state: 'running',
    title: 'slate-lantern',
    codename: over.codename ?? 'slate-lantern',
    hidden: false,
    spawned_by: 41,
    live_children: 0,
    children_waiting: 0,
    ...over
  } as SessionInfo
}

function mount(node: React.ReactNode): void {
  root = createRoot(container!)
  act(() => root!.render(node))
}

function openCard(testid: string): HTMLElement {
  const badge = document.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement
  act(() => badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  const card = document.querySelector('[role="dialog"]') as HTMLElement
  expect(card, 'the card must open on click').not.toBeNull()
  return card
}

describe('the delegation card, opened from a child badge', () => {
  it('renders only the rows that have a value', () => {
    mount(<HeaderDelegationBadge kind="origin" info={pane({ delegation: delegation() })} />)
    const card = openCard('origin-badge')
    const labels = [...card.querySelectorAll('dt')].map((n) => n.textContent)
    expect(labels).toContain('workspace')
    expect(labels).toContain('role')
    expect(labels).toContain('state')
    expect(labels).not.toContain('stalled')
    expect(labels).not.toContain('result')
    expect(labels).not.toContain('superseded')
    expect(labels).not.toContain('ended')
    expect(labels).not.toContain('stop reason')
  })

  it('reads a stalled child as stalled, though its state is still working', () => {
    mount(
      <HeaderDelegationBadge
        kind="origin"
        info={pane({ delegation: delegation({ stalled: true }) })}
      />
    )
    const badge = document.querySelector('[data-testid="origin-badge"]') as HTMLElement
    expect(badge.innerHTML, 'the badge glyph carries the warn tint').toContain('var(--warn)')
    const card = openCard('origin-badge')
    expect(card.textContent).toContain('stalled')
    expect([...card.querySelectorAll('dt')].map((n) => n.textContent)).toContain('stalled')
  })

  it('gives every terminal state a treatment, and never reads `unknown` as an error', () => {
    const words: Record<string, string> = {
      done: 'done',
      failed: 'failed',
      cancelled: 'cancelled',
      unknown: 'unknown'
    }
    for (const [state, word] of Object.entries(words)) {
      mount(
        <HeaderDelegationBadge
          kind="origin"
          info={pane({
            delegation: delegation({
              state: state as DelegationState,
              ended_at: 1_700_000_000_000,
              stop_reason: 'a reason'
            })
          })}
        />
      )
      const card = openCard('origin-badge')
      expect(card.textContent, state).toContain(word)
      expect([...card.querySelectorAll('dt')].map((n) => n.textContent), state).toContain(
        'stop reason'
      )
      if (state === 'unknown' || state === 'cancelled') {
        expect(
          card.innerHTML,
          `${state} is not a failure and must not wear the error ground`
        ).not.toContain('--status-blocked-bg')
      }
      act(() => root!.unmount())
      root = null
    }
  })

  it('falls back to the parent id when the roster cannot supply its codename', () => {
    mount(<HeaderDelegationBadge kind="origin" info={pane({ delegation: delegation() })} />)
    expect(openCard('origin-badge').textContent).toContain('#41')
  })

  it('offers Focus as its only lever, and nothing that acts on the agent', () => {
    const onFocusPane = vi.fn()
    mount(
      <HeaderDelegationBadge
        kind="origin"
        info={pane({ delegation: delegation() })}
        onFocusPane={onFocusPane}
      />
    )
    const card = openCard('origin-badge')
    const buttons = [...card.querySelectorAll('button')]
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toContain('Focus')
    act(() =>
      buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    )
    expect(onFocusPane).toHaveBeenCalledWith(41)
  })
})

describe("the delegation card, opened from a parent's badge", () => {
  const roster = (children: SessionInfo[], maxLiveChildren: number | null): PaneRoster => ({
    sessions: new Map(children.map((c) => [c.id, c])),
    maxLiveChildren
  })

  it('names the pane the card belongs to as this pane, never as one it came from', () => {
    const parent = pane({
      id: 41,
      title: 'Plan login',
      codename: 'Max',
      spawned_by: null,
      live_children: 1,
      children_waiting: 0
    })
    const crew = [
      pane({
        id: 47,
        title: 'Adjust frontend',
        codename: 'Elle',
        delegation: delegation({ role: 'test-writer' })
      })
    ]
    mount(<HeaderDelegationBadge kind="orchestrator" info={parent} roster={roster(crew, 8)} />)
    const text = openCard('orchestrator-badge').textContent ?? ''
    expect(text).toContain('Max · Plan login')
    expect(text, 'the roster is not FROM the pane it belongs to').not.toMatch(/from\s*41/i)
  })

  it('puts each child codename first, with role and task as secondary context', () => {
    const parent = pane({
      id: 41,
      title: 'Plan login',
      codename: 'Max',
      spawned_by: null,
      live_children: 1,
      children_waiting: 0
    })
    const crew = [
      pane({
        id: 47,
        title: 'Adjust frontend',
        codename: 'Elle',
        delegation: delegation({ role: 'test-writer' })
      })
    ]
    mount(<HeaderDelegationBadge kind="orchestrator" info={parent} roster={roster(crew, 8)} />)
    const row = openCard('orchestrator-badge').querySelector('button')!
    expect(row.querySelector('[data-testid="roster-identity"]')?.textContent).toBe('Elle')
    expect(row.querySelector('[data-testid="roster-secondary"]')?.textContent).toBe(
      'test-writer · Adjust frontend'
    )
    expect(row.textContent).not.toContain('#47')
  })

  it('sorts the crew waiting-first, then by id', () => {
    const parent = pane({ id: 41, title: 'crimson-harbor', spawned_by: null, live_children: 3, children_waiting: 2 })
    const crew = [
      pane({ id: 47, title: 'amber-signal', delegation: delegation({ role: 'test-writer' }) }),
      pane({ id: 52, title: 'quiet-meridian', delegation: delegation({ role: 'reviewer', state: 'needs_input' }) }),
      pane({ id: 58, title: 'slate-lantern', delegation: delegation({ role: 'docs-sweep', stalled: true }) })
    ]
    mount(
      <HeaderDelegationBadge kind="orchestrator" info={parent} roster={roster(crew, 8)} />
    )
    const card = openCard('orchestrator-badge')
    const rows = [...card.querySelectorAll('button')].map((b) => b.textContent ?? '')
    expect(rows[0]).toContain('reviewer')
    expect(rows[1]).toContain('docs-sweep')
    expect(rows[2]).toContain('test-writer')
  })

  it('names the limit, the actual value and what it means when the crew is at the cap', () => {
    const crew = [1, 2].map((n) =>
      pane({ id: 100 + n, title: `child-${n}`, delegation: delegation({ role: `r${n}` }) })
    )
    const parent = pane({ id: 41, spawned_by: null, live_children: 2, children_waiting: 0 })
    mount(<HeaderDelegationBadge kind="orchestrator" info={parent} roster={roster(crew, 2)} />)
    expect(openCard('orchestrator-badge').textContent).toContain('2 of 2 live children — at the cap')
  })

  it('says nothing about a cap the daemon has not reported yet', () => {
    const crew = [pane({ id: 101, delegation: delegation() })]
    const parent = pane({ id: 41, spawned_by: null, live_children: 1, children_waiting: 0 })
    mount(<HeaderDelegationBadge kind="orchestrator" info={parent} roster={roster(crew, null)} />)
    expect(openCard('orchestrator-badge').textContent).not.toContain('at the cap')
  })

  it('leaves out a dead child: the badge counts LIVE children and so does its card', () => {
    const crew = [
      pane({ id: 101, title: 'alive', delegation: delegation({ role: 'alive' }) }),
      pane({ id: 102, title: 'gone', state: 'exited', delegation: delegation({ role: 'gone', state: 'done' }) })
    ]
    const parent = pane({ id: 41, spawned_by: null, live_children: 1, children_waiting: 0 })
    mount(<HeaderDelegationBadge kind="orchestrator" info={parent} roster={roster(crew, 4)} />)
    const card = openCard('orchestrator-badge')
    expect(card.textContent).toContain('alive')
    expect(card.textContent).not.toContain('gone')
  })
})

describe('the delegation card names its parent by codename and reports the inbox', () => {
  const parentRoster = (): PaneRoster => ({
    sessions: new Map([
      [
        41,
        pane({
          id: 41,
          title: 'Fix the flaky late attach flood today',
          codename: 'oak',
          spawned_by: null
        })
      ]
    ]),
    maxLiveChildren: null
  })

  it('the badge reads the child codename and the tooltip carries the parent identity', () => {
    mount(
      <HeaderDelegationBadge
        kind="origin"
        info={pane({ title: 'Adjust frontend', codename: 'fern', delegation: delegation() })}
        roster={parentRoster()}
      />
    )
    const badge = document.querySelector('[data-testid="origin-badge"]') as HTMLElement
    expect(badge.textContent).toContain('fern')
    expect(badge.textContent).not.toContain('oak')
    expect(badge.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      'fern · child of oak'
    )
    const card = openCard('origin-badge')
    expect(card.textContent).toContain('child of')
    expect(card.textContent).toContain('oak')
  })

  it('the owed row names what the child still owes its parent', () => {
    mount(
      <HeaderDelegationBadge
        kind="origin"
        info={pane({ delegation: delegation({ inbox_owed: 2, inbox_provisional: 1 }) })}
        roster={parentRoster()}
      />
    )
    expect(openCard('origin-badge').textContent).toContain('2 owed to parent · 1 provisional')
  })

  it('does not repeat a codename when it is also the task title in the card heading', () => {
    mount(
      <HeaderDelegationBadge
        kind="origin"
        info={pane({ title: 'fern', codename: 'fern', delegation: delegation() })}
        roster={parentRoster()}
      />
    )
    const text = openCard('origin-badge').textContent ?? ''
    expect(text.match(/fern/g)?.length).toBe(1)
  })

  it('a corrected last result links to its correction', () => {
    mount(
      <HeaderDelegationBadge
        kind="origin"
        info={pane({ delegation: delegation({ last_result_corrected_by: 124 }) })}
        roster={parentRoster()}
      />
    )
    expect(openCard('origin-badge').textContent).toContain('corrected by #124')
  })

  it('a provisional last result carries its marker', () => {
    mount(
      <HeaderDelegationBadge
        kind="origin"
        info={pane({ delegation: delegation({ inbox_provisional: 1 }) })}
        roster={parentRoster()}
      />
    )
    expect(openCard('origin-badge').textContent).toContain('may be corrected')
  })

  it('a CLI that cannot report a block says so', () => {
    mount(
      <HeaderDelegationBadge
        kind="origin"
        info={
          pane({
            delegation: delegation({
              capability_note: 'cursor cannot report a block; a stall stands in'
            })
          })
        }
        roster={parentRoster()}
      />
    )
    expect(openCard('origin-badge').textContent).toContain(
      'cursor cannot report a block; a stall stands in'
    )
  })

  it('a held inbox names why and offers Deliver now', () => {
    const onDeliverNow = vi.fn()
    mount(
      <HeaderDelegationBadge
        kind="origin"
        info={
          pane({
            delegation: delegation({
              inbox_owed: 1,
              hold_reason: 'this pane is of unknown status, not idle'
            })
          })
        }
        roster={parentRoster()}
        onDeliverNow={onDeliverNow}
      />
    )
    const card = openCard('origin-badge')
    expect(card.textContent).toContain('this pane is of unknown status, not idle')
    const deliver = [...card.querySelectorAll('button')].find(
      (b) => b.textContent === 'Deliver now'
    )
    expect(deliver).toBeTruthy()
    act(() =>
      deliver!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    )
    expect(onDeliverNow).toHaveBeenCalledWith(41)
  })
})
