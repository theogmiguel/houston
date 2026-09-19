// @vitest-environment jsdom
import { act } from 'react'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dropWorkspaceBuffers, getBuffer, noteUpdate } from '../../editor/bufferStore'
import { labelForTab, useFileTabs } from './useFileTabs'

const invokeMock = vi.fn()

function flush(): Promise<void> {
  return act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

async function waitForBuffer(workspaceDir: string, path: string) {
  for (let i = 0; i < 50 && !getBuffer(workspaceDir, path); i++) await flush()
  return getBuffer(workspaceDir, path)
}

beforeEach(() => {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: invokeMock }
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case 'fs_read_file':
        return `content of ${args.filePath as string}\n`
      case 'fs_stat':
        return { mtimeMs: 1 }
      case 'fs_write_file':
        return undefined
      default:
        throw new Error(`unexpected invoke: ${cmd}`)
    }
  })
  localStorage.clear()
  dropWorkspaceBuffers('/ws')
  dropWorkspaceBuffers('/ws-one')
  dropWorkspaceBuffers('/ws-two')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('labelForTab — parent disambiguation', () => {
  it('is the bare basename when nothing else open shares it', () => {
    const tabs = [{ path: '/ws/houston-core/Cargo.toml' }, { path: '/ws/main.rs' }]
    expect(labelForTab(tabs, '/ws/main.rs')).toBe('main.rs')
  })

  it('adds "· parent" for exactly the tabs that collide, leaving a lone one bare', () => {
    const tabs = [
      { path: '/ws/houston-core/Cargo.toml' },
      { path: '/ws/houston-protocol/Cargo.toml' },
      { path: '/ws/README.md' }
    ]
    expect(labelForTab(tabs, '/ws/houston-core/Cargo.toml')).toBe('Cargo.toml · houston-core')
    expect(labelForTab(tabs, '/ws/houston-protocol/Cargo.toml')).toBe('Cargo.toml · houston-protocol')
    expect(labelForTab(tabs, '/ws/README.md')).toBe('README.md')
  })

  it('a path not itself in the list never collides with itself', () => {
    expect(labelForTab([{ path: '/ws/a/x.ts' }], '/ws/a/x.ts')).toBe('x.ts')
  })
})

describe('useFileTabs — preview slot and pin transitions', () => {
  it('a single preview open creates one preview tab and activates it', async () => {
    const { result } = renderHook(() => useFileTabs('/ws'))
    act(() => result.current.previewFile('/ws/a.ts'))
    await flush()
    expect(result.current.tabs).toEqual([{ path: '/ws/a.ts', preview: true, missing: false }])
    expect(result.current.activePath).toBe('/ws/a.ts')
  })

  it('previewing a second file REPLACES the preview tab, never stacks a second one', async () => {
    const { result } = renderHook(() => useFileTabs('/ws'))
    act(() => result.current.previewFile('/ws/a.ts'))
    await flush()
    act(() => result.current.previewFile('/ws/b.ts'))
    await flush()
    expect(result.current.tabs).toEqual([{ path: '/ws/b.ts', preview: true, missing: false }])
    expect(result.current.activePath).toBe('/ws/b.ts')
  })

  it('previewing a file that is already open just activates it, pinned or not', async () => {
    const { result } = renderHook(() => useFileTabs('/ws'))
    act(() => result.current.pinFile('/ws/a.ts'))
    await flush()
    act(() => result.current.previewFile('/ws/b.ts'))
    await flush()
    act(() => result.current.previewFile('/ws/a.ts'))
    await flush()
    expect(result.current.tabs).toEqual([
      { path: '/ws/a.ts', preview: false, missing: false },
      { path: '/ws/b.ts', preview: true, missing: false }
    ])
    expect(result.current.activePath).toBe('/ws/a.ts')
  })

  it('pinning a preview tab promotes it in place — same slot, preview now false', async () => {
    const { result } = renderHook(() => useFileTabs('/ws'))
    act(() => result.current.previewFile('/ws/a.ts'))
    await flush()
    act(() => result.current.pinFile('/ws/a.ts'))
    await flush()
    expect(result.current.tabs).toEqual([{ path: '/ws/a.ts', preview: false, missing: false }])
  })

  it('pinning a file that is not open yet opens it pinned directly, no preview slot involved', async () => {
    const { result } = renderHook(() => useFileTabs('/ws'))
    act(() => result.current.pinFile('/ws/a.ts'))
    await flush()
    expect(result.current.tabs).toEqual([{ path: '/ws/a.ts', preview: false, missing: false }])
  })

  it('a dirty preview tab auto-pins itself — a dirty buffer is never a preview', async () => {
    const { result } = renderHook(() => useFileTabs('/ws'))
    act(() => result.current.previewFile('/ws/a.ts'))
    await flush()
    expect(result.current.tabs[0].preview).toBe(true)
    const buf = await waitForBuffer('/ws', '/ws/a.ts')
    expect(buf, 'the buffer must have loaded by now').toBeDefined()
    act(() => noteUpdate('/ws', '/ws/a.ts', buf!.state, true))
    await flush()
    expect(result.current.tabs).toEqual([{ path: '/ws/a.ts', preview: false, missing: false }])
  })
})

describe('useFileTabs — close variants', () => {
  async function threeCleanTabs() {
    const hook = renderHook(() => useFileTabs('/ws'))
    act(() => hook.result.current.pinFile('/ws/a.ts'))
    await flush()
    act(() => hook.result.current.pinFile('/ws/b.ts'))
    await flush()
    act(() => hook.result.current.pinFile('/ws/c.ts'))
    await flush()
    return hook
  }

  it('requestCloseTab on a clean tab closes it immediately, no confirm', async () => {
    const { result } = await threeCleanTabs()
    act(() => result.current.requestCloseTab('/ws/b.ts'))
    expect(result.current.tabs.map((t) => t.path)).toEqual(['/ws/a.ts', '/ws/c.ts'])
    expect(result.current.confirmClose).toBeNull()
  })

  it('requestCloseTab on a DIRTY tab opens the confirm prompt instead of closing', async () => {
    const { result } = await threeCleanTabs()
    const buf = getBuffer('/ws', '/ws/b.ts')!
    act(() => noteUpdate('/ws', '/ws/b.ts', buf.state, true))
    act(() => result.current.requestCloseTab('/ws/b.ts'))
    expect(result.current.confirmClose).toBe('/ws/b.ts')
    expect(result.current.tabs.map((t) => t.path)).toEqual(['/ws/a.ts', '/ws/b.ts', '/ws/c.ts'])
  })

  it('closeOthers keeps the target and drops every other clean tab', async () => {
    const { result } = await threeCleanTabs()
    act(() => result.current.closeOthers('/ws/b.ts'))
    expect(result.current.tabs.map((t) => t.path)).toEqual(['/ws/b.ts'])
    expect(result.current.activePath).toBe('/ws/b.ts')
  })

  it('closeOthers SKIPS a dirty tab among the others rather than prompting for it', async () => {
    const { result } = await threeCleanTabs()
    const buf = getBuffer('/ws', '/ws/c.ts')!
    act(() => noteUpdate('/ws', '/ws/c.ts', buf.state, true))
    act(() => result.current.closeOthers('/ws/a.ts'))
    expect(result.current.tabs.map((t) => t.path)).toEqual(['/ws/a.ts', '/ws/c.ts'])
  })

  it('closeToRight keeps the target and everything at or before it, drops clean tabs after it', async () => {
    const { result } = await threeCleanTabs()
    act(() => result.current.closeToRight('/ws/a.ts'))
    expect(result.current.tabs.map((t) => t.path)).toEqual(['/ws/a.ts'])
  })

  it('closeToRight is a no-op when the named path is not open', async () => {
    const { result } = await threeCleanTabs()
    act(() => result.current.closeToRight('/ws/not-open.ts'))
    expect(result.current.tabs.map((t) => t.path)).toEqual(['/ws/a.ts', '/ws/b.ts', '/ws/c.ts'])
  })

  it('closeSaved drops every clean tab wherever it sits, keeping only dirty ones', async () => {
    const { result } = await threeCleanTabs()
    const buf = getBuffer('/ws', '/ws/b.ts')!
    act(() => noteUpdate('/ws', '/ws/b.ts', buf.state, true))
    act(() => result.current.closeSaved())
    expect(result.current.tabs.map((t) => t.path)).toEqual(['/ws/b.ts'])
  })

  it('closing the active tab focuses the neighbour that slid into its slot', async () => {
    const { result } = await threeCleanTabs()
    act(() => result.current.setActivePath('/ws/b.ts'))
    act(() => result.current.requestCloseTab('/ws/b.ts'))
    expect(result.current.activePath).toBe('/ws/c.ts')
  })
})

describe('useFileTabs — per-workspace persistence', () => {
  it('a fresh hook for the same workspace restores the tab list, preview flags and active tab', async () => {
    const first = renderHook(() => useFileTabs('/ws'))
    act(() => first.result.current.pinFile('/ws/a.ts'))
    await flush()
    act(() => first.result.current.previewFile('/ws/b.ts'))
    await flush()
    first.unmount()

    const second = renderHook(() => useFileTabs('/ws'))
    expect(second.result.current.tabs).toEqual([
      { path: '/ws/a.ts', preview: false, missing: false },
      { path: '/ws/b.ts', preview: true, missing: false }
    ])
    expect(second.result.current.activePath).toBe('/ws/b.ts')
  })

  it('a different workspace never sees another workspace’s persisted tabs', async () => {
    const first = renderHook(() => useFileTabs('/ws-one'))
    act(() => first.result.current.pinFile('/ws-one/a.ts'))
    await flush()
    first.unmount()

    const other = renderHook(() => useFileTabs('/ws-two'))
    expect(other.result.current.tabs).toEqual([])
    expect(other.result.current.activePath).toBeNull()
  })

  it('a restored tab is never dropped for being unverified — markMissing flags it instead', async () => {
    const first = renderHook(() => useFileTabs('/ws'))
    act(() => first.result.current.pinFile('/ws/gone.ts'))
    await flush()
    first.unmount()

    const second = renderHook(() => useFileTabs('/ws'))
    expect(second.result.current.tabs.map((t) => t.path)).toEqual(['/ws/gone.ts'])
    act(() => second.result.current.markMissing('/ws/gone.ts', true))
    expect(second.result.current.tabs).toEqual([{ path: '/ws/gone.ts', preview: false, missing: true }])
  })

  it('malformed persisted JSON is treated as no tabs, not a thrown error', () => {
    localStorage.setItem('tr-files-tabs:/ws', '{not json')
    const { result } = renderHook(() => useFileTabs('/ws'))
    expect(result.current.tabs).toEqual([])
    expect(result.current.activePath).toBeNull()
  })
})
