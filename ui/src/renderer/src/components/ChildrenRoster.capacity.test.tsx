// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ChildrenRoster } from './ChildrenRoster'
import { withInputOwner } from '../test/inputFixtures'
import type { HoustonClient, SessionInfo } from '../houston/client'

vi.mock('./tasks/RosterQueue', () => ({
  RosterQueue: ({ live, cap, settled }: { live: number; cap: number; settled: number }) => <p>{live} of {cap} live; {settled} ended</p>
}))
afterEach(cleanup)

it('counts idle, parent-waiting and staged reusable PTYs against queue capacity', async () => {
  const parent: SessionInfo = { id: 1, agent: 'claude', project_dir: '/work', cwd: '/work', state: 'running', title: 'Parent', title_source: 'prompt', codename: 'Max', hidden: false, live_children: 3, children_waiting: 0, inbox_unread: 0, tags: [], resumable: false }
  const child = (id: number): SessionInfo => ({ ...parent, id, spawned_by: 1, status: 'idle', delegation: { parent: 1, started_at: 1000, state: 'working', stalled: false, result_staged: false, superseded: 0, turn_end_source: 'stop-hook', inbox_owed: 0, inbox_provisional: 0, reusable: true } })
  const idle = child(2)
  const waiting = withInputOwner(child(3), 'orchestrator', 'Which file?')
  const staged = child(4)
  staged.status = 'working'
  staged.delegation!.result_staged = true
  const ended = { ...child(5), state: 'exited' as const }
  const children = [idle, waiting, staged, ended]
  render(<ChildrenRoster parent={parent} children={children} roster={{ sessions: new Map([parent, ...children].map((s) => [s.id, s])), maxLiveChildren: 3 }} client={{ subscribe: () => () => {}, taskSnapshot: vi.fn() } as unknown as HoustonClient} selected={null} onSelect={vi.fn()} onMove={vi.fn()} collapsed={false} onCollapse={vi.fn()} onExpand={vi.fn()} defaultView="queue" />)
  expect(await screen.findByText('3 of 3 live; 1 ended')).toBeTruthy()
})
