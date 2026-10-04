// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChildrenRoster, childGroup, delegationAge, glyphLabel } from './ChildrenRoster'
import type { HoustonClient, SessionInfo } from '../houston/client'

const child = (id: number, state: SessionInfo['state'] = 'running'): SessionInfo => ({ id, state, codename: `child-${id}`, hidden: false, inbox_unread: 0, resumable: false, title: `worker ${id}`, agent: 'claude', cwd: '/tmp/p', project_dir: '/tmp/p', spawned_by: 1, status: 'working', children_waiting: 0, live_children: 0, tags: [] } as SessionInfo)
let root: Root
let host: HTMLDivElement
let children: SessionInfo[]
const closeSession = vi.fn()
const client = { closeSession, subscribe: () => () => {}, taskSnapshot: vi.fn(), taskQueueRun: vi.fn() } as unknown as HoustonClient
const props = () => ({ parent: child(1), children, client, selected: null, onSelect: vi.fn(), onMove: vi.fn(), collapsed: false, onCollapse: vi.fn() })
const render = () => act(() => root.render(<ChildrenRoster {...props()} />))
const click = (text: string) => act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!.click())
beforeEach(() => { vi.useFakeTimers(); closeSession.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); children = [child(2, 'exited'), child(3, 'killed'), child(4)] })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })

describe('settled children', () => {
  it.each(['claude', 'codex', 'antigravity', 'opencode', 'cursor', 'grok'] as const)('tints %s provider glyphs in children and orchestrator rows', (agent) => {
    children = [{ ...child(2), agent }]
    act(() => root.render(<ChildrenRoster {...props()} parent={{ ...child(1), agent }} />))
    for (const row of host.querySelectorAll('.children-row')) {
      expect(row.querySelector('svg')?.parentElement?.style.color).toBe(`var(--${agent})`)
    }
  })
  it('uses an ended dot and Close instead of Stop for settled children', () => {
    render()
    const row = host.querySelector('.children-row.settled')!
    expect(row.querySelector('[aria-label="Ended"]')).not.toBeNull()
    expect(row.querySelector('[aria-label="Stop 2"]')).toBeNull()
    act(() => row.querySelector<HTMLButtonElement>('[aria-label="Close 2"]')!.click())
    expect(closeSession).toHaveBeenCalledWith(2)
  })
  it.each(['done', 'failed'] as const)('exposes a settled %s child\'s ended dot to the state tint', (state) => {
    children = [{ ...child(2, 'exited'), delegation: { state } as SessionInfo['delegation'] }]
    render()
    expect(host.querySelector(`.children-row.settled .children-status[data-state="${state}"] .agent-dot[aria-label="Ended"]`)).not.toBeNull()
  })
  it.each(['done', 'failed', 'unknown'] as const)('never settles or closes a live %s delegation', (state) => {
    children = [child(2, 'exited'), { ...child(3), delegation: { state } as SessionInfo['delegation'] }]
    expect(childGroup(children[1])).toBe('Working')
    render(); click('Close settled (1)')
    act(() => vi.advanceTimersByTime(5000))
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(2)
  })
  it('does not close a child resumed with an unknown delegation during Undo', () => {
    render(); click('Close settled (2)')
    children = [{ ...child(2), delegation: { state: 'unknown' } as SessionInfo['delegation'] }, child(3, 'killed')]
    render()
    act(() => vi.advanceTimersByTime(5000))
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(3)
  })
  it('includes ended sessions even when there is no delegation record', () => {
    expect(childGroup(child(2, 'exited'))).toBe('Settled')
    expect(childGroup(child(2, 'interrupted'))).toBe('Settled')
  })
  it('waits five seconds before closing and Undo preserves the PTYs and rows', () => {
    render(); click('Close settled (2)')
    expect(closeSession).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(4999))
    expect(closeSession).not.toHaveBeenCalled()
    click('Undo')
    act(() => vi.advanceTimersByTime(5000))
    expect(closeSession).not.toHaveBeenCalled()
    expect(host.textContent).toContain('worker 2')
  })
  it('keeps Undo available after the roster collapses to its glyph strip', () => {
    render(); click('Close settled (2)')
    act(() => root.render(<ChildrenRoster {...props()} collapsed />))
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Undo closing settled children"]')!.click())
    act(() => vi.advanceTimersByTime(5000))
    expect(closeSession).not.toHaveBeenCalled()
  })
  it('rechecks state before destruction and never closes a child that resumed', () => {
    render(); click('Close settled (2)')
    children = [child(2), child(3, 'killed'), child(4)]
    render()
    act(() => vi.advanceTimersByTime(5000))
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(3)
  })
  it('cancels pending destruction when its roster unmounts', () => {
    render(); click('Close settled (2)')
    act(() => root.render(null))
    act(() => vi.advanceTimersByTime(5000))
    expect(closeSession).not.toHaveBeenCalled()
  })
  it('marks the selected child in the collapsed glyph strip', () => {
    act(() => root.render(<ChildrenRoster {...props()} collapsed selected={3} />))
    expect(host.querySelector('[aria-label="Open worker 3"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('[aria-label="Orchestrator"]')?.getAttribute('aria-pressed')).toBe('false')
  })
  it('formats observation ages without negative values', () => {
    expect(delegationAge(1000, 0)).toBe('0s')
    expect(delegationAge(0, 65000)).toBe('1m')
    expect(delegationAge(0, 3600000)).toBe('1h')
  })
})

describe('needs-you filter', () => {
  const needy = (id: number): SessionInfo => ({ ...child(id), status: 'needs-input' })
  it('lives on the Needs you heading, not the roster head', () => {
    children = [needy(2), child(3)]
    render()
    expect(host.querySelector('.children-head [aria-pressed]')).toBeNull()
    click('Show only')
    expect(host.textContent).not.toContain('worker 3')
    click('Show only')
    expect(host.textContent).toContain('worker 3')
  })
  it('clears itself once nothing needs you, so the list cannot stay empty', () => {
    children = [needy(2), child(3)]
    render(); click('Show only')
    children = [child(2), child(3)]
    render()
    expect(host.textContent).toContain('worker 3')
    children = [needy(2), child(3)]
    render()
    expect(host.textContent).toContain('worker 3')
  })
})

describe('roster carry-overs', () => {
  it('opens the overview tab from its footer', () => {
    const handler = vi.fn()
    window.addEventListener('houston:side-open', handler)
    render(); click('Overview')
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ detail: { kind: 'overview', orchestrator: 1 } }))
    window.removeEventListener('houston:side-open', handler)
  })

})

describe('glyph labels', () => {
  it('name a provider capability gap next to the role and group', () => {
    const cursor = { ...child(5), agent: 'cursor', delegation: { state: 'working', role: 'scout', capability_note: 'cursor: needs-input not reported by this provider' } as SessionInfo['delegation'] } as SessionInfo
    expect(glyphLabel(cursor)).toBe('scout · Working · cursor: needs-input not reported by this provider')
    expect(glyphLabel(child(4))).toBe('worker 4 · Working')
  })
})
