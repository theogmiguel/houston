// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
vi.mock('./host', () => ({ isTauri: () => true }))
import { useBrowserHost } from './browserHost'

afterEach(cleanup)

describe('moving a browser surface between hosts', () => {
  it('waits for native destruction before remounting the same id', async () => {
    let finishDestroy: (() => void) | undefined
    const rect = { x: 0, y: 0, width: 400, height: 300 }
    invoke.mockImplementation((cmd) => cmd === 'browser_destroy' ? new Promise<void>((resolve) => { finishDestroy = resolve }) : Promise.resolve(rect))
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
    const container = document.createElement('div')
    document.body.append(container)
    const options = { id: 'moving-browser', url: 'https://example.test', fullscreen: false, containerRef: { current: container }, workspaceId: '/work' }
    const first = renderHook(() => useBrowserHost(options))
    await waitFor(() => expect(invoke.mock.calls.filter(([cmd]) => cmd === 'browser_mount')).toHaveLength(1))
    first.unmount()
    const second = renderHook(({ workspaceId }) => useBrowserHost({ ...options, workspaceId }), { initialProps: { workspaceId: '/work' } })
    await waitFor(() => expect(finishDestroy).toBeDefined())
    second.rerender({ workspaceId: '/work/new' })
    await waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === 'browser_set_workspace')).toBe(true))
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'browser_mount')).toHaveLength(1)
    await act(async () => finishDestroy!())
    await waitFor(() => expect(invoke.mock.calls.filter(([cmd]) => cmd === 'browser_mount')).toHaveLength(2))
    second.unmount()
    await act(async () => finishDestroy!())
    container.remove()
    vi.unstubAllGlobals()
  })
})
