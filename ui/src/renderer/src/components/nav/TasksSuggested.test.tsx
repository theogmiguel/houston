// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import type { HarnessFinding } from '../../houston/generated/HarnessFinding'
import { TasksSurface } from './TasksSurface'

afterEach(cleanup)
const finding = (key: string, extra: Partial<HarnessFinding> = {}): HarnessFinding => ({
  review_id: 7, last_seen_review_id: 7, key: key.toLowerCase().replaceAll(' ', '-'), title: key, category: 'instructions', confidence: 'high', sessions: ['one'], count: 1,
  quotes: [], recommendation_kind: 'instruction', target: 'AGENTS.md', recommendation: 'Fix it', apply_prompt: 'Fix safely',
  state: 'open', recurred: false, phase: 'open', ...extra
})
it('suggests only open findings without tasks in scope and routes actions to their workspace', () => {
  const handlers = new Map<string, Set<(message: ServerMsg) => void>>()
  const harnessState = vi.fn(), harnessFixTask = vi.fn(), harnessDecide = vi.fn()
  const base = { harnessState, harnessFixTask, harnessDecide,
    subscribe: (type: string, callback: (message: ServerMsg) => void) => {
      const set = handlers.get(type) ?? new Set(); set.add(callback); handlers.set(type, set)
      return () => set.delete(callback)
    }
  }
  const noop = () => {}
  const client = new Proxy(base, { get: (target, key) => key in target ? target[key as keyof typeof base] : noop }) as unknown as HoustonClient
  const props = { client, workspace: '/a', workspaces: [{ path: '/a', name: 'A' }, { path: '/b', name: 'B' }], sessions: new Map(), now: 1,
    onStartRequested: vi.fn(), onOpenSession: vi.fn(), onReview: vi.fn(), onOpenExternal: vi.fn() }
  const { rerender } = render(<TasksSurface {...props} />)
  expect(harnessState).toHaveBeenCalledWith('/a')
  expect(harnessState).not.toHaveBeenCalledWith('/b')
  const emit = (workspace: string, findings: HarnessFinding[]) => act(() => handlers.get('harness_state')?.forEach((handler) => handler({ type: 'harness_state', workspace, findings, routine: null, reviews: [], models: [], provider_coverage: [], engine_refusals: [] })))
  emit('/a', [finding('Suggested fix'), finding('Dismissed', { phase: 'dismissed' }), finding('Already queued', { task: { task_id: 3, key: 'A-3', status: 'backlog' } })])
  emit('/b', [finding('Outside scope')])
  expect(screen.getByText('Suggested fix')).toBeTruthy()
  expect(screen.queryByText('Dismissed')).toBeNull()
  expect(screen.queryByText('Already queued')).toBeNull()
  expect(screen.queryByText('Outside scope')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Add to queue' }))
  expect(harnessFixTask).toHaveBeenCalledWith('/a', 'suggested-fix', 'claude', 'Fix safely')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(harnessDecide).toHaveBeenCalledWith('/a', 'suggested-fix', 'dismissed')
  rerender(<TasksSurface {...props} workspace="" />)
  expect(harnessState).toHaveBeenCalledWith('/b')
  emit('/b', [finding('Other workspace')])
  expect(screen.getByText('Other workspace')).toBeTruthy()
})
