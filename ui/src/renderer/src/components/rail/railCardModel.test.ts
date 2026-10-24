import { describe, expect, it } from 'vitest'
import { buildRailCard } from './railCardModel'
import type { SessionInfo } from '../../houston/client'

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 1,
    agent: 'claude',
    project_dir: '/repo',
    cwd: '/repo',
    state: 'running',
    title: 'Implement rail',
    codename: 'test',
    hidden: false,
    live_children: 0,
    children_waiting: 0,
    inbox_unread: 0,
    tags: [],
    resumable: false,
    ...overrides,
  } as SessionInfo
}

describe('buildRailCard', () => {
  it('projects pane order, checkout identity and agent activity into a grid card', () => {
    const primary = session({ id: 1, checkout_root: '/repo', spawned_by: null, status_since_ms: 10 })
    const child = session({
      id: 2,
      cwd: '/repo/wt/card',
      spawned_by: 1,
      worktree: { path: '/repo/wt/card', branch: 'feature/card' } as SessionInfo['worktree'],
      inbox_unread: 1,
      status_since_ms: 20,
    })
    const card = buildRailCard({
      gridId: 'g1',
      workspace: '/repo',
      title: 'Rail cards',
      paneIds: [1, 2],
      sessions: [child, primary],
      branches: new Map([[1, 'main']]),
    })

    expect(card.checkouts).toEqual([
      { kind: 'primary', root: '/repo', branch: 'main', detached: false },
      { kind: 'worktree', root: '/repo/wt/card', slug: 'feature/card', branch: 'feature/card', detached: false },
    ])
    expect(card.agents.map((agent) => [agent.session.id, agent.depth])).toEqual([
      [1, 0],
      [2, 1],
    ])
    expect(card.agents[1].unread).toBe(true)
    expect(card.lastActivityMs).toBe(20)
  })

  it('shows the agent a shell pane is running and falls back to shell without one', () => {
    const running = session({ id: 1, agent: 'shell', running_agent: 'codex' })
    const idle = session({ id: 2, agent: 'shell', running_agent: null })
    const claude = session({ id: 3, agent: 'claude', running_agent: 'codex' })
    const card = buildRailCard({ gridId: 'g', workspace: '/repo', title: 'G', paneIds: [1, 2, 3], sessions: [running, idle, claude] })
    expect(card.agents.map((row) => row.agent)).toEqual(['codex', 'shell', 'claude'])
  })

  it('shows an idle orchestrator as working while a child outside the grid works', () => {
    const card = buildRailCard({
      gridId: 'g1',
      workspace: '/repo',
      title: 'Orchestrated',
      paneIds: [1],
      sessions: [session({ id: 1, status: 'idle' }), session({ id: 2, status: 'working', spawned_by: 1 })],
    })
    expect(card.status.kind).toBe('working')
    expect(card.agents.map((agent) => agent.session.status)).toEqual(['working'])
  })

  it('returns empty checkouts and idle status for an empty grid', () => {
    const card = buildRailCard({ gridId: 'empty', workspace: '/repo', title: 'Empty', paneIds: [], sessions: [] })
    expect(card.checkouts).toEqual([])
    expect(card.status.kind).toBe('idle')
  })

  it('marks a pane that finished unseen as unread', () => {
    const card = buildRailCard({
      gridId: 'g1',
      workspace: '/repo',
      title: 'Finished unseen',
      paneIds: [1, 2],
      sessions: [session({ id: 1, status: 'idle' }), session({ id: 2, status: 'idle' })],
      finishedUnseen: new Set([2]),
    })
    expect(card.agents[0].unread).toBe(false)
    expect(card.agents[1].unread).toBe(true)
  })

  it('keeps a finished-unseen pane read when the pane is not marked', () => {
    const card = buildRailCard({
      gridId: 'g1',
      workspace: '/repo',
      title: 'Idle',
      paneIds: [1],
      sessions: [session({ id: 1, status: 'idle' })],
      finishedUnseen: new Set([9]),
    })
    expect(card.agents[0].unread).toBe(false)
  })
})


describe('buildRailCard notes', () => {
  it('shows the newest note among the grid panes, with its pane and phase', () => {
    const older = session({ id: 1, title: 'Max', note: { text: 'reading the code', phase: 'todo', at_ms: 1_000 } })
    const newer = session({ id: 2, title: 'Leo', spawned_by: 1, note: { text: 'running tests', phase: 'in_progress', at_ms: 2_000 } })
    const card = buildRailCard({ gridId: 'g', workspace: '/repo', title: 'g', paneIds: [1, 2], sessions: [older, newer] })
    expect(card.note).toEqual({ session: 2, pane: 'Leo', text: 'running tests', phase: 'in_progress', atMs: 2_000 })
  })

  it('has no note when no pane wrote one', () => {
    const card = buildRailCard({ gridId: 'g', workspace: '/repo', title: 'g', paneIds: [1], sessions: [session({ id: 1 })] })
    expect(card.note).toBeNull()
  })
})
