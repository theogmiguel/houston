// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrInfo } from '../../houston/client'
import { clearPrsViewRequest, mergeQueuePaletteActions, mergeQueuePauseAction, usePrsViewRequest } from './prsView'
import { act, renderHook } from '@testing-library/react'

function pr(state: string): PrInfo {
  return { number: 12, url: 'https://github.com/acme/repo/pull/12', state, title: 'Change', head_ref: 'feature', additions: 1, deletions: 0 } as PrInfo
}

afterEach(clearPrsViewRequest)

describe('mergeQueuePaletteActions', () => {
  const sessions = new Map([[7, { cwd: '/repo/.houston/worktrees/a' }]])

  it('adds the focused checkout’s open pull request and opens the merge queue', () => {
    const selectNavRow = vi.fn()
    const actions = mergeQueuePaletteActions(new Map([['/repo/.houston/worktrees/a', { pr: pr('OPEN') }]]), sessions, 7, selectNavRow)
    const { result } = renderHook(() => usePrsViewRequest())
    act(() => actions.addToMergeQueue?.())
    expect(selectNavRow).toHaveBeenCalledWith('prs')
    expect(result.current).toEqual({ view: 'queue', enqueue: 12 })
  })

  it('offers no add without a focused pane or an open pull request', () => {
    expect(mergeQueuePaletteActions(new Map([['/repo/.houston/worktrees/a', { pr: pr('MERGED') }]]), sessions, 7, vi.fn()).addToMergeQueue).toBeUndefined()
    expect(mergeQueuePaletteActions(new Map(), sessions, null, vi.fn()).addToMergeQueue).toBeUndefined()
  })
})

describe('the palette pause', () => {
  it('pauses the selected workspace’s queue, and is absent with every workspace shown', () => {
    const mergeQueuePause = vi.fn(() => 1)
    mergeQueuePauseAction({ mergeQueuePause }, '/repo').pauseMergeQueue?.()
    expect(mergeQueuePause).toHaveBeenCalledWith('/repo', true)
    expect(mergeQueuePauseAction({ mergeQueuePause }, 'all').pauseMergeQueue).toBeUndefined()
  })
})
