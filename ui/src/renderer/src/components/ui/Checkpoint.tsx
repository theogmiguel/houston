import type { HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'

export function GitCheckpointRow({ children, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className="group/row flex flex-col gap-1 px-2 py-1.5 rounded-[var(--tr-radius-sm)] hover:bg-[var(--card-hover)]">{children}</div>
}

export function GitCheckpointCreateRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-2">{children}</div>
}

export function GitCheckpointIconRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-2">{children}</div>
}

export function GitCheckpointList({ children }: { children: ReactNode }): React.JSX.Element {
  return <div role="list" data-testid="checkpoints-list" className="flex flex-col gap-1">{children}</div>
}

export function GitCheckpointEmptyText({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="p" size="small" tone="muted" flush className="px-2 py-3">{children}</Text>
}

export function GitCheckpointLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" tone="primary" className="overflow-hidden text-ellipsis whitespace-nowrap">{children}</Text>
}

export function GitCheckpointLabelColumn({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex-1 min-w-0 flex flex-col">{children}</div>
}

export function GitCheckpointIconSlot({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="span" tone="faint" className="flex-none" aria-hidden>{children}</Text>
}

export function GitCheckpointDiffPanel({ children, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className="rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)] max-h-[var(--h-checkpoint-diff-max)] overflow-y-auto [scrollbar-width:thin]">{children}</div>
}

export function GitCheckpointRedactionNotice({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="px-2 py-1 text-[length:var(--tr-text-xs)] text-[var(--warning)] border-b border-[var(--divider)]">{children}</div>
}
