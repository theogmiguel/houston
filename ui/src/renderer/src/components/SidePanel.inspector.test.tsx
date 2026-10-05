// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidePanel } from './SidePanel'
import type { SourceControlPanelProps } from './SourceControlPanel'
import type { SessionInfo } from '../houston/client'

vi.mock('./SourceControlPanel', () => ({ SourceControlPanel: () => <div data-testid="scm-content" /> , ScmResizeHandle: () => <div /> }))
vi.mock('./FilesPane', () => ({ FilesPane: () => <div /> }))
vi.mock('./OverviewTab', () => ({ OverviewTab: () => <div data-testid="overview-content" /> }))

afterEach(() => { cleanup(); localStorage.clear() })

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
  it('follows focus changes and clears the subject when its pane closes', () => {
    const first = session(1, 'first pane')
    const second = session(2, 'second pane')
    const sessions = new Map([[1, first], [2, second]])
    const view = render(<SidePanel {...props(sessions, 1)} />)
    expect(screen.getByText('first pane')).toBeTruthy()
    view.rerender(<SidePanel {...props(sessions, 2)} />)
    expect(screen.getByText('second pane')).toBeTruthy()
    view.rerender(<SidePanel {...props(new Map(), null)} />)
    expect(screen.getByText('No focused pane')).toBeTruthy()
  })

  it('offers Overview only for the focused orchestrator', async () => {
    const parent = session(1, 'orchestrator')
    const child = session(2, 'child', 1)
    const sessions = new Map([[1, parent], [2, child]])
    const view = render(<SidePanel {...props(sessions, 2)} />)
    expect(screen.queryByRole('tab', { name: 'Overview' })).toBeNull()
    view.rerender(<SidePanel {...props(sessions, 1)} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }))
    expect(await screen.findByTestId('overview-content')).toBeTruthy()
    view.rerender(<SidePanel {...props(sessions, 2)} />)
    expect(screen.queryByRole('tab', { name: 'Overview' })).toBeNull()
    expect(screen.getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')).toBe('true')
  })
})
