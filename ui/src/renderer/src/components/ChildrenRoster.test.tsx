// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionsStore, SessionsStoreContext } from '../sessionsStore'
import { ChildrenRoster, childGroup, childStateWord, delegationAge, glyphLabel } from './ChildrenRoster'
import type { HoustonClient, SessionInfo } from '../houston/client'

const child = (id: number, state: SessionInfo['state'] = 'running'): SessionInfo => ({ id, state, codename: `child-${id}`, hidden: false, inbox_unread: 0, resumable: false, title: `worker ${id}`, agent: 'claude', cwd: '/tmp/p', project_dir: '/tmp/p', spawned_by: 1, status: 'working', children_waiting: 0, live_children: 0, tags: [] } as SessionInfo)
let root: Root
let host: HTMLDivElement
let children: SessionInfo[]
const closeSession = vi.fn()
const delegationResultsList = vi.fn()
const client = { closeSession, delegationResultsList, subscribe: () => () => {}, taskSnapshot: vi.fn(), taskQueueRun: vi.fn() } as unknown as HoustonClient
const props = () => ({ parent: child(1), children, client, selected: null, onSelect: vi.fn(), onMove: vi.fn(), collapsed: false, onCollapse: vi.fn() })
const render = () => act(() => root.render(<ChildrenRoster {...props()} />))
const click = (text: string) => act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!.click())
beforeEach(() => { vi.useFakeTimers(); closeSession.mockClear(); delegationResultsList.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); children = [child(2, 'exited'), child(3, 'killed'), child(4)] })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })

describe('settled children', () => {
  it('uses the same fixed status, glyph, and label grid for orchestrator, working, and settled rows', () => {
    render()
    const targets = [...host.querySelectorAll<HTMLElement>('.children-row .children-open')]
    expect(targets).toHaveLength(4)
    for (const target of targets) {
      expect(target.classList.contains('grid')).toBe(true)
      expect(target.classList.contains('grid-cols-[16px_16px_minmax(0,1fr)_auto]')).toBe(true)
      expect(target.children[1]?.querySelector('svg') ?? (target.children[1]?.matches('svg') ? target.children[1] : null)).not.toBeNull()
      expect(target.children[2]?.tagName.toLowerCase()).toBe('strong')
    }
  })
  it('opens the child menu from a glyph context click without opening the parent menu', () => {
    const parentMenu = vi.fn()
    act(() => root.render(<div onContextMenu={parentMenu}><ChildrenRoster {...props()} /></div>))
    const glyph = host.querySelector<HTMLButtonElement>('[aria-label="Open worker 4"]')!
    act(() => glyph.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 })))
    expect(host.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('worker 4 actions')
    expect(parentMenu).not.toHaveBeenCalled()
    expect(delegationResultsList).toHaveBeenCalledWith(1)
  })
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
  it.each(['done', 'failed'] as const)('uses the shared verdict dot for a settled %s child', (state) => {
    children = [{ ...child(2, 'exited'), delegation: { state } as SessionInfo['delegation'] }]
    render()
    const label = state === 'done' ? 'Done' : 'Failed'
    const dot = host.querySelector(`.children-row.settled .children-status[data-state="${state}"] [aria-label="${label}"] .agent-dot`)
    expect(dot).not.toBeNull()
    expect(dot?.getAttribute('style')).toContain(state === 'done' ? 'var(--ok)' : 'var(--stop)')
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

it('regroups a child after a pure status update while its input props remain unchanged', () => {
  children = [child(4)]
  const parent = { ...child(1), spawned_by: null }
  const sessions = new Map([[1, parent], [4, children[0]]])
  const store = createSessionsStore(sessions)
  act(() => root.render(<SessionsStoreContext.Provider value={store}><ChildrenRoster {...props()} parent={parent} roster={{ sessions, maxLiveChildren: null }} /></SessionsStoreContext.Provider>))
  expect(host.querySelector('[aria-label="Answer 4"]')).toBeNull()
  act(() => store.set((previous) => new Map(previous).set(4, { ...children[0], status: 'needs-input' })))
  expect(host.querySelector('[aria-label="Answer 4"]')).not.toBeNull()
  expect(host.querySelector('.children-list [aria-label="needs your input"]')).not.toBeNull()
})


describe('reported child state', () => {
  it('keeps a stalled working delegation out of human attention', () => {
    children = [{ ...child(2), delegation: { state: 'working', stalled: true } as SessionInfo['delegation'] }]
    expect(childGroup(children[0])).toBe('Working')
    expect(childStateWord(children[0])).toBe('stalled')
    render()
    expect(host.querySelector('[aria-label="Answer 2"]')).toBeNull()
    expect(host.querySelector('[aria-label="Stalled"]')).not.toBeNull()
  })
  it.each(['done', 'failed'] as const)('shows a live %s verdict without closing the PTY', (state) => {
    children = [{ ...child(2), delegation: { state } as SessionInfo['delegation'] }]
    expect(childStateWord(children[0])).toBe(state)
    render()
    expect(host.querySelector(`[aria-label="${state === 'done' ? 'Done' : 'Failed'}"]`)).not.toBeNull()
    expect(host.querySelector('[aria-label="Stop 2"]')).not.toBeNull()
  })
  it.each([{ status: 'needs-input' as const }, { children_waiting: 1 }])('prioritizes a current input request over a done turn (%o)', (signal) => {
    children = [{ ...child(2), ...signal, delegation: { state: 'done' } as SessionInfo['delegation'] }]
    expect(childGroup(children[0])).toBe('Needs you')
    expect(childStateWord(children[0])).toBe('needs input')
    render()
    expect(host.querySelector('[aria-label="Answer 2"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Done"]')).toBeNull()
  })
  it('keeps staged and unread result labels visible without hover', () => {
    children = [
      { ...child(2), delegation: { state: 'done', result_staged: true } as SessionInfo['delegation'] },
      { ...child(3), delegation: { state: 'done', inbox_owed: 1 } as SessionInfo['delegation'] },
    ]
    render()
    expect(host.querySelector('.children-detail [aria-label="Result staged"]')).not.toBeNull()
    expect(host.querySelector('.children-detail [aria-label="Pending delivery"]')).not.toBeNull()
  })
})
