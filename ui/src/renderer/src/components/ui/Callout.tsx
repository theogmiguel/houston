import type { ReactNode } from 'react'
import { IconAlertTriangle } from '../icons'
import { Icon } from './Icon'
import { Text } from './Text'

const CALLOUT_CLS =
  'grid grid-cols-[var(--space-form-control-icon)_minmax(0,1fr)] gap-[var(--space-2-5)] rounded-[var(--tr-radius-sm)] border p-[var(--space-3)]'
const TONE = {
  warn: {
    box: `${CALLOUT_CLS} border-[var(--callout-warning-border)] bg-[var(--callout-warning-surface)]`,
    icon: 'text-[var(--warn)]'
  },
  stop: {
    box: `${CALLOUT_CLS} border-[var(--callout-stop-border)] bg-[var(--callout-stop-surface)]`,
    icon: 'text-[var(--stop)]'
  }
} as const

export type CalloutTone = keyof typeof TONE

/** A bordered message with a leading warning glyph; `stop` is announced as an alert. */
export function Callout({ tone, children }: { tone: CalloutTone; children: ReactNode }): React.JSX.Element {
  return (
    <div role={tone === 'stop' ? 'alert' : 'status'} className={TONE[tone].box}>
      <span className={TONE[tone].icon}>
        <Icon glyph={IconAlertTriangle} role="ui" />
      </span>
      <Text as="div" size="small" leading="small" tone="secondary">{children}</Text>
    </div>
  )
}

const DANGER_PANEL = {
  alert: 'p-3 rounded-[var(--tr-radius-button)] bg-[var(--danger-panel-surface)] border border-[var(--danger-panel-border)] space-y-2',
  detail: 'p-3 rounded-[var(--tr-radius-button)] bg-[var(--danger-panel-surface)] border border-[var(--danger-panel-border)] space-y-1'
} as const

/** A tinted panel for a security warning: `alert` carries the message, `detail` holds supporting evidence. */
export function DangerPanel({ variant, children, ...rest }: { variant: keyof typeof DANGER_PANEL; children: ReactNode; role?: string; 'data-testid'?: string }): React.JSX.Element {
  return <div {...rest} className={DANGER_PANEL[variant]}>{variant === 'alert' ? <Text as="div" size="body" tone="danger" className="font-[var(--tr-text-body-weight)] leading-relaxed">{children}</Text> : children}</div>
}

/** A one-line alert that sits between a dialog title and its body. */
export function DialogAlert({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="px-4 pb-2">
      <Text as="div" size="small" weight="small" tone="secondary" className="px-2.5 py-1.5 rounded-[var(--tr-radius-sm)] bg-[var(--danger-alert-surface)]">
        {children}
      </Text>
    </div>
  )
}

export function CalloutSpecimen(): React.JSX.Element {
  return (
    <div data-testid="callout-specimen" className="grid gap-[var(--space-3)]">
      <Callout tone="warn"><Text as="b" weight="semibold" tone="primary">Warning.</Text> A message that needs attention.</Callout>
      <Callout tone="stop"><Text as="b" weight="semibold" tone="primary">Stopped.</Text> The last attempt did not finish.</Callout>
      <DangerPanel variant="alert" role="alert">The host key has changed since you last connected.</DangerPanel>
      <DangerPanel variant="detail">Supporting evidence for the warning.</DangerPanel>
      <DialogAlert>Global shortcuts are off.</DialogAlert>
    </div>
  )
}
