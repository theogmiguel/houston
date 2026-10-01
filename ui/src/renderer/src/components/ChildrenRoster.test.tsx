// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChildrenRoster, childGroup, observedAge } from './ChildrenRoster'
import type { HoustonClient, SessionInfo } from '../houston/client'

const child = (id: number, state: SessionInfo['state'] = 'running'): SessionInfo => ({ id, state, codename: `child-${id}`, hidden: false, inbox_unread: 0, resumable: false, title: `worker ${id}`, agent: 'claude', cwd: '/tmp/p', project_dir: '/tmp/p', spawned_by: 1, status: 'working', children_waiting: 0, live_children: 0, tags: [] } as SessionInfo)
let root: Root
let host: HTMLDivElement
let children: SessionInfo[]
const closeSession = vi.fn()
const client = { closeSession } as unknown as HoustonClient
const props = () => ({ parent: child(1), children, client, selected: null, onSelect: vi.fn(), onMove: vi.fn(), collapsed: false, onCollapse: vi.fn() })
const render = () => act(() => root.render(<ChildrenRoster {...props()} />))
const click = (text: string) => act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!.click())
beforeEach(() => { vi.useFakeTimers(); closeSession.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); children = [child(2, 'exited'), child(3, 'killed'), child(4)] })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })

describe('settled children', () => {
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
    expect(observedAge(1000, 0)).toBe('0s')
    expect(observedAge(0, 65000)).toBe('1m')
    expect(observedAge(0, 3600000)).toBe('1h')
  })
})
