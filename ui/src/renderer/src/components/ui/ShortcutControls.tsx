import type { HTMLAttributes, ReactNode } from 'react'

export function ShortcutBindingRow({ children, inert = false, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; inert?: boolean }): React.JSX.Element {
  return <div {...props} data-inert={inert || undefined} className={`flex items-start gap-[var(--tr-space-shortcut-row-gap)] py-[var(--tr-space-shortcut-row-block)] px-[var(--tr-space-shortcut-row-inline)] [&+&]:border-t [&+&]:border-t-[var(--divider)] ${inert ? '[&_.key-chip]:opacity-45' : ''}`}>{children}</div>
}

export function ShortcutConflictActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-[var(--space-2)]">{children}</div>
}

export function ShortcutToolbar({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center justify-between gap-[var(--space-3)] py-[var(--space-3)]">{children}</div>
}

export function ShortcutResetSlot({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="pt-[var(--space-2)] pb-[var(--space-5)]">{children}</div>
}

export function ShortcutControlsSpecimen(): React.JSX.Element {
  return <div><ShortcutBindingRow><span>Ctrl + Enter</span><span>Open a pane</span></ShortcutBindingRow><ShortcutToolbar><span>Search shortcuts</span><ShortcutResetSlot><span>Reset all</span></ShortcutResetSlot></ShortcutToolbar><ShortcutConflictActions><span>Conflicts with an existing key.</span><button type="button">Cancel</button></ShortcutConflictActions></div>
}
