// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import { agentAttentionFor } from '../../useAgentAttention'
import { useOverviewReviews } from './useOverviewReviews'

afterEach(cleanup)
it('reads bounded workspace details on opening and refreshes only reported changes', () => {
  const callbacks = new Map<string, (message: ServerMsg) => void>()
  const off = vi.fn()
  const harnessState = vi.fn()
  const client = { harnessState, subscribe: (kind: string, callback: (message: ServerMsg) => void) => { callbacks.set(kind, callback); return off } } as unknown as HoustonClient
  const attention = agentAttentionFor({ agentHooks: [], skills: [], checks: [], reviews: Array.from({ length: 12 }, (_, index) => ({ workspace: `/ws/${index}`, attention: 1, open: 1, fixing: 0, awaiting_verification: 0, not_seen: 0, resolved: 0, dismissed: 0, seen_review_id: 0 })) })
  const { result, rerender, unmount } = renderHook(() => useOverviewReviews(client, attention))
  expect(harnessState).toHaveBeenCalledTimes(8)
  rerender()
  expect(harnessState).toHaveBeenCalledTimes(8)
  act(() => callbacks.get('harness_state')?.({ type: 'harness_state', workspace: '/ws/0', routine: null, reviews: [], findings: [], models: [], provider_coverage: [], engine_refusals: [] }))
  expect(result.current.map((state) => state.workspace)).toEqual(['/ws/0'])
  act(() => callbacks.get('harness_changed')?.({ type: 'harness_changed', workspace: '/ws/0' }))
  expect(harnessState).toHaveBeenCalledTimes(9)
  act(() => callbacks.get('harness_changed')?.({ type: 'harness_changed', workspace: '/other' }))
  expect(harnessState).toHaveBeenCalledTimes(9)
  unmount()
  expect(off).toHaveBeenCalledTimes(2)
})
