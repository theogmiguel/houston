// @vitest-environment jsdom
import { useEffect } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidePanel } from './SidePanel'
import type { SourceControlPanelProps } from './SourceControlPanel'
vi.mock('./SourceControlPanel', () => ({ SourceControlPanel: () => <div>Changes | Pull request</div>, ScmResizeHandle: () => <div /> }))
vi.mock('./FilesPane', () => ({ FilesPane: ({ workspaceDir, openFile }: { workspaceDir: string; openFile: { path: string } }) => <div>Files root: {workspaceDir}; file: {openFile?.path}</div> }))
vi.mock('./OverviewTab', () => ({ OverviewTab: ({ parentId }: { parentId: number }) => <div>Overview {parentId}</div> }))
const browserMount = vi.fn(), browserDestroy = vi.fn()
vi.mock('./BrowserPane', () => ({ BrowserPane: ({ node, hiddenByExpand, onMoveToGrid, onClose, loadRequest }: { loadRequest?: unknown; node: { id: string; url: string }; hiddenByExpand: boolean; onMoveToGrid: (url: string) => void; onClose: () => void }) => {
  useEffect(() => { browserMount(node.id); return () => { browserDestroy(node.id) } }, [node.id])
  return <div data-testid={node.id} data-hidden={hiddenByExpand} data-load={JSON.stringify(loadRequest)}><button onClick={() => onMoveToGrid(node.url)}>Move to grid</button><button onClick={onClose}>Close browser content</button></div>
} }))
const props = (): SourceControlPanelProps => ({ dir: '/work', client: {} as SourceControlPanelProps['client'], width: 432, onWidth: vi.fn(), onResetWidth: vi.fn(), tab: 'changes', onTab: vi.fn() })
afterEach(cleanup)
beforeEach(() => { localStorage.clear(); browserMount.mockClear(); browserDestroy.mockClear() })
describe('side panel host', () => {
  it('keeps hidden browser tabs mounted, closes their slots, and reverses placement', async () => {
    const base = { ...props(), workspace: '/work', sessions: new Map(), onReviewChild: vi.fn(), onMoveFile: vi.fn(), onFocusSide: vi.fn(), onFocusGrid: vi.fn() }
    const request = { kind: 'browser' as const, id: 'browser-a', url: 'https://example.test', workspace: '/work' }
    const view = render(<SidePanel {...base} request={request} />)
    await waitFor(() => expect(screen.getByTestId('browser-a')).toBeTruthy())
    expect(browserMount).toHaveBeenCalledExactlyOnceWith('browser-a')
    fireEvent.click(screen.getByRole('tab', { name: 'Source control' }))
    expect(screen.getByTestId('browser-a').getAttribute('data-hidden')).toBe('true')
    expect(browserDestroy).not.toHaveBeenCalled()
    view.rerender(<SidePanel {...base} closed request={request} />)
    expect(browserDestroy).not.toHaveBeenCalled()
    view.rerender(<SidePanel {...base} request={{ ...request }} />)
    const moved = vi.fn()
    window.addEventListener('houston:side-browser-move', moved)
    fireEvent.click(screen.getByText('Move to grid'))
    expect(moved).toHaveBeenCalledWith(expect.objectContaining({ detail: { id: 'browser-a', url: request.url, workspace: '/work' } }))
    expect(browserDestroy).toHaveBeenCalledExactlyOnceWith('browser-a')
    expect(JSON.parse(localStorage.getItem('tr-side:/work')!).tabs).toHaveLength(3)
    window.removeEventListener('houston:side-browser-move', moved)
  })
  it('restores browser tabs from workspace storage', async () => {
    localStorage.setItem('tr-side:/work', JSON.stringify({ tabs: [{ kind: 'scm' }, { kind: 'files' }, { kind: 'browser', id: 'saved-browser', url: 'https://saved.test' }], active: 2 }))
    render(<SidePanel {...props()} workspace="/work" sessions={new Map()} request={null} onReviewChild={vi.fn()} onMoveFile={vi.fn()} onFocusSide={vi.fn()} onFocusGrid={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('saved-browser')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Close https://saved.test' }))
    expect(browserDestroy).toHaveBeenCalledExactlyOnceWith('saved-browser')
  })
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
    expect(screen.getAllByRole('tab')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: 'Close Orchestrator 7' }))
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(screen.getByText('Changes | Pull request')).toBeTruthy()
  })
})

it('expands over the grid and restores by the same control or Escape', () => {
  const onExpanded = vi.fn(), onFocusGrid = vi.fn()
  const base = { ...props(), workspace: '/work', sessions: new Map(), request: null, onReviewChild: vi.fn(), onMoveFile: vi.fn(), onFocusSide: vi.fn(), onFocusGrid, onExpanded }
  const view = render(<SidePanel {...base} />)
  fireEvent.click(screen.getByRole('button', { name: 'Expand side panel' }))
  expect(onExpanded).toHaveBeenLastCalledWith(true)
  view.rerender(<SidePanel {...base} expanded />)
  expect(screen.getByTestId('side-panel').classList.contains('expanded')).toBe(true)
  expect(screen.getByTestId('side-panel').style.width).toBe('100%')
  fireEvent.click(screen.getByRole('button', { name: 'Expand side panel' }))
  expect(onExpanded).toHaveBeenLastCalledWith(false)
  onExpanded.mockClear()
  fireEvent.keyDown(screen.getByTestId('side-panel'), { key: 'Escape' })
  expect(onExpanded).toHaveBeenCalledExactlyOnceWith(false)
  expect(onFocusGrid).not.toHaveBeenCalled()
})

it('selects an explicit browser surface without dispatching a load request', async () => {
  localStorage.setItem('tr-side:/work', JSON.stringify({ tabs: [{ kind: 'scm' }, { kind: 'files' }, { kind: 'browser', id: 'target', url: 'https://current.test' }], active: 0 }))
  render(<SidePanel {...props()} workspace="/work" sessions={new Map()} request={{ kind: 'browser', id: 'target', url: 'https://next.test', workspace: '/work', revealOnly: true }} onReviewChild={vi.fn()} onMoveFile={vi.fn()} onFocusSide={vi.fn()} onFocusGrid={vi.fn()} />)
  await waitFor(() => expect(screen.getByTestId('target')).toBeTruthy())
  expect(screen.getByTestId('target').getAttribute('data-load')).toBeNull()
  expect(screen.getByTestId('target').getAttribute('data-hidden')).not.toBe('true')
  expect(screen.getByRole('tab', { name: 'https://current.test' }).getAttribute('aria-selected')).toBe('true')
})
