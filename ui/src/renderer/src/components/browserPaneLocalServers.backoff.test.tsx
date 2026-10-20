// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserPaneLocalServers } from './browserPaneLocalServers'
import type { HoustonClient } from '../houston/client'
import type { ServerMsg } from '../houston/generated/ServerMsg'

type Handler = (message: ServerMsg) => void

afterEach(cleanup)

const reply = (workspace: string, port: number): ServerMsg => ({
  type: 'workspace_local_servers',
  workspace,
  servers: [{ port, process: 'vite', session: 7, pane_title: 'dev' }],
  unsupported: null,
  truncated: false,
})

// Answers every request synchronously through the subscription handler, so the hook
// sees each reply before it schedules the next poll, and records when it asked.
function fakeClient(port: () => number): {
  client: HoustonClient
  requests: number[]
} {
  const requests: number[] = []
  let handler: Handler | undefined
  const client = {
    subscribe(_topic: string, next: Handler) {
      handler = next
      return () => {}
    },
    workspaceLocalServers(workspace: string) {
      requests.push(Date.now())
      handler?.(reply(workspace, port()))
    },
  } as unknown as HoustonClient
  return { client, requests }
}

const offsets = (requests: number[]): number[] => requests.map((time) => time - requests[0])

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useBrowserPaneLocalServers polling', () => {
  it('polls every 3 s while the replies keep changing', () => {
    let port = 3000
    const make = fakeClient(() => port++)
    const { result } = renderHook(() =>
      useBrowserPaneLocalServers(make.client, '/ws', true, false, false)
    )
    act(() => {
      vi.advanceTimersByTime(9_000)
    })
    expect(offsets(make.requests)).toEqual([0, 3_000, 6_000, 9_000])
    expect(result.current.servers[0]?.port).toBe(3003)
  })

  it('backs off to 10 s after two identical replies', () => {
    const make = fakeClient(() => 3000)
    const { result } = renderHook(() =>
      useBrowserPaneLocalServers(make.client, '/ws', true, false, false)
    )
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    // 60 s of unchanged replies: requests at 0, 3, then every 10 s — was 21 at 3 s.
    expect(offsets(make.requests)).toEqual([0, 3_000, 13_000, 23_000, 33_000, 43_000, 53_000])
    expect(result.current.servers[0]?.port).toBe(3000)
  })

  it('resets the backoff when the reply changes', () => {
    let port = 3000
    const make = fakeClient(() => port)
    const { result } = renderHook(() =>
      useBrowserPaneLocalServers(make.client, '/ws', true, false, false)
    )
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(make.requests.at(-2)! + 10_000).toBe(make.requests.at(-1)!)
    port = 4000
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    // The changed reply arrives on the backed-off timer; the next gap is 3 s again.
    expect(make.requests.at(-3)! - make.requests.at(-4)!).toBe(10_000)
    expect(make.requests.at(-1)! - make.requests.at(-2)!).toBe(3_000)
    expect(result.current.servers[0]?.port).toBe(4000)
  })

  it('does not poll while the pane is hidden', () => {
    const make = fakeClient(() => 3000)
    const { rerender } = renderHook(
      ({ hidden }) => useBrowserPaneLocalServers(make.client, '/ws', true, hidden, false),
      { initialProps: { hidden: false } }
    )
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    const visible = make.requests.length
    rerender({ hidden: true })
    act(() => {
      vi.advanceTimersByTime(9_000)
    })
    expect(make.requests.length).toBe(visible)
  })
})
