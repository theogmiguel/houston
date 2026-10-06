import type { ReactNode } from 'react'

export type ScmNoticeTone = 'info' | 'warn' | 'danger'

export function RepositoryNotice({ tone, testId, children, icon }: {
  tone: 'info' | 'warn' | 'danger'
  testId?: string
  children: ReactNode
  icon: ReactNode
}): React.JSX.Element {
  const toneClass = tone === 'info'
    ? 'bg-[color-mix(in_srgb,var(--info)_9%,transparent)] text-[color-mix(in_srgb,var(--info)_88%,var(--text-primary))]'
    : tone === 'warn'
      ? 'bg-[color-mix(in_srgb,var(--warn)_9%,transparent)] text-[color-mix(in_srgb,var(--warn)_88%,var(--text-primary))]'
      : 'bg-[color-mix(in_srgb,var(--danger)_9%,transparent)] text-[color-mix(in_srgb,var(--danger)_88%,var(--text-primary))]'
  return <div role="note" data-testid={testId} className={`flex-none flex items-start gap-[var(--space-1-5)] px-[var(--space-2-5)] py-[var(--space-1-5)] border-b border-b-[var(--divider)] text-[length:var(--tr-text-xs)] ${toneClass}`}>{icon}<span>{children}</span></div>
}
