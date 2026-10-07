// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  readDir: vi.fn(),
  createDirectory: vi.fn(),
  createFile: vi.fn(),
  renameFile: vi.fn(),
  trashFile: vi.fn(() => Promise.resolve()),
  listEditors: vi.fn(),
  openInEditor: vi.fn(),
  copyFilePath: vi.fn(),
  searchFilePaths: vi.fn(),
  watchFileDirs: vi.fn(),
  unwatchFileDirs: vi.fn(),
  onFilesChanged: vi.fn(),
}))
const tabs = vi.hoisted(() => ({
  state: {
    activePath: null as string | null,
    dirty: false,
    activeBuf: undefined as any,
    surface: { ready: false, save: vi.fn(), toggleMarkdownMode: vi.fn() },
    pinFile: vi.fn(),
    setActivePath: vi.fn(),
    markMissing: vi.fn(),
  },
}))
vi.mock('../../houston/bridge', () => bridge)
vi.mock('./useFileTabs', () => ({ useFileTabs: () => tabs.state }))
vi.mock('../../editor/buffers', () => ({
  basename: (path: string) => path.split('/').pop() ?? path,
  reloadBuffer: vi.fn(),
}))
vi.mock('../EditorSurface', () => ({ EditorSurfaceBody: () => <div data-testid="editor-body" /> }))
vi.mock('../MarkdownPreview', () => ({ MarkdownPreview: () => <div /> }))

import { FilesSurface, filesSurfaceLayout } from './FilesSurface'

beforeEach(() => {
  vi.clearAllMocks()
  tabs.state.activePath = null
  tabs.state.dirty = false
  tabs.state.activeBuf = undefined
  bridge.readDir.mockResolvedValue([
    { name: 'src', path: '/ws/src', dir: true, ignored: false },
    { name: 'a.ts', path: '/ws/a.ts', dir: false, ignored: false },
  ])
  bridge.watchFileDirs.mockResolvedValue(undefined)
  bridge.unwatchFileDirs.mockResolvedValue(undefined)
  bridge.listEditors.mockResolvedValue([])
  bridge.onFilesChanged.mockResolvedValue(() => {})
  bridge.searchFilePaths.mockResolvedValue({ items: [], total: 0, truncated: false })
})
afterEach(cleanup)

describe('FilesSurface', () => {
  it('uses the sheet below 560px and keeps the panel breakpoints explicit', () => {
    expect(filesSurfaceLayout(560)).toBe('wide')
    expect(filesSurfaceLayout(559)).toBe('sheet')
    const { rerender } = render(<FilesSurface workspaceRoot="/ws" panelWidth={559} />)
    expect(screen.getByTestId('files-surface').getAttribute('data-layout')).toBe('sheet')
    rerender(<FilesSurface workspaceRoot="/ws" panelWidth={469} />)
    expect(screen.getByTestId('files-surface').hasAttribute('data-panel-crumb-collapsed')).toBe(true)
    rerender(<FilesSurface workspaceRoot="/ws" panelWidth={399} />)
    expect(screen.getByTestId('files-surface').hasAttribute('data-panel-compact')).toBe(true)
  })

  it('tracks sheet visibility and the explorer toggle pressed state', () => {
    tabs.state.activePath = '/ws/a.ts'
    const { container } = render(<FilesSurface workspaceRoot="/ws" panelWidth={559} />)
    const show = screen.getByRole('button', { name: 'Show file explorer' })
    expect(show.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(show)
    expect(screen.getByRole('button', { name: 'Hide file explorer' }).getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('.files-scrim')?.classList.contains('on')).toBe(true)
  })

  it('moves tree focus with arrow keys', async () => {
    render(<FilesSurface workspaceRoot="/ws" panelWidth={600} />)
    const rows = await screen.findAllByRole('treeitem')
    fireEvent.focus(rows[0])
    expect(rows[0].classList.contains('cur')).toBe(true)
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowDown' })
    expect(rows[1].getAttribute('tabindex')).toBe('0')
  })

  it('keeps a duplicate inline rename error visible', async () => {
    bridge.renameFile.mockRejectedValue(new Error('A file named “b.ts” already exists in /ws.'))
    render(<FilesSurface workspaceRoot="/ws" panelWidth={600} />)
    const row = await screen.findByRole('treeitem', { name: 'a.ts' })
    fireEvent.focus(row)
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'F2' })
    const input = screen.getByRole('textbox', { name: 'Rename a.ts' })
    expect((input as HTMLInputElement).value).toBe('a.ts')
    expect((input as HTMLInputElement).selectionStart).toBe(0)
    expect((input as HTMLInputElement).selectionEnd).toBe(1)
    expect(row.parentElement?.contains(input)).toBe(true)
    fireEvent.change(input, { target: { value: 'b.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect((await screen.findByRole('alert')).textContent).toContain('A file named “b.ts” already exists in /ws.')
  })

  it('requires confirmation before deleting a tree entry', async () => {
    render(<FilesSurface workspaceRoot="/ws" panelWidth={600} />)
    const row = await screen.findByRole('treeitem', { name: 'a.ts' })
    fireEvent.contextMenu(row)
    expect(row.classList.contains('menu-on')).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(screen.getByRole('alertdialog', { name: 'Delete a.ts?' })).toBeTruthy()
    expect(screen.getByRole('alertdialog').textContent).toContain('The file will be removed from disk.')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('treeitem', { name: 'a.ts' }).classList.contains('collapsing')).toBe(true)
    await waitFor(() => expect(bridge.trashFile).toHaveBeenCalledWith('/ws/a.ts'))
  })

  it('keeps new file creation inside a tree row', async () => {
    render(<FilesSurface workspaceRoot="/ws" panelWidth={600} />)
    await screen.findByRole('treeitem', { name: 'a.ts' })
    fireEvent.click(screen.getByRole('button', { name: 'New file' }))
    const input = screen.getByRole('textbox', { name: 'New file name' })
    expect(input.closest('.files-row')).toBeTruthy()
    expect(input.getAttribute('placeholder')).toBe('File name')
  })

  it('renders full-workspace search rows with path matches and a truncation notice', async () => {
    bridge.searchFilePaths.mockResolvedValue({
      items: [{ path: 'src/a.ts', name: 'a.ts', isDir: false, nameIndices: [], pathIndices: [0, 1, 2] }],
      total: 18,
      truncated: true,
    })
    render(<FilesSurface workspaceRoot="/ws" panelWidth={600} />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search ws files' }), { target: { value: 'src' } })
    expect(await screen.findByText('More matches available. Refine your search.')).toBeTruthy()
    const result = await screen.findByRole('treeitem', { name: /a\.ts/ })
    expect(result.querySelector('.files-path')?.textContent).toContain('src/a.ts')
    expect(result.querySelectorAll('.files-path b')).toHaveLength(3)
  })

  it('shows the dirty disk-change banner and can keep the editor buffer', async () => {
    tabs.state.activePath = '/ws/a.ts'
    tabs.state.dirty = true
    let changed: ((value: { root: string; paths: string[] }) => void) | undefined
    bridge.onFilesChanged.mockImplementation(async (handler: typeof changed) => {
      changed = handler
      return () => {}
    })
    render(<FilesSurface workspaceRoot="/ws" panelWidth={600} />)
    await waitFor(() => expect(changed).toBeDefined())
    changed?.({ root: '/ws', paths: ['/ws/a.ts'] })
    expect((await screen.findByRole('alert')).textContent).toContain('changed on disk while you were editing')
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
