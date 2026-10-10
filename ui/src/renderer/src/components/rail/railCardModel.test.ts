import { describe, expect, it } from 'vitest'
import { buildRailCard, isRailCardQuiet } from './railCardModel'
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
})

describe('rail card quiet status', () => {
  it('marks working status quiet at ten minutes and keeps the threshold inclusive', () => {
    expect(isRailCardQuiet({ kind: 'working', label: 'Working', since: 1_000 }, 600_999)).toBe(false)
    expect(isRailCardQuiet({ kind: 'working', label: 'Working', since: 1_000 }, 601_000)).toBe(true)
    expect(isRailCardQuiet({ kind: 'idle', label: 'Idle', since: 1_000 }, 601_000)).toBe(false)
  })
})
