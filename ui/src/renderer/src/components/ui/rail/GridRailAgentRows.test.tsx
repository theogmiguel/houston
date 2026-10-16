// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionInfo, AgentStatus } from '../../../houston/client'
import type { RailAgentRow } from '../../rail/railCardModel'
import { GridRailAgentRows } from './GridRailAgentRows'

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  root = null
  host = null
})

function rowDot(status: AgentStatus | null, count = 1, contextPercent?: number, { since = null as number | null, now = 0 } = {}): HTMLElement {
  const session = { id: 1, agent: 'codex', status, state: 'running', status_since_ms: since, context: contextPercent == null ? null : { used_percent: contextPercent } } as unknown as SessionInfo
  const agent = { session, agent: 'codex', depth: 0, leading: 'worker', trailing: null, model: 'test-model' } as unknown as RailAgentRow
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<GridRailAgentRows agents={Array.from({ length: count }, (_, index) => ({ ...agent, session: { ...session, id: index + 1 } }))} cardMode="detailed" agentActivity="compact" properties={['inline-agents']} expanded={false} onToggleExpanded={() => {}} now={now} />))
  const dot = host.querySelector<HTMLElement>('[data-testid="agent-row-dot"]')
  if (!dot) throw new Error('agent row did not render its status dot')
  return dot
}

describe('rail agent row status dot', () => {
  it.each(['unavailable', 'spawning', null] as const)('%s never paints completion green', (status) => {
    expect(rowDot(status).className).not.toContain('--ok')
  })

  it('unavailable is a readable outline', () => {
    expect(rowDot('unavailable').className).toContain('border-[var(--text-secondary)]')
  })

  it('spawning paints the accent', () => {
    expect(rowDot('spawning').className).toContain('bg-[var(--accent)]')
  })

  it('a long working turn keeps spinning instead of turning into a static ring', () => {
    const dot = rowDot('working', 1, undefined, { since: 0, now: 30 * 60_000 })
    expect(dot.className).toContain('animate-[spin')
    expect(dot.getAttribute('aria-label')).not.toContain('No recent update')
  })
})

function mountAgents(statuses: (AgentStatus | null)[], { expanded = false, contexts = [] as (number | undefined)[] } = {}): HTMLDivElement {
  const agents = statuses.map((status, index) => {
    const context = contexts[index]
    const session = { id: index + 1, agent: 'codex', status, state: 'running', status_since_ms: null, context: context == null ? null : { used_percent: context } } as unknown as SessionInfo
    return { session, agent: 'codex', depth: 0, leading: `worker-${index + 1}`, trailing: null, model: 'test-model' } as unknown as RailAgentRow
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<GridRailAgentRows agents={agents} cardMode="detailed" agentActivity="compact" properties={['inline-agents']} expanded={expanded} onToggleExpanded={() => {}} now={0} />))
  return host
}

const rowLabels = (el: HTMLElement): string[] => [...el.querySelectorAll('button[aria-label^="Focus "]')].map((row) => row.getAttribute('aria-label')!)

describe('rail agent card content', () => {
  it('lists each agent while a grid has two or fewer', () => {
    const el = mountAgents(['idle', 'working'])
    expect(rowLabels(el)).toEqual(['Focus worker-1', 'Focus worker-2'])
    expect(el.querySelector('button[aria-expanded]')).toBeNull()
  })
  it('summarises a quiet grid of more than two agents in one pill', () => {
    const el = mountAgents(['idle', 'working', 'idle', 'idle'])
    expect(rowLabels(el)).toEqual([])
    expect(el.querySelector('button[aria-expanded="false"]')?.textContent).toContain('4 agents')
  })
  it('keeps agents that need the user as rows under the collapsed pill', () => {
    const el = mountAgents(['idle', 'working', 'needs-input', 'idle'], { contexts: [undefined, 85] })
    expect(rowLabels(el)).toEqual(['Focus worker-2', 'Focus worker-3'])
    expect(el.textContent).toContain('Waiting')
    expect(el.textContent).toContain('85%')
  })
  it('lists every agent once the pill is expanded', () => {
    const el = mountAgents(['idle', 'working', 'idle', 'idle'], { expanded: true })
    expect(rowLabels(el)).toHaveLength(4)
    expect(el.querySelector('button[aria-expanded="true"]')).not.toBeNull()
  })
  it('shows Waiting and replaces the model at the context warning threshold', () => {
    rowDot('needs-input', 1, 80)
    expect(host!.textContent).toContain('Waiting')
    expect(host!.querySelector('time')?.className).toContain('text-[var(--warn)]')
    expect(host!.textContent).toContain('80%')
    expect(host!.textContent).not.toContain('test-model')
  })
})
