import type { HTMLAttributes } from 'react'

type GitStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'staged' | 'unstaged' | 'conflict' | 'blocked'

const STATUS_TONE: Record<GitStatus, string> = {
  modified: 'text-[var(--warn)]',
  added: 'text-[var(--ok)]',
  deleted: 'text-[var(--stop)]',
  renamed: 'text-[var(--info)]',
  untracked: 'text-[var(--info)]',
  conflicted: 'text-[var(--warn)]',
  staged: 'text-[var(--ok)]',
  unstaged: 'text-[var(--text-muted)]',
  conflict: 'text-[var(--warn)]',
  blocked: 'text-[var(--danger)]'
}

export function GitStatusMark({ status, kind, className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { status: string; kind?: 'file' | 'compact' }): React.JSX.Element {
  const tone = STATUS_TONE[status as GitStatus] ?? 'text-[var(--text-muted)]'
  const role = kind === 'file'
    ? 'changes-file-mark flex-none w-[14px] text-center font-mono text-[length:var(--tr-text-xs)] [font-weight:var(--tr-text-label-weight)]'
    : kind === 'compact'
      ? 'changes-file-status font-mono'
      : ''
  return <span {...props} className={`${role} ${tone} ${className}`} />
}
