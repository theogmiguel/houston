import { Icon } from '../Icon'
import { IconGitBranch, IconGitPullRequest } from '../../icons'
import { Tooltip } from '../Tooltip'
import { PrLink } from '../PrLink'

export function GridRailCheckoutLine({
  label,
  pr,
  diff,
  onOpenInspector,
}: {
  label: { branch: string | null; text: string }
  pr: { url: string; number: number; state: string; is_draft: boolean; checks: string } | null
  diff: { added: number; deleted: number } | null
  onOpenInspector: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-4 min-w-0 items-center gap-1 font-mono [font-size:var(--tr-text-label-size)] text-[var(--text-muted)]">
      <Icon glyph={IconGitBranch} role="small" className="flex-none" />
      <Tooltip label={label.text}>
        <span className="min-w-0 truncate">{label.text}</span>
      </Tooltip>
      <span className="ml-auto flex flex-none items-center gap-1.5">
        {pr && <Tooltip label={`#${pr.number}`}><PrLink href={pr.url} onClick={onOpenInspector} aria-label={`Open pull request #${pr.number}${pr.checks ? `, checks ${pr.checks}` : ''}`} style={{ color: `var(--${pr.is_draft ? 'text-muted' : pr.state === 'merged' ? 'accent' : pr.state === 'closed' ? 'text-muted' : pr.checks === 'failing' ? 'stop' : pr.checks === 'passing' ? 'ok' : 'warn'})` }}>
          <Icon glyph={IconGitPullRequest} role="small" />
          {pr.checks && <span className="sr-only">{pr.checks}</span>}
        </PrLink></Tooltip>}
        {diff && <span className="inline-flex gap-1 font-mono"><span className="text-[var(--ok)]">+{diff.added}</span><span className="text-[var(--stop)]">-{diff.deleted}</span></span>}
      </span>
    </div>
  )
}
