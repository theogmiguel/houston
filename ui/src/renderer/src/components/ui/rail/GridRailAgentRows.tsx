import { attentionLabel, attentionStatus } from '../../../sessionAttention'
import type { SessionInfo } from '../../../houston/client'
import type { RailAgentRow } from '../../rail/railCardModel'
import type { AgentActivityMode, RailCardMode, RailCardProperty } from '../../../railPrefs'
import { AgentSummaryPill } from '../AgentSummaryPill'
import { IconAgent } from '../../icons'
import { WorkingSpinner } from '../Spinner'

function AgentStatusDot({ session }: { session: SessionInfo }): React.JSX.Element {
  if (attentionStatus(session) === 'working') return <WorkingSpinner testId="agent-row-dot" label={attentionLabel(session)} />
  return <span aria-label={attentionLabel(session)} data-testid="agent-row-dot" className={`inline-block size-2 flex-none rounded-full ${agentRowDotClass(attentionStatus(session))}`} />
}

function agentRowDotClass(status: SessionInfo['status']): string {
  switch (status) {
    case 'needs-input':
      return 'bg-[var(--warn)]'
    case 'spawning':
      return 'bg-[var(--accent)]'
    case 'idle':
      return 'bg-[var(--text-faint)] opacity-60'
    default:
      return 'border-[1.5px] border-[var(--text-secondary)] bg-transparent'
  }
}

function ageLabel(session: SessionInfo, now: number): string {
  if (attentionStatus(session) === 'needs-input') return 'Waiting'
  if (attentionStatus(session) === 'working') return 'now'
  const elapsed = Math.max(0, now - (session.status_since_ms ?? now))
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h`
}

const CONTEXT_WARN_PERCENT = 80

function needsUser(session: SessionInfo): boolean {
  return attentionStatus(session) === 'needs-input' || (session.context?.used_percent ?? 0) >= CONTEXT_WARN_PERCENT
}

function AgentRow({ agent, now, onFocusPane, lastMessage }: { agent: RailAgentRow; now: number; lastMessage: boolean; onFocusPane?: (paneId: number) => void }): React.JSX.Element {
  const context = agent.session.context?.used_percent
  const warnContext = context != null && context >= CONTEXT_WARN_PERCENT
  const shellLabel = agent.session.agent === 'shell' ? ` · ${agent.agent}` : ''
  return (
    <button type="button" aria-label={`Focus ${agent.leading}`} onClick={(event) => { event.stopPropagation(); onFocusPane?.(agent.session.id) }} className="flex min-h-[var(--h-agent-row)] w-full min-w-0 items-center gap-[5px] rounded px-1 text-left text-[length:var(--tr-text-xs)] leading-none hover:bg-hover-fill">
      <AgentStatusDot session={agent.session} />
      <span className="flex flex-none text-[var(--text-muted)]"><IconAgent agent={agent.agent} role="small" brand /></span>
      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
        {agent.leading}{shellLabel}
        {lastMessage && agent.trailing && <span className="block truncate text-[var(--text-muted)]">{agent.trailing}</span>}
      </span>
      {warnContext && <span className="font-mono text-[var(--warn)]">{Math.round(context!)}%</span>}
      {!warnContext && attentionStatus(agent.session) !== 'needs-input' && agent.model && <span className="max-w-[76px] truncate font-mono text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">{agent.model}</span>}
      <time className={`min-w-[22px] flex-none text-right text-[length:var(--tr-text-xs)] tabular-nums ${attentionStatus(agent.session) === 'needs-input' ? 'text-[var(--warn)]' : 'text-[var(--text-muted)]'}`}>{ageLabel(agent.session, now)}</time>
    </button>
  )
}

export function GridRailAgentRows({
  agents,
  cardMode,
  agentActivity,
  properties,
  expanded,
  onToggleExpanded,
  now,
  onFocusPane,
}: {
  agents: RailAgentRow[]
  cardMode: RailCardMode
  agentActivity: AgentActivityMode
  properties: readonly RailCardProperty[]
  expanded: boolean
  onToggleExpanded: () => void
  now: number
  onFocusPane?: (paneId: number) => void
}): React.JSX.Element | null {
  if (cardMode !== 'detailed' || !properties.includes('inline-agents')) return null
  const many = agents.length > 2
  const showFullList = agentActivity === 'full' || expanded
  // A collapsed pill still lists the agents that need the user, so a waiting one is never hidden.
  const visible = many && !showFullList ? agents.filter(({ session }) => needsUser(session)) : agents
  return (
    <>
      {many && <div onClick={(event) => event.stopPropagation()}><AgentSummaryPill agents={agents} expanded={showFullList} onToggle={onToggleExpanded} /></div>}
      {visible.map((agent) => <AgentRow key={agent.session.id} agent={agent} now={now} onFocusPane={onFocusPane} lastMessage={properties.includes('last-message')} />)}
    </>
  )
}
