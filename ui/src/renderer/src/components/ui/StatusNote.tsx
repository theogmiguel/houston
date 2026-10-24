import type { HTMLAttributes, ReactNode } from 'react'

const TONE = {
  ok: 'text-[var(--ok)]',
  stop: 'text-[var(--stop)]',
  warn: 'text-[var(--warn)]',
  muted: 'text-[var(--text-muted)]'
} as const

export type StatusNoteTone = keyof typeof TONE

type StatusNoteProps = Omit<HTMLAttributes<HTMLSpanElement>, 'className' | 'role'> & { children: ReactNode } & (
  | { variant?: 'inline'; tone: StatusNoteTone }
  /** Visually hidden: only assistive technology reads it. Keep it mounted so a change is announced. */
  | { variant: 'announcer'; tone?: never }
)

/** A live one-line status with an optional leading icon, inked by outcome. */
export function StatusNote({ variant = 'inline', tone, children, ...props }: StatusNoteProps): React.JSX.Element {
  if (variant === 'announcer') return <span role="status" aria-atomic="true" {...props} className="sr-only">{children}</span>
  return <span role="status" {...props} className={`inline-flex items-center gap-[var(--space-status-note-gap)] ${TONE[tone as StatusNoteTone]}`}>{children}</span>
}

export function StatusNoteSpecimen(): React.JSX.Element {
  return (
    <span className="grid gap-[var(--space-1)]">
      <StatusNote tone="ok">Delivered</StatusNote>
      <StatusNote tone="warn">Permission not granted</StatusNote>
      <StatusNote tone="stop">Delivery failed</StatusNote>
      <StatusNote tone="muted">Checking</StatusNote>
      <StatusNote variant="announcer" data-testid="status-note-announcer">api finished</StatusNote>
    </span>
  )
}
