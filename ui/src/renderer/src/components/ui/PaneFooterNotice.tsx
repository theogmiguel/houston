import { IconClose } from '../icons'
import { HIT_TARGET_28 } from '../hitTarget'
import { Button } from './Button'
import { Text } from './Text'
import { Tooltip } from './Tooltip'

export interface PaneFooterAction {
  label: string
  onClick: () => void
  disabled?: boolean
}

/** One line at the foot of a pane body: a sentence with its reason in a tooltip, two actions and an optional dismiss. */
export function PaneFooterNotice({
  sentence,
  reason,
  tone = 'default',
  primary,
  secondary,
  onDismiss,
  'data-testid': testId
}: {
  sentence: string
  reason?: string | null
  tone?: 'default' | 'danger'
  primary?: PaneFooterAction
  secondary?: PaneFooterAction
  onDismiss?: () => void
  'data-testid'?: string
}): React.JSX.Element {
  const text = (
    <Text
      size="ui"
      tone={tone === 'danger' ? 'danger' : 'secondary'}
      tabIndex={reason ? 0 : undefined}
      className="min-w-0 flex-1 truncate"
    >
      {sentence}
    </Text>
  )
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-testid={testId}
      data-pane-footer=""
      data-tone={tone}
      className="flex flex-none items-center gap-[var(--space-2)] border-t border-[var(--border)] bg-[var(--card-bg)] px-[var(--space-3)] py-[var(--space-1-5)]"
    >
      {reason ? <Tooltip label={reason}>{text}</Tooltip> : text}
      {primary && (
        <Button variant="primary" size="sm" disabled={primary.disabled} onClick={primary.onClick} className="flex-none">
          {primary.label}
        </Button>
      )}
      {secondary && (
        <Button variant="secondary" size="sm" disabled={secondary.disabled} onClick={secondary.onClick} className="flex-none">
          {secondary.label}
        </Button>
      )}
      {onDismiss && (
        <Button variant="icon" icon={IconClose} aria-label="Dismiss notice" onClick={onDismiss} className={`${HIT_TARGET_28} flex-none`} />
      )}
    </div>
  )
}

export function PaneFooterNoticeSpecimen(): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <PaneFooterNotice
        sentence="This conversation could not be resumed."
        reason="The folder ~/project no longer exists."
        primary={{ label: 'Try again', onClick: () => {} }}
        secondary={{ label: 'New conversation', onClick: () => {} }}
      />
      <PaneFooterNotice
        sentence="Started a new conversation; the previous one could not be resumed."
        reason="The saved conversation belongs to a different working directory."
        onDismiss={() => {}}
      />
      <PaneFooterNotice
        tone="danger"
        sentence="Try again was refused: the working directory is unavailable."
        primary={{ label: 'Try again', onClick: () => {} }}
        secondary={{ label: 'New conversation', onClick: () => {} }}
      />
    </div>
  )
}
