import type { ReactNode } from 'react'
import { Text } from './Text'

export function KeyCap({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="inline-flex min-w-[var(--w-shortcut-keycap)] justify-center rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--content-bg)] px-[var(--space-keycap-inline)] py-[var(--space-keycap-block)]">
      <Text size="small" weight="semibold" tone="muted" center>{children}</Text>
    </span>
  )
}

export function KeyBindingRow({ keyName, description, disabled = false }: { keyName: string; description: string; disabled?: boolean }): React.JSX.Element {
  return (
    <div className={`flex items-baseline gap-[var(--space-2-5)] ${disabled ? 'opacity-[var(--opacity-inactive)]' : ''}`}>
      <KeyCap>{keyName}</KeyCap>
      <Text size="caption" weight="label" tone="secondary">{description}</Text>
    </div>
  )
}

export function KeyCapSpecimen(): React.JSX.Element {
  return <div data-testid="key-cap-specimen" className="grid gap-[var(--space-2)]"><KeyCap>Ctrl + K</KeyCap><KeyBindingRow keyName="Ctrl + Shift + P" description="Open command palette" /><KeyBindingRow keyName="Ctrl + Shift + P" description="Shortcuts are off" disabled /></div>
}
