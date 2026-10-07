// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidePanel } from './SidePanel'
import { PanelTab } from './ui/PanelTab'
import type { SourceControlPanelProps } from './SourceControlPanel'
import type { SessionInfo } from '../houston/client'

vi.mock('./SourceControlPanel', () => ({ SourceControlPanel: () => <div data-testid="scm-content" /> , ScmResizeHandle: () => <div /> }))
vi.mock('./files/FilesSurface', () => ({ FilesSurface: ({ workspaceRoot }: { workspaceRoot: string }) => <div data-testid="inspector-files">Files root: {workspaceRoot}</div> }))
vi.mock('./browser/BrowserSurface', () => ({ BrowserSurface: () => <div data-testid="inspector-browser" /> }))
vi.mock('./OverviewTab', () => ({ OverviewTab: () => <div data-testid="overview-content" /> }))

afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers() })

describe('PanelTab primitive', () => {
  it('selects the tab and closes it from the hover close affordance', () => {
    const onClick = vi.fn()
    const onClose = vi.fn()
    render(<PanelTab label="Diff" icon={<span>icon</span>} active onClick={onClick} onClose={onClose} />)
    const tab = screen.getByRole('tab', { name: 'Diff' })
    expect(tab.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(tab.querySelector('.panel-tab-close')!)
    expect(onClose).toHaveBeenCalledOnce()
    expect(onClick).not.toHaveBeenCalled()
  })
})

function session(id: number, title: string, spawned_by: number | null = null): SessionInfo {
  return { id, title, agent: 'claude', detected_agent: null, state: 'running', project_dir: `/repo/${id}`, worktree: null, spawned_by } as unknown as SessionInfo
}

function props(sessions: ReadonlyMap<number, SessionInfo>, activeSessionId: number | null): SourceControlPanelProps & React.ComponentProps<typeof SidePanel> {
  return {
    dir: activeSessionId == null ? null : sessions.get(activeSessionId)?.project_dir ?? null,
    client: {} as NonNullable<SourceControlPanelProps['client']>,
    width: 384,
    onWidth: vi.fn(),
    onResetWidth: vi.fn(),
    tab: 'changes',
    onTab: vi.fn(),
    workspace: '/repo',
    sessions,
    activeSessionId,
    request: null,
    onReviewChild: vi.fn(),
    onMoveFile: vi.fn(),
    onFocusSide: vi.fn(),
    onFocusGrid: vi.fn()
  }
}

describe('pane inspector focus', () => {
  it('returns keyboard focus to the grid on Escape', () => {
    const onFocusGrid = vi.fn()
    const focused = props(new Map([[1, session(1, 'session')]]), 1)
    render(<SidePanel {...focused} onFocusGrid={onFocusGrid} />)

    fireEvent.keyDown(screen.getByTestId('side-panel'), { key: 'Escape' })
    expect(onFocusGrid).toHaveBeenCalledOnce()
  })

  it('keeps the tabs-only header when pane focus changes', () => {
    const first = session(1, 'first pane')
    const second = session(2, 'second pane')
    const sessions = new Map([[1, first], [2, second]])
    const view = render(<SidePanel {...props(sessions, 1)} />)
    expect(screen.getByRole('tablist', { name: 'Panel surfaces' })).toBeTruthy()
    view.rerender(<SidePanel {...props(sessions, 2)} />)
    expect(screen.queryByText('second pane')).toBeNull()
    view.rerender(<SidePanel {...props(new Map(), null)} />)
    expect(screen.getByRole('heading', { name: 'Open a surface' })).toBeTruthy()
  })

  it('keeps describing the last focused pane after a click outside the grid clears keyboard focus', () => {
    const sessions = new Map([[1, session(1, 'terminal pane')]])
    const view = render(<SidePanel {...props(sessions, 1)} />)
    view.rerender(<SidePanel {...props(sessions, null)} />)
    expect(screen.getByRole('heading', { name: 'Open a surface' })).toBeTruthy()
    expect(screen.queryByText('No focused pane')).toBeNull()
  })

  it('opens the Browser surface for a browser request', async () => {
    const parent = session(1, 'orchestrator')
    render(<SidePanel {...props(new Map([[1, parent]]), 1)} request={{ kind: 'browser', id: 'browser-1', url: 'http://localhost:5173', workspace: '/repo' }} />)
    expect(await screen.findByTestId('inspector-browser')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'New tab' }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('inspector presence and slide state', () => {
  it('enters when opened after being closed, but does not animate on an open remount', () => {
    const base = props(new Map([[1, session(1, 'session')]]), 1)
    const view = render(<SidePanel {...base} open={false} />)
    view.rerender(<SidePanel {...base} open />)
    expect(screen.getByTestId('side-panel').getAttribute('data-state')).toBe('entering')

    view.unmount()
    render(<SidePanel {...base} open />)
    expect(screen.getByTestId('side-panel').getAttribute('data-state')).toBe('open')
  })

  it('keeps the panel mounted while closing until its exit animation ends', () => {
    vi.useFakeTimers()
    const base = props(new Map([[1, session(1, 'session')]]), 1)
    const view = render(<SidePanel {...base} open />)
    view.rerender(<SidePanel {...base} open={false} />)
    const panel = screen.getByTestId('side-panel')
    expect(panel.getAttribute('data-state')).toBe('closing')
    expect(panel.isConnected).toBe(true)

    act(() => { vi.advanceTimersByTime(239) })
    expect(screen.getByTestId('side-panel').isConnected).toBe(true)
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByTestId('side-panel')).toBeNull()
  })
})

describe('panel Files surface', () => {
  it('routes a file request to its root and persists Files in surface state', async () => {
    const request = { kind: 'files' as const, root: '/session-worktree', path: '/session-worktree/src/index.ts', line: 9, col: 2 }
    render(<SidePanel {...props(new Map([[1, session(1, 'session')]]), 1)} workspace="/workspace" request={request} />)

    expect(await screen.findByText('Files root: /session-worktree')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true')
    expect(localStorage.getItem('tr-inspector-tabs:/workspace')).toContain('files')
  })

  it('restores a pinned Files tab when the inspector remounts for the same workspace', () => {
    localStorage.setItem('tr-inspector-tab:/workspace', 'files')
    render(<SidePanel {...props(new Map([[1, session(1, 'session')]]), 1)} workspace="/workspace" />)

    expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true')
  })

  it('closes a panel tab with middle-click while preventing the Linux paste gesture', () => {
    localStorage.setItem('tr-inspector-tabs:/repo', JSON.stringify({ openTabs: ['diff', 'files'], active: 'diff' }))
    render(<SidePanel {...props(new Map([[1, session(1, 'session')]]), 1)} />)
    const tab = screen.getByRole('tab', { name: 'Diff' })
    expect(fireEvent.mouseDown(tab, { button: 1 })).toBe(false)
    let notCancelled = true
    act(() => {
      notCancelled = tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    })
    expect(notCancelled).toBe(false)
    expect(JSON.parse(localStorage.getItem('tr-inspector-tabs:/repo') ?? '{}')).toEqual({ openTabs: ['files'], active: 'files' })
  })
})
