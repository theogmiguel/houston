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

function rowDot(status: AgentStatus | null, count = 1, contextPercent?: number): HTMLElement {
  const session = { id: 1, agent: 'codex', status, state: 'running', status_since_ms: null, context: contextPercent == null ? null : { used_percent: contextPercent } } as unknown as SessionInfo
  const agent = { session, agent: 'codex', depth: 0, leading: 'worker', trailing: null, model: 'test-model' } as unknown as RailAgentRow
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<GridRailAgentRows agents={Array.from({ length: count }, (_, index) => ({ ...agent, session: { ...session, id: index + 1 } }))} cardMode="detailed" agentActivity="compact" properties={[]} expanded={false} onToggleExpanded={() => {}} now={0} />))
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
})

describe('rail agent card content', () => {
  it('keeps two agents visible and discloses the remainder for four agents', () => {
    rowDot('idle', 4)
    expect(host!.querySelectorAll('[data-testid="agent-row-dot"]')).toHaveLength(2)
    expect(host!.textContent).toContain('2 more agents')
  })
  it('shows Waiting and replaces the model at the context warning threshold', () => {
    rowDot('needs-input', 1, 80)
    expect(host!.textContent).toContain('Waiting')
    expect(host!.textContent).toContain('80%')
    expect(host!.textContent).not.toContain('test-model')
  })
})
