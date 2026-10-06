import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
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
  return (
    <div data-testid="key-cap-specimen" className="grid gap-[var(--space-2)]">
      <KeyCap>Ctrl + K</KeyCap>
      <KeyBindingRow keyName="Ctrl + Shift + P" description="Open command palette" />
      <KeyBindingRow keyName="Ctrl + Shift + P" description="Shortcuts are off" disabled />
      <div className="flex items-center gap-[var(--space-2)]"><KeyChip size="shortcut">Ctrl + Enter</KeyChip><KeyChip as="button" size="shortcut" state="armed">Press a key…</KeyChip></div>
    </div>
  )
}

type KeyChipProps = (ButtonHTMLAttributes<HTMLButtonElement> & { as: 'button'; state?: 'armed' | 'idle'; size?: 'default' | 'shortcut' }) | (HTMLAttributes<HTMLSpanElement> & { as?: 'span'; state?: 'fixed'; size?: 'default' | 'shortcut' })

/** A shortcut binding chip: a fixed key, or a button that captures a new one. */
export function KeyChip({ as: Tag = 'span', state, size = 'default', className = '', ...props }: KeyChipProps): React.JSX.Element {
  const button = Tag === 'button'
  const keyState = state ?? (button ? 'idle' : 'fixed')
  const stateClasses = keyState === 'fixed'
    ? 'key-chip--fixed rounded-[var(--tr-radius-shortcut-fixed)] border-[var(--border)] text-[var(--text-muted)] opacity-60'
    : keyState === 'armed'
      ? 'key-chip--capture armed rounded-[var(--tr-radius-input)] border-[var(--accent,var(--text-primary))] text-[var(--text-primary)]'
      : 'key-chip--capture rounded-[var(--tr-radius-input)] border-transparent text-[var(--text-muted)] hover:border-[var(--border)]'
  const shortcutSize = size === 'shortcut' ? 'min-w-[var(--tr-width-shortcut-keycap)] px-[var(--tr-space-shortcut-keycap-inline)] py-[var(--tr-space-shortcut-keycap-block)]' : ''
  const classes = `${button ? 'btn' : ''} key-chip ${stateClasses} flex-none justify-center border bg-[var(--content-bg)] text-center font-mono font-semibold [font-size:var(--tr-text-small-size)] ${shortcutSize} ${className}`
  return button
    ? <button {...props as ButtonHTMLAttributes<HTMLButtonElement>} className={classes} />
    : <span {...props as HTMLAttributes<HTMLSpanElement>} className={classes} />
}
