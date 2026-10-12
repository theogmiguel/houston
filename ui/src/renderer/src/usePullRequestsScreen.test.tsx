// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { HoustonClient, ServerMsg } from './houston/client'
import { usePullRequestsScreen } from './usePullRequestsScreen'

afterEach(cleanup)

class ListClient {
  calls: { dir: string; involvement: string; request: number }[] = []
  prList(dir: string, _state: string, involvement: string): number {
    const request = this.calls.length + 1
    this.calls.push({ dir, involvement, request })
    return request
  }
}
function reply(dir: string, request: number, viewer_login: string | null): Extract<ServerMsg, { type: 'pr_list' }> {
  return { type: 'pr_list', dir, request, viewer_login, items: [], truncated: false, message: null }
}

describe('pull request page listing', () => {
  it('uses the reported viewer login even when the viewer has no authored pull requests', () => {
    const client = new ListClient()
    const { result, unmount } = renderHook(() => usePullRequestsScreen(client as unknown as HoustonClient, '/repo', true))
    act(() => result.current.handleMessage(reply('/repo', 1, 'theo')))
    expect(result.current.viewerLogin).toBe('theo')
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].involvement).toBe('all')
    unmount()
  })

  it('ignores a previous workspace reply after the repository changes', () => {
    const client = new ListClient()
    const { result, rerender, unmount } = renderHook(({ dir }) => usePullRequestsScreen(client as unknown as HoustonClient, dir, true), { initialProps: { dir: '/repo' } })
    rerender({ dir: '/other' })
    act(() => result.current.handleMessage(reply('/repo', 1, 'stale-viewer')))
    expect(result.current.viewerLogin).toBe('')
    const latest = client.calls.at(-1)!
    act(() => result.current.handleMessage(reply('/other', latest.request, 'viewer')))
    expect(result.current.viewerLogin).toBe('viewer')
    unmount()
  })
})
