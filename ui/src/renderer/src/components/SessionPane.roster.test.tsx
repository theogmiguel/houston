// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'

vi.mock('../pane/TerminalPane', () => ({ TerminalPane: ({ info, onOpenFile, onOpenDir }: { info: SessionInfo; onOpenFile: (path: string) => void; onOpenDir: (path: string) => void }) => <div data-terminal={info.id} data-root={info.project_dir} data-cwd={info.cwd}><button onClick={() => onOpenFile(`${info.cwd}/file.ts`)}>file {info.id}</button><button onClick={() => onOpenDir(info.cwd)}>dir {info.id}</button></div> }))
import { SessionPane } from './SessionPane'

const noop = () => {}
const info = (id: number, spawned_by: number | null = null): SessionInfo => ({ id, spawned_by, agent: 'claude', state: 'running', title: `pane ${id}`, cwd: `/tmp/child${id}/sub`, project_dir: `/tmp/child${id}`, codename: `child${id}`, tags: [], hidden: false, live_children: 0, children_waiting: 0, inbox_unread: 0, resumable: false, status: 'working' })
let root: Root
let host: HTMLDivElement
let sessions: Map<number, SessionInfo>
let gridIds: Set<number>
const onOpenFile = vi.fn(), onOpenDir = vi.fn(), onFocusPane = vi.fn(), onMoveChildToGrid = vi.fn()
function render(): void {
  act(() => root.render(<SessionPane client={{} as HoustonClient} info={sessions.get(1)!} roster={{ sessions, maxLiveChildren: 8 }} gridSessionIds={gridIds} theme="black" active connected fontSize={14} copyOnSelect={false} stripBoxGlyphs={false} showProject={false} shellIntegration={false} registerOutput={() => noop} onReconnectSsh={noop} onActivate={noop} onExpand={noop} onZoom={noop} onShellZoom={noop} onSplit={noop} onHeaderPointerDown={noop} onHandoff={noop} onOpenFile={onOpenFile} onOpenDir={onOpenDir} onFocusPane={onFocusPane} onMoveChildToGrid={onMoveChildToGrid} />))
}
function select(id: number): void { act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="Open ${id}"]`)!.click()) }
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); sessions = new Map([info(1), ...[2, 3, 4, 5].map(id => info(id, 1))].map(s => [s.id, s])); gridIds = new Set([1]); vi.clearAllMocks() })
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('private child terminal stack', () => {
  it('keeps the orchestrator and three most recent child PTYs mounted', () => {
    render()
    for (const id of [2, 3, 4, 5]) select(id)
    expect([...host.querySelectorAll('[data-terminal]')].map(el => Number(el.getAttribute('data-terminal')))).toEqual([1, 5, 4, 3])
    expect(host.querySelector('[data-peek-session="5"]')?.getAttribute('aria-hidden')).toBe('false')
    expect(host.querySelector('[data-peek-session="1"]')?.getAttribute('aria-hidden')).toBe('true')
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
