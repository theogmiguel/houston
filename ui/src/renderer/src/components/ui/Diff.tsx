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

export function DiffHeader({ controls, status, path, tag, added, deleted, blocked, onOpenInEditor }: { controls?: ReactNode; status?: string; path: string; tag: string; added: number | null; deleted: number | null; blocked: boolean; onOpenInEditor?: () => void }): React.JSX.Element {
  if (controls) {
    const split = path.lastIndexOf('/') + 1
    const letter = status === 'added' || status === 'untracked' ? 'A' : status === 'deleted' ? 'D' : status === 'renamed' ? 'R' : status === 'conflicted' ? 'C' : 'M'
    return <div className="flex h-[var(--h-top)] flex-none items-center gap-[var(--space-2)] border-b border-[var(--divider)] px-[var(--space-4)] text-[length:var(--tr-text-ui-size)]">
      <span aria-label={status} className="text-[var(--info)] font-mono">{letter}</span>
      <span className="min-w-0 truncate"><span className="text-[var(--text-muted)]">{path.slice(0, split)}</span><span className="text-[var(--text-primary)] font-medium">{path.slice(split)}</span></span>
      <span className="flex-none font-mono text-[length:var(--tr-text-small-size)]"><span className="text-[var(--ok)]">+{added ?? 0}</span> <span className="text-[var(--stop)]">−{deleted ?? 0}</span></span>
      <span className="ml-auto flex items-center gap-[var(--space-1)]">{controls}<Button variant="ghost" size="sm" disabled={!onOpenInEditor || blocked} data-testid="changes-open-editor" onClick={onOpenInEditor}>Open in editor</Button></span>
    </div>
  }
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
  return <div className="block w-full min-w-0 pt-1 px-0 pb-2 font-mono text-[length:var(--tr-text-xs)] leading-[1.55]" role="presentation">{children}</div>
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

/** Find matches on one rendered line: half-open [start, end) ranges and the index of the current one. */
export interface DiffTextMarks {
  ranges: readonly (readonly [number, number])[]
  active: number | null
}

export function DiffFindMark({ active, children }: { active: boolean; children: ReactNode }): React.JSX.Element {
  return <mark data-diff-find-mark data-diff-find-active={active || undefined} className={`rounded-[var(--tr-radius-sm)] text-inherit ${active ? 'bg-[color-mix(in_srgb,var(--warning)_62%,transparent)] outline outline-1 outline-[var(--warning)]' : 'bg-[color-mix(in_srgb,var(--warning)_28%,transparent)]'}`}>{children}</mark>
}

export function DiffFindText({ text, marks }: { text: string; marks?: DiffTextMarks }): React.JSX.Element {
  if (!marks || marks.ranges.length === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let at = 0
  marks.ranges.forEach(([start, end], index) => {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(<DiffFindMark key={index} active={marks.active === index}>{text.slice(start, end)}</DiffFindMark>)
    at = end
  })
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

export function DiffLineText({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="flex-1 min-w-0 overflow-hidden text-ellipsis">{children}</span>
}

export function DiffPaneSurface({ children, selected = false }: { children: ReactNode; selected?: boolean }): React.JSX.Element {
  return <div className={`flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-[var(--rail-bg)] ${selected ? 'changes-diff' : ''}`}>{children}</div>
}

export function DiffSplitCode({ children }: { children: ReactNode }): React.JSX.Element {
  return <div data-diff-layout="split" className="w-full min-w-0 font-mono text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)]">{children}</div>
}

export function DiffSplitRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div data-diff-pair className="grid grid-cols-2 divide-x divide-[var(--border)]">{children}</div>
}

export function DiffSplitCell({ side, kind, filler, number, children }: { side: 'old' | 'new'; kind: DiffLineKind; filler: boolean; number: number | null; children: ReactNode }): React.JSX.Element {
  return <div data-side={side} data-kind={kind} data-filler={filler ? 'true' : undefined} data-line={number ?? undefined}
    className={`flex min-w-0 overflow-hidden whitespace-pre ${filler ? 'bg-[color-mix(in_srgb,var(--text-primary)_2%,transparent)]' : DIFF_TONE[kind]}`}>
    <span className="w-[40px] shrink-0 pr-[var(--space-1-5)] text-right text-[var(--text-faint)] select-none" aria-hidden>{number ?? ''}</span>
    {children}
  </div>
}

export function DiffSectionHeader({ kind, children }: { kind: DiffLineKind; children: ReactNode }): React.JSX.Element {
  return <div data-kind={kind} data-diff-section-header className="flex items-start font-normal whitespace-pre text-[var(--text-muted)]"><span aria-hidden className="w-[40px] shrink-0" /><DiffGutter /><DiffLineText>{children}</DiffLineText></div>
}
