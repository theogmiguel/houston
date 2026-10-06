import type { ReactNode } from 'react'
import { Text } from './Text'

/** A key in a launcher shortcut hint; `compact` is the rail's search-field hint. */
export function HintKey({ children, size = 'default' }: { children: ReactNode; size?: 'default' | 'compact' }): React.JSX.Element {
  return <kbd className={size === 'compact' ? 'min-w-[var(--w-rail-keycap-min)] px-[var(--space-rail-keycap-x)] py-px rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--card-hover)] font-mono [font-size:var(--tr-text-rail-keycap-size)] leading-[var(--tr-text-rail-keycap-leading)] text-[var(--text-faint)]' : 'font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] bg-background border border-border rounded-[var(--tr-radius-input)] py-[var(--space-keycap-y)] px-[var(--space-keycap-x)]'}>{children}</kbd>
}

export function ShortcutHint({ shortcut, label, disabled = false }: { shortcut: string; label: string; disabled?: boolean }): React.JSX.Element {
  return <span className={`flex items-center gap-[var(--space-menu-item-x)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-text-muted ${disabled ? 'opacity-[var(--opacity-shortcuts-disabled)]' : ''}`}><HintKey>{shortcut}</HintKey>{label}</span>
}

export function ShortcutHintFooter({ children, disabledMessage, disabled = false }: { children: ReactNode; disabledMessage?: string; disabled?: boolean }): React.JSX.Element {
  return <div className="flex w-full max-w-[var(--w-shortcut-hint-footer)] flex-col items-center gap-1.5 border-t border-[color-mix(in_srgb,var(--border)_60%,transparent)] pt-[var(--space-4)]" data-testid="launcher-hint-footer"><div className={`flex flex-wrap items-center justify-center gap-x-[var(--space-4-5)] gap-y-[var(--space-1-5)] ${disabled ? 'opacity-[var(--opacity-shortcuts-disabled)]' : ''}`}>{children}</div>{disabledMessage && <Text as="p" flush size="small" weight="small" tone="muted" data-testid="launcher-hints-off">{disabledMessage}</Text>}</div>
}

export function ShortcutHintSpecimen(): React.JSX.Element {
  return <ShortcutHintFooter><ShortcutHint shortcut="Ctrl" label="Toggle sidebar" /><ShortcutHint shortcut="?" label="Keyboard shortcuts" /></ShortcutHintFooter>
}
