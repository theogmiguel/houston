import type { HTMLAttributes, ReactNode } from 'react'

const TONE = {
  ok: 'text-[var(--ok)]',
  stop: 'text-[var(--stop)]',
  warn: 'text-[var(--warn)]',
  muted: 'text-[var(--text-muted)]'
} as const

export type StatusNoteTone = keyof typeof TONE

/** A live one-line status with an optional leading icon, inked by outcome. */
export function StatusNote({ tone, children, ...props }: Omit<HTMLAttributes<HTMLSpanElement>, 'className' | 'role'> & { tone: StatusNoteTone; children: ReactNode }): React.JSX.Element {
  return <span role="status" {...props} className={`inline-flex items-center gap-[var(--space-status-note-gap)] ${TONE[tone]}`}>{children}</span>
}

export function StatusNoteSpecimen(): React.JSX.Element {
  return (
    <span className="grid gap-[var(--space-1)]">
      <StatusNote tone="ok">Delivered</StatusNote>
      <StatusNote tone="warn">Permission not granted</StatusNote>
      <StatusNote tone="stop">Delivery failed</StatusNote>
      <StatusNote tone="muted">Checking</StatusNote>
    </span>
  )
}
