// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'

vi.mock('../pane/TerminalPane', () => ({ TerminalPane: ({ info, onOpenFile, onOpenDir }: { info: SessionInfo; onOpenFile: (path: string) => void; onOpenDir: (path: string) => void }) => <div data-terminal={info.id} data-root={info.project_dir} data-cwd={info.cwd}><button onClick={() => onOpenFile(`${info.cwd}/file.ts`)}>file {info.id}</button><button onClick={() => onOpenDir(info.cwd)}>dir {info.id}</button></div> }))
import { SessionPane } from './SessionPane'

const client = { respawnSession: vi.fn(), closeSession: vi.fn(), subscribe: () => () => {}, taskSnapshot: vi.fn(), taskQueueRun: vi.fn() } as unknown as HoustonClient
const noop = () => {}
const info = (id: number, spawned_by: number | null = null): SessionInfo => ({ id, spawned_by, agent: 'claude', state: 'running', title: `pane ${id}`, cwd: `/tmp/child${id}/sub`, project_dir: `/tmp/child${id}`, codename: `child${id}`, tags: [], hidden: false, live_children: 0, children_waiting: 0, inbox_unread: 0, resumable: false, status: 'working' })
let root: Root
let host: HTMLDivElement
let sessions: Map<number, SessionInfo>
let gridIds: Set<number>
const onOpenFile = vi.fn(), onOpenDir = vi.fn(), onFocusPane = vi.fn(), onMoveChildToGrid = vi.fn()
function render(): void {
  act(() => root.render(<SessionPane client={client} info={sessions.get(1)!} roster={{ sessions, maxLiveChildren: 8 }} gridSessionIds={gridIds} theme="black" active connected fontSize={14} copyOnSelect={false} stripBoxGlyphs={false} showProject={false} shellIntegration={false} registerOutput={() => noop} onReconnectSsh={noop} onActivate={noop} onExpand={noop} onZoom={noop} onShellZoom={noop} onSplit={noop} onHeaderPointerDown={noop} onHandoff={noop} onOpenFile={onOpenFile} onOpenDir={onOpenDir} onFocusPane={onFocusPane} onMoveChildToGrid={onMoveChildToGrid} />))
}
function select(id: number): void { act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="Open ${id}"]`)!.click()) }
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); sessions = new Map([info(1), ...[2, 3, 4, 5].map(id => info(id, 1))].map(s => [s.id, s])); gridIds = new Set([1]); vi.clearAllMocks() })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('private child terminal stack', () => {
  it('shows settlement timestamps and continues the existing conversation', () => {
    const ended = new Date('2026-10-01T13:38:00').getTime()
    vi.spyOn(Date, 'now').mockReturnValue(ended + 180000)
    sessions.set(2, { ...info(2, 1), state: 'exited', resumable: true, delegation: { settled_at: ended, retained_until: ended + 86400000 } as SessionInfo['delegation'] })
    render(); select(2)
    const bar = host.querySelector('[aria-label="Settled child"]')!
    expect(bar.textContent).toContain('Settled · ended 13:38 (3m ago) · kept until')
    expect(bar.textContent).toContain(new Date(ended + 86400000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }))
    act(() => [...bar.querySelectorAll('button')].find(button => button.textContent === 'Continue')!.click())
    expect(client.respawnSession).toHaveBeenCalledWith(2, undefined, null, undefined, undefined, false)
    act(() => [...bar.querySelectorAll('button')].find(button => button.textContent === 'Close')!.click())
    expect(client.closeSession).toHaveBeenCalledWith(2)
  })
  it('keeps the terminal area the same height when switching between orchestrator and child', () => {
    sessions.set(3, { ...info(3, 1), state: 'exited', delegation: { settled_at: 1, retained_until: 2 } as SessionInfo['delegation'] })
    render()
    const area = host.querySelector('[data-peek-session="1"]')!.parentElement!
    const siblings = (): string[] => [...area.parentElement!.children].map(el => el === area ? 'terminals' : el.textContent ?? '')
    expect(siblings()).toEqual(['Orchestrator', 'terminals'])
    select(2)
    expect(siblings()).toHaveLength(2)
    select(3)
    expect(siblings()).toHaveLength(2)
    expect(host.querySelector('[aria-label="Settled child"]')).not.toBeNull()
  })
  it('keeps the orchestrator and three most recent child PTYs mounted', () => {
    render()
    for (const id of [2, 3, 4, 5]) select(id)
    expect([...host.querySelectorAll('[data-terminal]')].map(el => Number(el.getAttribute('data-terminal')))).toEqual([1, 5, 4, 3])
    expect(host.querySelector('[data-peek-session="5"]')?.getAttribute('aria-hidden')).toBe('false')
    expect(host.querySelector('[data-peek-session="1"]')?.getAttribute('aria-hidden')).toBe('true')
    const hidden = host.querySelector<HTMLElement>('[data-peek-session="1"]')!
    expect(hidden.style.contentVisibility).toBe('')
    expect(hidden.style.contain).toBe('')
  })
  it('focuses a promoted child instead of rendering it a second time', () => {
    render(); select(2)
    gridIds = new Set([1, 2]); render(); select(2)
    expect(host.querySelector('[data-terminal="2"]')).toBeNull()
    expect(onFocusPane).toHaveBeenCalledExactlyOnceWith(2)
  })
  it('Move to grid focuses an already placed child instead of inserting another leaf', () => {
    gridIds = new Set([1, 2]); render()
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Move 2 to grid"]')!.click())
    expect(onFocusPane).toHaveBeenCalledExactlyOnceWith(2)
    expect(onMoveChildToGrid).not.toHaveBeenCalled()
  })
  it('passes the child cwd and project root and routes links with the child id', () => {
    render(); select(2)
    const terminal = host.querySelector('[data-terminal="2"]')!
    expect(terminal.getAttribute('data-root')).toBe('/tmp/child2')
    expect(terminal.getAttribute('data-cwd')).toBe('/tmp/child2/sub')
    act(() => [...terminal.querySelectorAll('button')].forEach(button => button.click()))
    expect(onOpenFile).toHaveBeenCalledWith(2, '/tmp/child2/sub/file.ts', undefined, undefined)
    expect(onOpenDir).toHaveBeenCalledWith('/tmp/child2/sub', 2)
  })
  it('keeps delegation hover-card names on roster rows, outside the header', () => {
    render()
    const child = host.querySelector('[data-testid="origin-badge"]')!
    expect(child.getAttribute('aria-label')).toContain('child2')
    expect(child.closest('[aria-label="Children roster"]')).not.toBeNull()
    expect(host.querySelector('.pane-head [data-testid="origin-badge"]')).toBeNull()
    expect(host.querySelector('.pane-head [data-testid="orchestrator-badge"]')).toBeNull()
  })
  it('keeps a settled child roster until the last session closes', () => {
    sessions = new Map([[1, info(1)], [2, { ...info(2, 1), state: 'exited' }]])
    render()
    expect(host.querySelector('[aria-label="Children roster"]')).not.toBeNull()
    sessions = new Map([[1, info(1)]]); render()
    expect(host.querySelector('[aria-label="Children roster"]')).toBeNull()
    expect(host.querySelector('[aria-label="Children strip"]')).toBeNull()
  })
})


it('shows unread inbox messages in the parent header and opens the overview', () => {
  sessions.set(1, { ...info(1), inbox_unread: 2 })
  const open = vi.fn()
  window.addEventListener('houston:side-open', open)
  render()
  const button = host.querySelector<HTMLButtonElement>('.pane-head [aria-label="2 unread inbox messages"]')!
  expect(button).not.toBeNull()
  act(() => button.click())
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ detail: { kind: 'overview', orchestrator: 1 } }))
  window.removeEventListener('houston:side-open', open)
  sessions.set(1, info(1)); render()
  expect(host.querySelector('.pane-head [aria-label="2 unread inbox messages"]')).toBeNull()
})


it('keeps a promoted live completed child header consistent with its turn verdict', () => {
  sessions.set(1, { ...info(1, 8), delegation: { state: 'done' } as SessionInfo['delegation'] })
  render()
  expect(host.querySelector('.pane-head [aria-label="Done"]')).not.toBeNull()
  expect(host.querySelector('.pane-head [aria-label="working"]')).toBeNull()
})
