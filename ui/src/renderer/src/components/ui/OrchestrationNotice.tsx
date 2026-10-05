import { IconAlertTriangle, IconCheck, IconClose } from '../icons'
import { ICON_ROLE_CLS } from '../Icon'
import { HIT_TARGET_28 } from '../hitTarget'
import { Button } from './Button'

export function OrchestrationNotice({
  heading,
  body,
  needsInput,
  onOpen,
  onDismiss
}: {
  heading: string
  body: string
  needsInput: boolean
  onOpen: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const StatusIcon = needsInput ? IconAlertTriangle : IconCheck
  return (
    <div
      data-testid="orchestration-notice"
      role="status"
      className="pointer-events-auto motion-safe:[animation:notice-in-corner_200ms_var(--motion-menu-ease)] flex items-center gap-[var(--space-2-5)] w-[min(400px,calc(100vw-24px))] min-w-0 p-[var(--space-2-5)] border border-[var(--border)] rounded-[var(--tr-radius-md)] bg-[var(--pop-bg)] shadow-[var(--shadow-2)]"
    >
      <span className={`flex-none ${needsInput ? 'text-[var(--warn)]' : 'text-[var(--success)]'}`}>
        <StatusIcon className={ICON_ROLE_CLS.ui} />
      </span>
      <div className="flex flex-col gap-[var(--space-0-5)] flex-1 min-w-0">
        <span className="truncate text-[length:var(--tr-text-ui-size)] font-semibold text-[var(--text-primary)]">
          {heading}
        </span>
        <span className="truncate text-[length:var(--tr-text-label-size)] text-[var(--text-muted)]">
          {body}
        </span>
      </div>
      <Button variant="secondary" size="sm" onClick={onOpen} className="flex-none">
        Open pane
      </Button>
      <Button
        variant="icon"
        icon={IconClose}
        aria-label={`Dismiss ${heading}`}
        onClick={onDismiss}
        className={`${HIT_TARGET_28} flex-none`}
      />
    </div>
  )
}

export function OrchestrationNoticeSpecimen(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      <OrchestrationNotice
        heading="api-refactor needs your input"
        body="Claude Code · Houston › feature work"
        needsInput
        onOpen={() => {}}
        onDismiss={() => {}}
      />
      <OrchestrationNotice
        heading="docs finished"
        body="Codex · Houston › main"
        needsInput={false}
        onOpen={() => {}}
        onDismiss={() => {}}
      />
    </div>
  )
}
