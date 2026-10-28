import { attentionStatus } from '../../../sessionAttention'
import type { SessionInfo } from '../../../houston/client'
import type { RailAgentRow } from '../../rail/railCardModel'
import { AGENT_DOT_COLOR, IconAgent } from '../../icons'
import { StatusGlyph } from '../StatusGlyph'
import { useSessionExitCode } from '../../../sessionExitCodes'
import { formatRailDuration, glyphStateLabel, sessionGlyphState } from '../railRows'

function ageLabel(session: SessionInfo, now: number): string {
  if (attentionStatus(session) === 'working') return 'now'
  const age = formatRailDuration(session.status_since_ms ?? null, now)
  return age === null || age === '0m' ? 'now' : age
}

function SessionRow({ agent, selected, now, onFocusPane }: { agent: RailAgentRow; selected: boolean; now: number; onFocusPane?: (paneId: number) => void }): React.JSX.Element {
  const session = agent.session
  const exitCode = useSessionExitCode(session.id)
  const glyph = sessionGlyphState(session, exitCode)
  const shellLabel = session.agent === 'shell' ? ` · ${agent.agent}` : ''
  return (
    <button
      type="button"
      data-testid="agent-row"
      data-selected={selected ? 'true' : undefined}
      aria-label={`Focus ${agent.leading}`}
      onClick={(event) => { event.stopPropagation(); onFocusPane?.(session.id) }}
      className={`group/row flex h-[var(--h-row)] w-full min-w-0 items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] pl-[var(--space-6)] pr-[var(--space-2)] text-left ${selected ? 'bg-[var(--sel)]' : 'hover:bg-[var(--hover)]'}`}
    >
      <span
        aria-hidden
        style={{ ['--mark' as string]: AGENT_DOT_COLOR[agent.agent] }}
        className={`flex w-4 flex-none justify-center ${selected ? 'text-[var(--mark)]' : 'text-[var(--text-muted)] group-hover/row:text-[var(--mark)]'}`}
      >
        <IconAgent agent={agent.agent} role="small" />
      </span>
      <span className={`min-w-0 flex-1 truncate [font-size:var(--tr-text-ui-size)] text-[var(--text-primary)] ${selected ? 'font-semibold' : 'font-normal'}`}>
        {agent.leading}{shellLabel}
      </span>
      <StatusGlyph state={glyph} label={glyphStateLabel(glyph)} />
      <time className="min-w-[var(--space-6)] flex-none text-right [font-size:var(--tr-text-label-size)] tabular-nums text-[var(--text-muted)]">
        {ageLabel(session, now)}
      </time>
    </button>
  )
}

export function GridRailAgentRows({
  agents,
  selectedSessionId,
  now,
  onFocusPane,
}: {
  agents: RailAgentRow[]
  selectedSessionId?: number
  now: number
  onFocusPane?: (paneId: number) => void
}): React.JSX.Element | null {
  if (agents.length === 0) return null
  return (
    <>
      {agents.map((agent) => (
        <SessionRow
          key={agent.session.id}
          agent={agent}
          selected={agent.session.id === selectedSessionId}
          now={now}
          onFocusPane={onFocusPane}
        />
      ))}
    </>
  )
}
