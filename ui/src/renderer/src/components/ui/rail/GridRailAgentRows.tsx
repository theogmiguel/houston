import { attentionLabel, attentionStatus } from '../../../sessionAttention'
import type { SessionInfo } from '../../../houston/client'
import type { RailAgentRow } from '../../rail/railCardModel'
import type { AgentActivityMode, RailCardMode, RailCardProperty } from '../../../railPrefs'
import { Icon } from '../Icon'
import { IconChevronRight } from '../../icons'
import { IconAgent } from '../../icons'
import { Tooltip } from '../Tooltip'

function AgentStatusDot({ session, now }: { session: SessionInfo; now: number }): React.JSX.Element {
  const quiet = attentionStatus(session) === 'working' && session.status_since_ms != null && now - session.status_since_ms >= 10 * 60_000
  return quiet ? (
    <Tooltip label={`No recent update from ${session.agent}`}>
      <span aria-label={`No recent update from ${session.agent}`} className="inline-block size-2 flex-none rounded-full border border-[var(--info)] bg-transparent" />
    </Tooltip>
  ) : (
    <span aria-label={attentionLabel(session)} data-testid="agent-row-dot" className={`inline-block ${attentionStatus(session) === 'working' ? 'size-[9px]' : 'size-2'} flex-none rounded-full ${agentRowDotClass(attentionStatus(session))}`} />
  )
}

function agentRowDotClass(status: SessionInfo['status']): string {
  switch (status) {
    case 'needs-input':
      return 'bg-[var(--warn)]'
    case 'working':
      return 'animate-[spin_1s_linear_infinite] motion-reduce:animate-none border-[1.5px] border-[var(--accent)] border-r-transparent bg-transparent'
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

function AgentRow({ agent, now }: { agent: RailAgentRow; now: number }): React.JSX.Element {
  const context = agent.session.context?.used_percent
  const warnContext = context != null && context >= 80
  const shellLabel = agent.session.agent === 'shell' ? ` · ${agent.agent}` : ''
  return (
    <div key={agent.session.id} className="flex h-[var(--h-agent-row)] min-w-0 items-center gap-[5px] rounded px-1 text-[length:var(--tr-text-xs)] leading-none hover:bg-hover-fill">
      <AgentStatusDot session={agent.session} now={now} />
      <span className="flex flex-none text-[var(--text-muted)]"><IconAgent agent={agent.agent} role="small" brand /></span>
      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
        {agent.leading}{shellLabel}
      </span>
      {warnContext && <span className="font-mono text-[var(--warn)]">{Math.round(context!)}%</span>}
      {!warnContext && attentionStatus(agent.session) !== 'needs-input' && agent.model && <span className="max-w-[76px] truncate font-mono text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">{agent.model}</span>}
      <time className="min-w-[22px] flex-none text-right text-[length:var(--tr-text-xs)] tabular-nums text-[var(--text-muted)]">{ageLabel(agent.session, now)}</time>
    </div>
  )
}

export function GridRailAgentRows({
  agents,
  cardMode,
  agentActivity,
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
  const many = agents.length > 3
  const showFullList = agentActivity === 'full' || expanded
  const visible = many && !showFullList ? agents.slice(0, 2) : agents
  const hiddenWorking = agents.slice(2).filter(({ session }) => attentionStatus(session) === 'working').length
  return (
    <>
      {visible.map((agent) => <AgentRow key={agent.session.id} agent={agent} now={now} />)}
      {many && <button type="button" aria-expanded={showFullList} onClick={(event) => { event.stopPropagation(); onToggleExpanded() }} className="flex h-5 items-center gap-1 px-1 text-[length:var(--tr-text-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
        <Icon glyph={IconChevronRight} role="small" className={showFullList ? 'rotate-90' : ''} />
        {showFullList ? 'Show fewer agents' : `${agents.length - 2} more agents${hiddenWorking ? ` · ${hiddenWorking} working` : ''}`}
      </button>}
    </>
  )
}
