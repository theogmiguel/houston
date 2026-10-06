import { createPortal } from 'react-dom'
import type { SessionInfo } from '../../houston/client'
import type { TagInfo } from '../../houston/generated/TagInfo'
import { TagChip } from '../tags'
import { Icon } from './Icon'
import { IconAgent, IconGitBranch, IconFolder } from '../icons'
import { formatRailDuration, gridStatus } from './railRows'
import type { RailHoverCheckout, RailPaneRow } from './railRowModel'

function statusTone(kind: ReturnType<typeof gridStatus>['kind']): string {
  switch (kind) {
    case 'needs-input': return 'text-[var(--warn)]'
    case 'working': return 'text-[var(--info)]'
    case 'starting': return 'text-[var(--accent)]'
    case 'exited': return 'text-[var(--stop)]'
    case 'done': return 'text-[var(--ok)]'
    default: return 'text-[var(--text-faint)]'
  }
}

function agentTone(session: SessionInfo): string {
  if (session.state !== 'running') return 'text-[var(--text-faint)] opacity-50'
  switch (session.agent) {
    case 'claude': return 'text-[var(--claude)]'
    case 'antigravity': return 'text-[var(--antigravity)]'
    case 'codex': return 'text-[var(--codex)]'
    case 'opencode': return 'text-[var(--opencode)]'
    case 'cursor': return 'text-[var(--cursor)]'
    case 'grok': return 'text-[var(--grok)]'
    default: return 'text-[var(--text-primary)]'
  }
}

function checkoutStats(stats: RailHoverCheckout['diff']): string {
  if (!stats) return 'checkout data unavailable'
  const parts = [stats.ahead ? `↑${stats.ahead}` : '', stats.behind ? `↓${stats.behind}` : '', stats.changedFiles ? `${stats.changedFiles} file${stats.changedFiles === 1 ? '' : 's'}` : '']
  return parts.filter(Boolean).join(' ') || 'clean'
}

export function GridRailHoverCard({
  name, position, closeTimer, scheduleClose, paneRows, tags, checkouts, onOpenInspector,
}: {
  name: string
  position: { left: number; top: number }
  closeTimer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
  scheduleClose: () => void
  paneRows: RailPaneRow[]
  tags: readonly TagInfo[]
  checkouts: RailHoverCheckout[]
  onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
}): React.JSX.Element {
  const prs = checkouts.filter((checkout) => checkout.pr?.pr)
  return createPortal(<div className="grid-hover-card fixed z-[var(--z-tooltip)] grid w-[360px] gap-[var(--space-2)] rounded-[var(--tr-radius-md)] border border-[var(--border-hover)] bg-[var(--raised)] p-[var(--space-3)] text-[length:var(--tr-text-small-size)] shadow-[var(--shadow-2)]" style={position} role="tooltip" data-testid="grid-hover-card" onMouseEnter={() => { if (closeTimer.current) clearTimeout(closeTimer.current) }} onMouseLeave={scheduleClose}>
    <strong className="truncate text-[var(--text-primary)]">{name}</strong>
    {tags.length > 0 && <div data-testid="grid-hover-tags" className="flex flex-wrap items-center gap-[var(--space-1)] [--tag-chip-max:140px]">{tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}</div>}
    <div className="grid grid-cols-[14px_minmax(0,1fr)_auto_auto_auto] items-center gap-x-[var(--space-2)] gap-y-[var(--space-1)]">
      {paneRows.map(({ session, depth }) => <PaneHoverRow key={session.id} session={session} depth={depth} />)}
    </div>
    {checkouts.length > 0 && <>
      <hr className="m-0 w-full border-0 border-t border-[var(--divider)]" />
      <div className="grid gap-[var(--space-1)]" data-testid="grid-hover-checkouts">
        {checkouts.map((checkout) => <div key={checkout.path} className="grid min-w-0 grid-cols-[12px_minmax(0,1fr)_auto_auto] items-center gap-x-[var(--space-2)] font-mono [font-size:var(--tr-text-label-size)]">
          {checkout.session.worktree ? <Icon glyph={IconFolder} role="small" className="text-[var(--ok)]" /> : <Icon glyph={IconGitBranch} role="small" className="text-[var(--text-muted)]" />}
          <span className="truncate text-[var(--text-secondary)]">{checkout.branch ?? 'Branch unavailable'}</span>
          <span className="col-start-3 col-end-5 truncate text-[var(--text-muted)]">{checkoutStats(checkout.diff)}</span>
          <span className="col-start-2 col-end-5 truncate text-[var(--text-faint)]">{checkout.session.worktree?.path ?? 'main checkout'}</span>
        </div>)}
      </div>
    </>}
    {prs.map((checkout) => {
      const pr = checkout.pr!.pr!
      return <div key={checkout.path} className="grid gap-[var(--space-1)]">
        <hr className="m-0 w-full border-0 border-t border-[var(--divider)]" />
        <button type="button" className="flex min-w-0 items-center gap-[var(--space-2)] text-left" onClick={() => onOpenInspector(checkout.session.id, 'pull-request')}>
          <span className={pr.state === 'MERGED' ? 'text-[var(--merged)]' : pr.state === 'CLOSED' ? 'text-[var(--stop)]' : 'text-[var(--ok)]'}>#{pr.number}</span><span className="truncate text-[var(--text-primary)]">{pr.state.toLowerCase()}</span><span className="truncate text-[var(--text-muted)]">{pr.checks.toLowerCase()}</span>
        </button>
      </div>
    })}
    <span className="text-[var(--text-faint)] [font-size:var(--tr-text-label-size)]">Right-click for branch, PR and worktree actions</span>
  </div>, document.body)
}

function PaneHoverRow({ session, depth }: { session: SessionInfo; depth: number }): React.JSX.Element {
  const model = gridStatus([session])
  const age = formatRailDuration(model.since)
  const context = session.context?.used_percent
  return <>
    <IconAgent agent={session.agent} className={`h-[14px] w-[14px] ${agentTone(session)}`} />
    <span className="min-w-0 truncate text-[var(--text-primary)]">{depth > 0 && <span className="font-mono text-[var(--text-faint)]">└ </span>}{session.title || session.codename || session.agent}</span>
    <span className={`${statusTone(model.kind)} whitespace-nowrap`}>{model.label}{age ? ` ${age}` : ''}</span>
    <span className={context != null && context >= 85 ? 'text-[var(--warn)]' : 'text-[var(--text-muted)]'}>{context != null ? `ctx ${context}%` : ''}</span>
    <span className="truncate text-[var(--info)]">{session.task?.key ?? ''}</span>
  </>
}
