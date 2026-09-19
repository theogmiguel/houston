// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn().mockResolvedValue(undefined)

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
vi.mock('./host', () => ({ isTauri: () => true }))

const { useBrowserHost } = await import('./browserHost')

function rescopeCalls(): Array<Record<string, unknown>> {
  return invoke.mock.calls
    .filter(([cmd]) => cmd === 'browser_set_workspace')
    .map(([, args]) => args as Record<string, unknown>)
}

describe('re-scoping a live browser surface', () => {
  beforeEach(() => {
    invoke.mockClear()
  })

  it('issues nothing on the first render — the mount already carried the scope', async () => {
    const containerRef = { current: null }
    renderHook(() =>
      useBrowserHost({
        id: 'right-panel',
        url: 'https://example.test/',
        fullscreen: false,
        containerRef,
        workspaceId: '/home/dev/alpha'
      })
    )
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled).catch(() => undefined)
    expect(rescopeCalls()).toEqual([])
  })

  it('re-scopes when the workspace changes under a fixed surface id', async () => {
    const containerRef = { current: null }
    const { rerender } = renderHook(
      ({ ws }: { ws: string | null }) =>
        useBrowserHost({
          id: 'right-panel',
          url: 'https://example.test/',
          fullscreen: false,
          containerRef,
          workspaceId: ws
        }),
      { initialProps: { ws: '/home/dev/alpha' as string | null } }
    )

    rerender({ ws: '/home/dev/beta' })
    await vi.waitFor(() => expect(rescopeCalls().length).toBe(1))
    expect(rescopeCalls()[0]).toEqual({
      id: 'right-panel',
      workspaceId: '/home/dev/beta'
    })
  })

  it('un-scopes to null when the view has no single workspace', async () => {
    const containerRef = { current: null }
    const { rerender } = renderHook(
      ({ ws }: { ws: string | null }) =>
        useBrowserHost({
          id: 'right-panel',
          url: 'https://example.test/',
          fullscreen: false,
          containerRef,
          workspaceId: ws
        }),
      { initialProps: { ws: '/home/dev/alpha' as string | null } }
    )

    rerender({ ws: null })
    await vi.waitFor(() => expect(rescopeCalls().length).toBe(1))
    expect(rescopeCalls()[0].workspaceId).toBeNull()
  })

  it('issues nothing when the workspace is re-rendered unchanged', async () => {
    const containerRef = { current: null }
    const { rerender } = renderHook(
      ({ ws }: { ws: string | null }) =>
        useBrowserHost({
          id: 'leaf-1',
          url: 'https://example.test/',
          fullscreen: false,
          containerRef,
          workspaceId: ws
        }),
      { initialProps: { ws: '/home/dev/alpha' as string | null } }
    )

    rerender({ ws: '/home/dev/alpha' })
    rerender({ ws: '/home/dev/alpha' })
    expect(rescopeCalls()).toEqual([])
  })
})
