import type { HTMLAttributes, ReactNode } from 'react'
import { Button } from './Button'
export { DiffLoadingMark } from './DiffLoadingMark'

type DiffKind = 'ctx' | 'add' | 'del' | 'hunk' | 'meta'

export type DiffLineKind = DiffKind

const DIFF_TONE: Record<DiffKind, string> = {
  ctx: 'text-text-secondary',
  add: 'text-[color-mix(in_srgb,var(--success)_92%,var(--text-primary))] bg-[color-mix(in_srgb,var(--success)_12%,transparent)]',
  del: 'text-[color-mix(in_srgb,var(--danger)_92%,var(--text-primary))] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]',
  hunk: 'text-[color-mix(in_srgb,var(--info)_90%,var(--text-primary))] bg-[color-mix(in_srgb,var(--info)_8%,transparent)] font-semibold',
  meta: 'text-text-muted'
}

export function DiffEmptyState({ children, surface = 'content', className = '', ...props }: HTMLAttributes<HTMLDivElement> & { surface?: 'content' | 'shell' }): React.JSX.Element {
  const surfaceClass = surface === 'shell' ? 'bg-[var(--material-shell-bg)]' : ''
  return <div {...props} className={`h-full min-h-[var(--h-diff-empty-min)] flex flex-col items-center justify-center gap-2 p-5 text-text-muted text-[length:var(--tr-text-sm)] text-center ${surfaceClass} ${className}`}>{children}</div>
}

export function DiffScrollArea({ children, surface = 'content', className = '' }: { children: ReactNode; surface?: 'content' | 'tool-code'; className?: string }): React.JSX.Element {
  const surfaceClass = surface === 'tool-code' ? 'bg-[var(--tool-code-bg)]' : ''
  return <div className={`min-h-0 overflow-y-auto [scrollbar-width:thin] ${surfaceClass} ${className}`}>{children}</div>
}

export function DiffHeader({ path, tag, added, deleted, blocked, onOpenInEditor }: { path: string; tag: string; added: number | null; deleted: number | null; blocked: boolean; onOpenInEditor?: () => void }): React.JSX.Element {
  const tagTone: Record<string, string> = {
    staged: 'bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-[var(--success)]',
    unstaged: 'bg-[color-mix(in_srgb,var(--text-muted)_18%,transparent)] text-[var(--text-muted)]',
    untracked: 'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)]',
    conflict: 'bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-[var(--warning)]',
    blocked: 'bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] text-[var(--danger)]'
  }
  return <div className="flex-none flex items-center gap-2 px-2.5 py-1 border-b border-b-[var(--divider)] bg-[var(--card-bg)] font-mono text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">
    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{path}</span>
    <span className={`flex-none ml-auto px-1.5 rounded-[var(--tr-radius-pill)] font-mono text-[length:var(--tr-text-xs)] font-semibold leading-4 ml-0 ${tagTone[tag] ?? ''}`}>{tag}</span>
    {onOpenInEditor && <Button variant="link" size="sm" data-testid="changes-open-editor" onClick={onOpenInEditor}>Open in editor</Button>}
    {!blocked && (added !== null || deleted !== null) && <span className="ml-auto font-medium" data-testid="changes-diff-counts"><span className="text-[var(--success)]">{added !== null ? `+${added}` : ''}</span>{' '}<span className="text-[var(--danger)]">{deleted !== null ? `−${deleted}` : ''}</span></span>}
  </div>
}

export function DiffBlockedMark({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="text-[var(--danger)]">{children}</span>
}

export function DiffCode({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="block min-w-full w-max pt-1 px-0 pb-2 font-mono text-[length:var(--tr-text-xs)] leading-[1.55]" role="presentation">{children}</div>
}

export function DiffPlainText({ children }: { children: ReactNode }): React.JSX.Element {
  return <pre className="m-0 pt-2 pr-3 pb-3 pl-[18px] text-text-secondary font-mono text-[length:var(--tr-text-xs)] leading-[1.55] whitespace-pre">{children}</pre>
}

export function DiffLine({ kind, children, ...props }: HTMLAttributes<HTMLDivElement> & { kind: DiffKind }): React.JSX.Element {
  return <div {...props} data-kind={kind} className={`flex items-start pr-3 whitespace-pre ${DIFF_TONE[kind]}`}>{children}</div>
}

export function DiffGutter({ children }: { children?: ReactNode }): React.JSX.Element {
  return <span className="shrink-0 w-[18px] pl-1.5 text-center text-[color-mix(in_srgb,currentColor_55%,transparent)] select-none" aria-hidden>{children}</span>
}

export function DiffLineText({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="flex-1 min-w-0">{children}</span>
}

export function DiffPaneSurface({ children, selected = false }: { children: ReactNode; selected?: boolean }): React.JSX.Element {
  return <div className={`flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-[var(--content-bg)] ${selected ? 'changes-diff' : ''}`}>{children}</div>
}
