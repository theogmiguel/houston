import type { ReactNode } from 'react'
import type { IconComponent } from '../icons'
import { Icon } from './Icon'
import { Text } from './Text'
import { Switch } from './Switch'

export function CenteredStatus({ title, detail, testId }: { title: string; detail: string; testId?: string }): React.JSX.Element {
  return <div data-testid={testId} role="status" aria-busy="true" className="flex flex-col items-center justify-center gap-[var(--tr-status-detail-gap)] p-[var(--tr-status-detail-padding)] text-center text-[var(--text-faint)]"><Text as="strong" size="ui" weight="semibold" tone="primary">{title}</Text><Text className="max-w-[var(--tr-width-status-detail-copy)]" size="small" weight="small" leading="normal">{detail}</Text></div>
}

export function EmptyPanel({ icon: Glyph, title, children, testId }: { icon: IconComponent; title: string; children: ReactNode; testId?: string }): React.JSX.Element {
  return <section data-testid={testId} className="grid content-center justify-items-center gap-[var(--space-empty-state-icon)] min-h-[var(--tr-empty-nav-min-height)] p-[var(--tr-empty-nav-padding)] text-center"><span aria-hidden="true" className="inline-flex h-[var(--tr-empty-nav-icon-size)] w-[var(--tr-empty-nav-icon-size)] items-center justify-center rounded-[var(--tr-empty-nav-icon-radius)] bg-[var(--hover-fill)] text-[var(--text-faint)]"><Icon glyph={Glyph} role="display" /></span><div className="grid justify-items-center gap-[var(--space-empty-state-copy)] pb-[var(--space-4)]"><Text as="h1" flush tight size="ui" weight="semibold" tone="primary">{title}</Text><Text as="p" className="max-w-[var(--tr-width-empty-nav-description)] text-pretty" size="small" weight="small" leading="normal" tone="secondary">{children}</Text></div></section>
}

export function HookPath({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="pt-[var(--space-1)] font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-faint)]">{children}</div>
}

export function HookNotice({ children, tone, testId }: { children: ReactNode; tone: 'danger' | 'warning'; testId?: string }): React.JSX.Element {
  return <div data-testid={testId} className="pt-[var(--space-1-5)]"><Text size="small" weight="small" tone={tone}>{children}</Text></div>
}

export function SettingsStatusSpecimen(): React.JSX.Element {
  const Icon = (props: { className?: string }) => <svg className={props.className} aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" /></svg>
  return <div><CenteredStatus title="Checking agent status…" detail="Asking the daemon what is installed." /><EmptyPanel icon={Icon} title="No hookable CLIs">The daemon reported no CLI it can wire.</EmptyPanel><Switch size="status" on label="Enabled" onChange={() => {}} /><HookPath>~/.claude/settings.json</HookPath><HookNotice tone="warning">Hooks need attention.</HookNotice></div>
}
