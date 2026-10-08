import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
import { Icon } from './Icon'
import { IconClose } from '../icons'
import { Tooltip } from './Tooltip'

export function LaunchComposerHeader({ workspaceName, workspacePath, gridName, target, onClose }: {
  workspaceName: string
  workspacePath: string
  gridName: string
  target: 'this-grid' | 'new-grid'
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 items-center gap-[var(--space-2)] border-b border-[var(--border)] px-[14px]">
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0">
        <span className="[font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[var(--tr-text-ui-leading)] text-[var(--text-primary)]">New sessions</span>
        <Tooltip label={workspacePath}>
          <span className="block min-w-0 truncate [font-size:var(--tr-text-label-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-muted)]">
            {target === 'this-grid' ? `${workspaceName} · adds to “${gridName}”` : `${workspaceName} · opens a new grid`}
          </span>
        </Tooltip>
      </div>
      <Tooltip label="Close"><button
        type="button"
        aria-label="Close"
        data-testid="new-session-close"
        onClick={onClose}
        className={`inline-flex ${CONTROL_SIZE_SQUARE_CLS.small} flex-none items-center justify-center rounded-[var(--tr-radius-sm)] border-none bg-transparent text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]`}
      >
        <Icon glyph={IconClose} role="small" />
      </button></Tooltip>
    </div>
  )
}

export function LaunchComposerHeaderSpecimen(): React.JSX.Element {
  return <div className="w-[560px] border border-[var(--border)]"><LaunchComposerHeader workspaceName="Houston" workspacePath="/work/houston" gridName="Improve Orchestration" target="this-grid" onClose={() => {}} /></div>
}
