// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidePanel } from './SidePanel'
import type { SourceControlPanelProps } from './SourceControlPanel'
vi.mock('./SourceControlPanel', () => ({ SourceControlPanel: () => <div>Changes | Pull request</div>, ScmResizeHandle: () => <div /> }))
vi.mock('./FilesPane', () => ({ FilesPane: ({ workspaceDir, openFile }: { workspaceDir: string; openFile: { path: string } }) => <div>Files root: {workspaceDir}; file: {openFile?.path}</div> }))
vi.mock('./OverviewTab', () => ({ OverviewTab: ({ parentId }: { parentId: number }) => <div>Overview {parentId}</div> }))
const props = (): SourceControlPanelProps => ({ dir: '/work', client: {} as SourceControlPanelProps['client'], width: 432, onWidth: vi.fn(), onResetWidth: vi.fn(), tab: 'changes', onTab: vi.fn() })
afterEach(cleanup)
beforeEach(() => localStorage.clear())
describe('side panel host', () => {
  it('opens files in the session workspace and persists the pinned tab', async () => {
    render(<SidePanel {...props()} workspace="/work" sessions={new Map()} request={{ kind: 'files', root: '/child', path: '/child/a.ts', line: 9, col: 2 }} onReviewChild={vi.fn()} onMoveFile={vi.fn()} onFocusSide={vi.fn()} onFocusGrid={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Files root: /child; file: /child/a.ts')).toBeTruthy())
    expect(JSON.parse(localStorage.getItem('tr-side:/work')!).active).toBe(1)
  })
  it('deduplicates overview tabs and closes them without removing pinned tabs', async () => {
    const base = { ...props(), workspace: '/work', sessions: new Map(), onReviewChild: vi.fn(), onMoveFile: vi.fn(), onFocusSide: vi.fn(), onFocusGrid: vi.fn() }
    const view = render(<SidePanel {...base} request={{ kind: 'overview', orchestrator: 7 }} />)
    await waitFor(() => expect(screen.getByText('Overview 7')).toBeTruthy())
    view.rerender(<SidePanel {...base} request={{ kind: 'overview', orchestrator: 7 }} />)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Close Orchestrator 7' }))
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByText('Changes | Pull request')).toBeTruthy()
  })
})
