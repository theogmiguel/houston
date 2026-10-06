import type { HTMLAttributes, ReactNode } from 'react'
import { variants } from './variants'
import { Text } from './Text'

export type PullRequestStateValue = 'open' | 'merged' | 'closed'
export type CheckStateValue = 'passing' | 'running' | 'queued' | 'failing' | 'skipped' | 'unknown' | 'none'

const stateClasses = variants('flex-none inline-flex items-center px-1.5 rounded-[var(--tr-radius-pill)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase tracking-[var(--tr-text-label-tracking)] leading-4', {
  state: {
    open: 'bg-[color-mix(in_srgb,var(--ok)_16%,transparent)] text-[var(--ok)]',
    merged: 'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)]',
    closed: 'bg-[color-mix(in_srgb,var(--text-muted)_18%,transparent)] text-[var(--text-muted)]',
    draft: 'bg-[color-mix(in_srgb,var(--warn)_18%,transparent)] text-[var(--warn)]'
  }
}, { state: 'open' })

export function PullRequestState({ state, isDraft = false, children, ...props }: HTMLAttributes<HTMLSpanElement> & { state: PullRequestStateValue; isDraft?: boolean; children: ReactNode }): React.JSX.Element {
  const tone = isDraft && state === 'open' ? 'warn' : state === 'merged' ? 'info' : state === 'closed' ? 'muted' : 'ok'
  return <Text {...props} size="label" weight="label" tone={tone} className={stateClasses({ state: isDraft && state === 'open' ? 'draft' : state })}>{children}</Text>
}

const checkTone: Record<CheckStateValue, 'ok' | 'danger' | 'warn' | 'faint'> = {
  passing: 'ok', running: 'warn', queued: 'warn', failing: 'danger', skipped: 'faint', unknown: 'warn', none: 'faint'
}

const dotClasses = variants('rounded-full w-[var(--tr-check-dot-size)]', {
  state: {
    passing: 'bg-[var(--ok)]',
    running: 'bg-[var(--info)]',
    queued: 'bg-[var(--warn)]',
    failing: 'bg-[var(--danger)]',
    skipped: 'bg-[var(--text-faint)]',
    unknown: 'bg-[var(--warn)]',
    none: 'bg-[var(--text-faint)]'
  }
}, { state: 'unknown' })

export function CheckStateText({ state, children, layout = 'default', className = '' }: { state: CheckStateValue | null | undefined; children: ReactNode; layout?: 'default' | 'inline'; className?: string }): React.JSX.Element {
  const tone = state === 'passing' ? checkTone.passing : state === 'failing' ? checkTone.failing : state === 'running' ? checkTone.running : 'faint'
  return <Text size="small" tone={tone} mono={layout === 'inline'} className={`${layout === 'inline' ? 'flex-none inline-flex items-center gap-[var(--space-1)]' : ''} ${className}`}>{children}</Text>
}

export function CheckStateDot({ state, size = 'default', runningTone = 'info', className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { state: CheckStateValue | null | undefined; size?: 'default' | 'check'; runningTone?: 'info' | 'warn' }): React.JSX.Element {
  const normalized: CheckStateValue = state === 'passing' || state === 'running' || state === 'queued' || state === 'failing' || state === 'skipped' || state === 'none' ? state : 'unknown'
  const toneClass = state === 'running' && runningTone === 'warn' ? 'bg-[var(--warn)]' : dotClasses({ state: normalized })
  return <span {...props} aria-hidden="true" className={`rounded-full w-[var(--tr-check-dot-size)] ${toneClass} ${size === 'check' ? 'h-[var(--tr-check-dot-size)]' : ''} ${className}`} />
}

export function CheckSummary({ failed, running, count, size = 'default', className = '' }: { failed: number; running: number; count: number; size?: 'default' | 'check'; className?: string }): React.JSX.Element {
  const tone = failed > 0 ? 'danger' : running > 0 ? 'warn' : count > 0 ? 'ok' : 'faint'
  const classes = tone === 'danger' ? 'bg-[var(--stop)]' : tone === 'warn' ? 'bg-[var(--warn)]' : tone === 'ok' ? 'bg-[var(--ok)]' : 'bg-[var(--text-faint)]'
  return <span className={`${classes} w-[var(--tr-check-dot-size)] ${size === 'check' ? 'h-[var(--tr-check-dot-size)]' : ''} ${className}`} aria-hidden="true" />
}

export function PullRequestStateSpecimen(): React.JSX.Element {
  return <div className="flex flex-col gap-[var(--space-2)]"><div className="flex items-center gap-[var(--space-2)]"><PullRequestState state="open">Open</PullRequestState><PullRequestState state="merged">Merged</PullRequestState><PullRequestState state="closed">Closed</PullRequestState><PullRequestState state="open" isDraft>Draft</PullRequestState><CheckStateDot state="passing" className="h-[var(--space-1-5)] w-[var(--space-1-5)]" /><CheckStateDot state="failing" className="h-[var(--space-1-5)] w-[var(--space-1-5)]" /><CheckStateDot state="running" runningTone="warn" className="h-[var(--space-1-5)] w-[var(--space-1-5)]" /></div><PullRequestDescription>Summary text for the pull request with enough copy to show the preview line clamp.</PullRequestDescription><PullRequestReviewBody>Review details with a short line clamp.</PullRequestReviewBody></div>
}

export function PullRequestDescription({ children, clamped = true }: { children: ReactNode; clamped?: boolean }): React.JSX.Element {
  return <Text as="p" size="body" tone="secondary" className={`whitespace-pre-wrap break-words ${clamped ? 'line-clamp-4' : ''}`}>{children}</Text>
}

export function PullRequestReviewBody({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" tone="muted" className="whitespace-pre-wrap break-words line-clamp-3">{children}</Text>
}
