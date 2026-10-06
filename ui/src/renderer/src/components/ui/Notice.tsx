import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { IconAlertTriangle, IconInfo } from '../icons'
import { Button } from './Button'

export type NoticeTone = 'info' | 'warn' | 'danger'

export interface NoticeProps {
  tone: NoticeTone
  variant?: 'default' | 'callout'
  indicator?: 'icon' | 'dot'
  children: ReactNode
  action?: { label: string; onClick: () => void }
  className?: string
  'data-testid'?: string
}

const TONE_CLS: Record<NoticeTone, string> = {
  info: 'border-[var(--border)] bg-[color-mix(in_srgb,var(--info)_9%,transparent)] text-[color-mix(in_srgb,var(--info)_88%,var(--text-primary))]',
  warn: 'border-[var(--border)] bg-[color-mix(in_srgb,var(--warn)_9%,transparent)] text-[color-mix(in_srgb,var(--warn)_88%,var(--text-primary))]',
  danger: 'border-[color-mix(in_srgb,var(--danger)_42%,transparent)] bg-[color-mix(in_srgb,var(--danger)_9%,transparent)] text-[color-mix(in_srgb,var(--danger)_88%,var(--text-primary))]'
}

export function Notice({ tone, variant = 'default', indicator = 'icon', children, action, className = '', 'data-testid': testId }: NoticeProps): React.JSX.Element {
  const icon = tone === 'info' ? IconInfo : IconAlertTriangle
  const callout = variant === 'callout'
  return (
    <div role={tone === 'danger' ? 'alert' : 'note'} data-tone={tone} data-testid={testId} className={`${callout ? 'flex items-start gap-1.5 py-2 px-3 rounded-[var(--tr-radius-sm)] border border-[color-mix(in_srgb,var(--danger)_42%,transparent)] bg-[color-mix(in_srgb,var(--danger)_11%,transparent)] text-[length:var(--tr-text-small-size)] text-[var(--text-primary)]' : `flex min-w-0 items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] border px-[var(--space-2-5)] py-[var(--space-1-5)] text-[length:var(--tr-text-ui-size)] text-[var(--text-secondary)] ${TONE_CLS[tone]}`} ${className}`}>
      {indicator === 'dot' ? <span aria-hidden="true" className="h-[var(--space-1-5)] w-[var(--space-1-5)] flex-none rounded-full bg-[var(--info)]" /> : callout ? <span className="flex-none text-[var(--danger)] pt-0.5"><Icon glyph={icon} role="small" /></span> : <Icon glyph={icon} role="ui" />}
      <span className="min-w-0 flex-1">{children}</span>
      {action && <Button size="sm" variant="ghost" onClick={action.onClick}>{action.label}</Button>}
    </div>
  )
}
