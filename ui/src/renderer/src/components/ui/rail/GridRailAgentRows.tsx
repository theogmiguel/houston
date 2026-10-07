import type { SessionInfo } from '../../../houston/client'
import type { RailAgentRow } from '../../rail/railCardModel'
import type { AgentActivityMode, RailCardMode, RailCardProperty } from '../../../railPrefs'
import { AgentSummaryPill } from '../AgentSummaryPill'
import { IconAgent } from '../../icons'
import { Tooltip } from '../Tooltip'

function AgentStatusDot({ session, now }: { session: SessionInfo; now: number }): React.JSX.Element {
  const quiet = session.status === 'working' && session.status_since_ms != null && now - session.status_since_ms >= 10 * 60_000
  return quiet ? (
    <Tooltip label={`No recent update from ${session.agent}`}>
      <span aria-label={`No recent update from ${session.agent}`} className="inline-block size-2 flex-none rounded-full border border-[var(--info)] bg-transparent" />
    </Tooltip>
  ) : (
    <span aria-hidden className={`inline-block ${session.status === 'working' ? 'size-[9px]' : 'size-2'} flex-none rounded-full ${session.status === 'needs-input'
      ? 'bg-[var(--warn)]'
      : session.status === 'working' ? 'animate-spin motion-reduce:animate-none border border-[var(--info)] border-r-transparent bg-transparent'
        : session.status === 'idle' ? 'bg-[var(--text-faint)] opacity-60' : 'bg-[var(--ok)]'}`} />
  )
}

function ageLabel(session: SessionInfo, now: number): string {
  if (session.status === 'working') return 'now'
  const elapsed = Math.max(0, now - (session.status_since_ms ?? now))
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h`
}

function AgentRow({ agent, now }: { agent: RailAgentRow; now: number }): React.JSX.Element {
  const shellLabel = agent.session.agent === 'shell' ? ' · shell' : ''
  return (
    <div key={agent.session.id} className="flex h-[var(--h-agent-row)] min-w-0 items-center gap-[5px] rounded px-1 text-[length:var(--tr-text-xs)] leading-none">
      <AgentStatusDot session={agent.session} now={now} />
      <span className="flex flex-none text-[var(--text-muted)]"><IconAgent agent={agent.session.agent} role="small" brand /></span>
      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
        {agent.leading}{shellLabel}
      </span>
      {agent.model && <span className="max-w-[76px] truncate font-mono text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">{agent.model}</span>}
      <time className="min-w-[22px] flex-none text-right text-[length:var(--tr-text-xs)] tabular-nums text-[var(--text-muted)]">{ageLabel(agent.session, now)}</time>
    </div>
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
}: {
  agents: RailAgentRow[]
  cardMode: RailCardMode
  agentActivity: AgentActivityMode
  properties: readonly RailCardProperty[]
  expanded: boolean
  onToggleExpanded: () => void
  now: number
}): React.JSX.Element | null {
  if (cardMode !== 'detailed') return null
  const many = agents.length > 2
  const showFullList = agentActivity === 'full' || expanded
  return (
    <>
      {many && properties.includes('inline-agents') && (
        <div>
          <AgentSummaryPill agents={agents} expanded={expanded} onToggle={onToggleExpanded} />
        </div>
      )}
      {many ? (
        <div className={`grid overflow-hidden transition-[grid-template-rows] duration-[180ms] ease-out motion-reduce:transition-none ${showFullList ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="min-h-0 overflow-hidden">
            {showFullList && agents.map((agent) => <AgentRow key={agent.session.id} agent={agent} now={now} />)}
          </div>
        </div>
      ) : agents.map((agent) => <AgentRow key={agent.session.id} agent={agent} now={now} />)}
    </>
  )
}
