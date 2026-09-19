import { Icon } from '../Icon'
import { IconAlertTriangle, IconInfo } from '../icons'

export type ScmNoticeTone = 'info' | 'warn' | 'danger'

const NOTICE_CLS: Record<ScmNoticeTone, string> = {
  info: 'bg-[color-mix(in_srgb,var(--info)_9%,transparent)] text-[color-mix(in_srgb,var(--info)_88%,var(--text-primary))]',
  warn: 'bg-[color-mix(in_srgb,var(--warn)_9%,transparent)] text-[color-mix(in_srgb,var(--warn)_88%,var(--text-primary))]',
  danger:
    'bg-[color-mix(in_srgb,var(--danger)_9%,transparent)] text-[color-mix(in_srgb,var(--danger)_88%,var(--text-primary))]'
}

export function ScmNotice({
  tone,
  testId,
  children
}: {
  tone: ScmNoticeTone
  testId?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role="note"
      data-testid={testId}
      className={`flex-none flex items-start gap-[var(--space-1-5)] px-[var(--space-2-5)] py-[var(--space-1-5)] border-b border-b-[var(--divider)] text-[length:var(--tr-text-xs)] ${NOTICE_CLS[tone]}`}
    >
      <Icon glyph={tone === 'info' ? IconInfo : IconAlertTriangle} role="small" />
      <span>{children}</span>
    </div>
  )
}
