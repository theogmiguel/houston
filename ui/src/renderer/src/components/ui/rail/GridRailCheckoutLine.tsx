import { Icon } from '../Icon'
import { IconGitBranch } from '../../icons'
import { Tooltip } from '../Tooltip'

export function GridRailCheckoutLine({
  label,
  diff,
}: {
  label: { branch: string | null; text: string }
  pr: { url: string; number: number; state: string; is_draft: boolean; checks: string } | null
  diff: { added: number; deleted: number; ahead?: number } | null
  onOpenInspector: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-4 min-w-0 items-center gap-1 font-mono [font-size:var(--tr-text-label-size)] text-[var(--text-muted)]">
      <Icon glyph={IconGitBranch} role="small" className="flex-none" />
      <Tooltip label={label.text}>
        <span className="min-w-0 truncate">{label.text}</span>
      </Tooltip>
      <span className="ml-auto flex flex-none items-center gap-1.5">
        {Boolean(diff?.ahead) && <span aria-label={`${diff!.ahead} commits ahead`}>↑{diff!.ahead}</span>}
        {diff && <span className="inline-flex gap-1 font-mono">{diff.added !== 0 && <span className="text-[var(--ok)]">+{diff.added}</span>}{diff.deleted !== 0 && <span className="text-[var(--stop)]">-{diff.deleted}</span>}</span>}
      </span>
    </div>
  )
}
