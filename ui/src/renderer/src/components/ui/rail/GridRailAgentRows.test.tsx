// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentStatus, SessionInfo } from '../../../houston/client'
import type { RailAgentRow } from '../../rail/railCardModel'
import { GridRailAgentRows } from './GridRailAgentRows'
import { rememberSessionExitCode, resetSessionExitCodes } from '../../../sessionExitCodes'

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  root = null
  host = null
  resetSessionExitCodes()
})

function mount(statuses: (AgentStatus | null)[], { selectedSessionId, since = null as number | null, now = 0 }: { selectedSessionId?: number; since?: number | null; now?: number } = {}): HTMLDivElement {
  const agents = statuses.map((status, index) => {
    const session = { id: index + 1, agent: 'codex', status, state: 'running', status_since_ms: since } as unknown as SessionInfo
    return { session, agent: 'codex', depth: 0, leading: `worker-${index + 1}`, trailing: null, model: 'test-model' } as unknown as RailAgentRow
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<GridRailAgentRows agents={agents} selectedSessionId={selectedSessionId} now={now} />))
  return host
}

const rows = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[data-testid="agent-row"]')]

describe('rail session rows', () => {
  it('renders every session as a 28px row, with no summary pill', () => {
    const el = mount(['idle', 'working', 'idle', 'idle'])
    expect(rows(el)).toHaveLength(4)
    for (const row of rows(el)) expect(row.className).toContain('h-[var(--h-row)]')
    expect(el.querySelector('button[aria-expanded]')).toBeNull()
  })

  it('marks the selected session row and leaves the rest plain', () => {
    const el = mount(['idle', 'working'], { selectedSessionId: 2 })
    expect(rows(el)[0].className).not.toContain('bg-[var(--sel)]')
    expect(rows(el)[1].className).toContain('bg-[var(--sel)]')
    expect(rows(el)[1].querySelector('span.min-w-0')?.className).toContain('font-semibold')
  })

  it('uses one status glyph per state', () => {
    const el = mount(['working', 'needs-input', 'idle'])
    expect(el.querySelector('[data-status-glyph="working"]')).not.toBeNull()
    expect(el.querySelector('[data-status-glyph="needs"]')).not.toBeNull()
    expect(el.querySelector('[data-status-glyph="finished"]')).toBeNull()
  })

  it('renders a completed turn as the finished glyph, not a live spinner', () => {
    const session = { id: 7, agent: 'codex', status: 'idle', state: 'exited', status_since_ms: 0 } as unknown as SessionInfo
    const agent = { session, agent: 'codex', depth: 0, leading: 'worker', trailing: null, model: null } as unknown as RailAgentRow
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    rememberSessionExitCode(7, 0)
    act(() => root!.render(<GridRailAgentRows agents={[agent]} now={0} />))
    expect(host.querySelector('[data-status-glyph="finished"]')).not.toBeNull()
    expect(host.querySelector('[data-status-glyph="working"]')).toBeNull()
  })

  it('reads an exited session by its exit code', () => {
    const session = { id: 9, agent: 'shell', status: 'idle', state: 'exited', status_since_ms: 0 } as unknown as SessionInfo
    const agent = { session, agent: 'shell', depth: 0, leading: 'shell', trailing: null, model: null } as unknown as RailAgentRow
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    rememberSessionExitCode(9, 2)
    act(() => root!.render(<GridRailAgentRows agents={[agent]} now={0} />))
    expect(host.querySelector('[data-status-glyph="error"]')).not.toBeNull()
  })

  it('shows a tabular age and lifts the provider mark to its brand colour only on hover or selection', () => {
    const el = mount(['idle'], { since: 0, now: 26 * 60_000 })
    const row = rows(el)[0]
    const mark = row.firstElementChild as HTMLElement
    expect(mark.getAttribute('style')).toContain('--mark')
    expect(mark.className).toContain('text-[var(--text-muted)]')
    expect(mark.className).toContain('group-hover/row:text-[var(--mark)]')
    expect(row.querySelector('time')?.textContent).toBe('26m')
    expect(row.querySelector('time')?.className).toContain('tabular-nums')
  })

  it('shows now for a working session and elapsed time for everything else', () => {
    const el = mount(['working', 'needs-input'], { since: 0, now: 5 * 60_000 })
    expect(rows(el)[0].querySelector('time')?.textContent).toBe('now')
    expect(rows(el)[1].querySelector('time')?.textContent).toBe('5m')
  })
})
