import type { ReactNode } from 'react'
import { Icon } from '../Icon'
import { IconAlertTriangle, IconInfo } from '../icons'
import { Button } from './Button'

export type NoticeTone = 'info' | 'warn' | 'danger'

export interface NoticeProps {
  tone: NoticeTone
  children: ReactNode
  action?: { label: string; onClick: () => void }
  className?: string
}

const TONE_CLS: Record<NoticeTone, string> = {
  info: 'border-[var(--border)] bg-[color-mix(in_srgb,var(--info)_9%,transparent)] text-[color-mix(in_srgb,var(--info)_88%,var(--text-primary))]',
  warn: 'border-[var(--border)] bg-[color-mix(in_srgb,var(--warn)_9%,transparent)] text-[color-mix(in_srgb,var(--warn)_88%,var(--text-primary))]',
  danger: 'border-[color-mix(in_srgb,var(--danger)_42%,transparent)] bg-[color-mix(in_srgb,var(--danger)_9%,transparent)] text-[color-mix(in_srgb,var(--danger)_88%,var(--text-primary))]'
}

export function Notice({ tone, children, action, className = '' }: NoticeProps): React.JSX.Element {
  const icon = tone === 'info' ? IconInfo : IconAlertTriangle
  return (
    <div role={tone === 'danger' ? 'alert' : 'note'} data-tone={tone} className={`flex min-w-0 items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] border px-[var(--space-2-5)] py-[var(--space-1-5)] text-[length:var(--tr-text-ui-size)] text-[var(--text-secondary)] ${TONE_CLS[tone]} ${className}`}>
      <Icon glyph={icon} role="ui" />
      <span className="min-w-0 flex-1">{children}</span>
      {action && <Button size="sm" variant="ghost" onClick={action.onClick}>{action.label}</Button>}
    </div>
  )
}
