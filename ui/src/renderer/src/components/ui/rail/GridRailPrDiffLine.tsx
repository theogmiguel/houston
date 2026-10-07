import type { RailAgentRow } from '../../rail/railCardModel'
import type { RailCardProperty } from '../../../railPrefs'
import { PrLink } from '../PrLink'
import { Tooltip } from '../Tooltip'
import { Icon } from '../Icon'
import { IconGitPullRequest } from '../../icons'

export function GridRailPrDiffLine({
  pr,
  diff,
  primary,
  properties,
  onOpenInspector,
}: {
  pr: { url: string; number: number; checks: string } | null
  diff: { added: number; deleted: number } | null
  primary?: RailAgentRow
  properties: readonly RailCardProperty[]
  onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
}): React.JSX.Element | null {
  if (!hasRailFact(properties, pr, diff, primary)) return null
  return (
    <div className="flex h-4 items-center gap-2 pl-5 font-mono [font-size:var(--tr-text-label-size)] text-[var(--text-muted)]">
      <PullRequestFact pr={pr} enabled={properties.includes('pr')} primary={primary} onOpenInspector={onOpenInspector} />
      <CheckStatusFact pr={pr} enabled={properties.includes('ci')} />
      <DiffFact diff={diff} enabled={properties.includes('diff')} />
      <TaskFact primary={primary} enabled={properties.includes('task')} />
      <ContextFact primary={primary} enabled={properties.includes('context')} />
    </div>
  )
}

function hasRailFact(
  properties: readonly RailCardProperty[],
  pr: { url: string; number: number; checks: string } | null,
  diff: { added: number; deleted: number } | null,
  primary?: RailAgentRow,
): boolean {
  const configured = properties.some((property) => ['pr', 'diff', 'ci', 'task', 'context'].includes(property))
  const available = Boolean(pr || diff || primary?.session.task || primary?.session.context?.used_percent != null)
  return configured && available
}

function PullRequestFact({ pr, enabled, primary, onOpenInspector }: { pr: { url: string; number: number } | null; enabled: boolean; primary?: RailAgentRow; onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void }): React.JSX.Element | null {
  if (!enabled || !pr) return null
  return <PrLink href={pr.url} onClick={() => primary && onOpenInspector(primary.session.id, 'pull-request')} className="inline-flex items-center gap-1 text-[var(--text-muted)]"><Icon glyph={IconGitPullRequest} role="small" />#{pr.number}</PrLink>
}

function CheckStatusFact({ pr, enabled }: { pr: { checks: string } | null; enabled: boolean }): React.JSX.Element | null {
  if (!enabled || !pr) return null
  const statusClass = pr.checks === 'failing' ? 'text-[var(--stop)]' : pr.checks === 'passing' ? 'text-[var(--ok)]' : 'text-[var(--text-muted)]'
  return <span className={statusClass}>{pr.checks}</span>
}

function DiffFact({ diff, enabled }: { diff: { added: number; deleted: number } | null; enabled: boolean }): React.JSX.Element | null {
  if (!enabled || !diff) return null
  return <span className="flex items-center gap-1"><span className="text-[var(--ok)]">+{diff.added}</span><span className="text-[var(--stop)]">−{diff.deleted}</span></span>
}

function TaskFact({ primary, enabled }: { primary?: RailAgentRow; enabled: boolean }): React.JSX.Element | null {
  const task = primary?.session.task
  if (!enabled || !task) return null
  return <Tooltip label={task.title}><span className="truncate">{task.key}</span></Tooltip>
}

function ContextFact({ primary, enabled }: { primary?: RailAgentRow; enabled: boolean }): React.JSX.Element | null {
  const used = primary?.session.context?.used_percent
  if (!enabled || used == null) return null
  return <span>{Math.round(used)}% context</span>
}
