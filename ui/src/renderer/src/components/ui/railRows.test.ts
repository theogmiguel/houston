import { describe, expect, it } from 'vitest'
import type { PrInfo, SessionInfo } from '../../houston/client'
import { formatRailDuration, gridStatus, hasWorkingDescendant, liftDelegatedWork } from './railRows'
import { orderGridPanes, railHoverCardModel } from './railRowModel'

function pane(overrides: Partial<SessionInfo> & { id: number }): SessionInfo {
  const { id, ...rest } = overrides
  return {
    id,
    agent: rest.agent ?? 'claude',
    project_dir: '/work',
    cwd: '/work',
    state: rest.state ?? 'running',
    title: rest.title ?? `pane-${id}`,
    codename: `pane-${id}`,
    hidden: false,
    live_children: 0,
    children_waiting: 0,
    inbox_unread: 0,
    tags: [],
    resumable: false,
    ...rest,
  } as SessionInfo
}

describe('rail row models', () => {
  it('chooses the highest grid status and the earliest duration for a tie', () => {
    expect(gridStatus([
      pane({ id: 1, status: 'working', status_since_ms: 10_000 }),
      pane({ id: 2, status: 'needs-input', status_since_ms: 12_000 }),
      pane({ id: 3, status: 'needs-input', status_since_ms: 8_000 }),
    ])).toEqual({ kind: 'needs-input', label: 'Input', since: 8_000 })
  })

  it('promotes panes waiting on children to the needs-input aggregate', () => {
    expect(gridStatus([pane({ id: 4, status: 'working', children_waiting: 1, status_since_ms: 9_000 })])).toEqual({ kind: 'needs-input', label: 'Input', since: null })
  })

  it('reports an idle orchestrator as working while a live descendant works', () => {
    const sessions = [
      pane({ id: 1, status: 'idle' }),
      pane({ id: 2, status: 'idle', spawned_by: 1 }),
      pane({ id: 3, status: 'working', spawned_by: 2 }),
    ]
    expect(hasWorkingDescendant(1, sessions)).toBe(true)
    expect(liftDelegatedWork(sessions[0], sessions).status).toBe('working')
    expect(gridStatus([liftDelegatedWork(sessions[0], sessions)]).kind).toBe('working')
  })

  it('keeps the orchestrator status when its descendants are idle, exited or waiting on it', () => {
    const idle = [pane({ id: 1, status: 'idle' }), pane({ id: 2, status: 'idle', spawned_by: 1 })]
    expect(liftDelegatedWork(idle[0], idle)).toBe(idle[0])
    const exited = [pane({ id: 1, status: 'idle' }), pane({ id: 2, status: 'working', state: 'exited', spawned_by: 1 })]
    expect(liftDelegatedWork(exited[0], exited)).toBe(exited[0])
    const asking = [pane({ id: 1, status: 'needs-input' }), pane({ id: 2, status: 'working', spawned_by: 1 })]
    expect(liftDelegatedWork(asking[0], asking)).toBe(asking[0])
  })

  it('orders child panes below their parent and preserves unrelated pane order', () => {
    const rows = orderGridPanes([
      pane({ id: 4, spawned_by: 2 }),
      pane({ id: 2 }),
      pane({ id: 3 }),
    ], [4, 2, 3])
    expect(rows.map(({ session, depth }) => [session.id, depth])).toEqual([[2, 0], [4, 1], [3, 0]])
  })

  it('formats durations like the rail labels', () => {
    expect(formatRailDuration(0, 60_000 * 22)).toBe('22m')
    expect(formatRailDuration(0, 60_000 * 60 * 24 * 12)).toBe('12d')
    expect(formatRailDuration(null)).toBeNull()
  })

  it('models parent panes, shared checkouts, branch facts, diff and cached PR state', () => {
    const parent = pane({ id: 1, checkout_root: '/work/shared' })
    const child = pane({ id: 2, checkout_root: '/work/shared', spawned_by: 1 })
    const pr: PrInfo = {
      number: 7,
      url: '/pull/7',
      state: 'OPEN',
      review_decision: null,
      checks: 'running',
      title: 'Rail update',
      head_ref: 'feature/rail',
      additions: 0,
      deletions: 0,
      is_draft: false,
    }
    const model = railHoverCardModel(
      [child, parent], [1, 2], new Map([[1, 'main']]),
      new Map([['/work/shared', { added: 8, deleted: 2 }]]),
      new Map([['/work/shared', { gh: 'ready', pr }]]),
    )
    expect(model.panes.map(({ session, depth }) => [session.id, depth])).toEqual([[1, 0], [2, 1]])
    expect(model.checkouts).toHaveLength(1)
    expect(model.checkouts[0]).toMatchObject({ path: '/work/shared', branch: 'main', diff: { added: 8, deleted: 2 }, pr: { gh: 'ready', pr: { number: 7 } } })
  })
})
