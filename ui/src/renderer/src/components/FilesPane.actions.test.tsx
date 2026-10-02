// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilesPane } from './FilesPane'
import type { HoustonClient } from '../houston/client'
import { FILE_REFERENCE_MIME } from './files/fileActions'
const bridge = vi.hoisted(() => ({ readDir: vi.fn(), createFile: vi.fn(), createDirectory: vi.fn(), renameFile: vi.fn(), trashFile: vi.fn(), showItemInFolder: vi.fn(), listEditors: vi.fn().mockResolvedValue([]) }))
vi.mock('../houston/bridge', () => bridge)
vi.mock('./EditorSurface', () => ({ EditorSurfaceBody: () => <div /> }))
vi.mock('./files/useFileTabs', () => ({ useFileTabs: () => ({ activePath: null, tabs: [], pinFile: vi.fn(), previewFile: vi.fn(), surface: { markdownReady: false, setError: vi.fn() }, dirty: false, markMissing: vi.fn() }) }))
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); bridge.readDir.mockResolvedValue([{ name: 'a.ts', path: '/ws/a.ts', dir: false, ignored: false }]) })
afterEach(cleanup)
const mount = (client?: HoustonClient) => render(<FilesPane node={{ kind: 'files', id: 'files', root: '/ws' }} workspaceDir="/ws" onClose={vi.fn()} onHeaderPointerDown={vi.fn()} client={client} />)
describe('Files tree actions', () => {
  it('creates a file through the existing native command', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'New file' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filename' }), { target: { value: 'new.ts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(bridge.createFile).toHaveBeenCalledWith('/ws/new.ts'))
  })
  it('renames with F2 and deletes through the OS trash with Delete', async () => {
    mount()
    const row = await screen.findByRole('treeitem')
    fireEvent.keyDown(row, { key: 'F2' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Filename' }), { target: { value: 'b.ts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(bridge.renameFile).toHaveBeenCalledWith('/ws/a.ts', '/ws/b.ts'))
    fireEvent.keyDown(row, { key: 'Delete' })
    await waitFor(() => expect(bridge.trashFile).toHaveBeenCalledWith('/ws/a.ts'))
  })
  it('creates a directory from the context menu and rejects traversal names', async () => {
    mount()
    const row = await screen.findByRole('treeitem')
    fireEvent.contextMenu(row, { clientX: 100, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'New folder' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filename' }), { target: { value: '..' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(bridge.createDirectory).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filename' }), { target: { value: 'src' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(bridge.createDirectory).toHaveBeenCalledWith('/ws/src'))
  })
  it('uses git status broadcasts and exports a typed file reference drag', async () => {
    let status!: (message: unknown) => void
    const client = { subscribe: (_type: string, callback: (message: unknown) => void) => { status = callback; return () => {} }, gitStatus: vi.fn() } as unknown as HoustonClient
    mount(client)
    const row = await screen.findByRole('treeitem')
    act(() => status({ dir: '/ws', base: null, files: [{ path: 'a.ts', status: 'modified' }] }))
    expect(row.getAttribute('data-git-status')).toBe('modified')
    const setData = vi.fn()
    fireEvent.dragStart(row, { dataTransfer: { setData, effectAllowed: 'none' } })
    expect(setData).toHaveBeenCalledWith(FILE_REFERENCE_MIME, JSON.stringify({ path: '/ws/a.ts', directory: false }))
  })
})
