import * as React from 'react'
import type { JSX } from 'react'

const SURFACE_CLASSES = {
  'pr-number': 'font-mono text-[var(--text-secondary)]',
  'pr-head-ref': 'mx-[var(--space-1)] font-mono',
  'pr-scroll-area': 'flex-1 min-h-0 overflow-y-auto [scrollbar-width:var(--tr-scrollbar-thin)]',
  'pr-compact-checks': 'pr-compact-checks',
  'pr-compact-checks-heading': 'pr-compact-checks-heading',
  'pr-branch-people': 'pr-branch-people',
  'pr-compact-details': 'pr-compact-details',
  'pr-branch-toolbar': 'pr-branch-toolbar',
  'pr-tab-toolbar': 'relative z-20 flex-none flex items-center gap-[var(--space-2)] px-[var(--space-2-5)] py-[var(--space-1-5)] border-b border-b-[var(--divider)]',
  'pr-check-failed-icon': 'pr-check-failed-icon',
  'pr-branch-topline': 'pr-branch-topline',
  'pr-branch-identity': 'pr-branch-identity',
  'pr-crumb-repo': 'pr-crumb-repo',
  'pr-crumb-number': 'pr-crumb-number',
  'pr-branch-heading': 'pr-branch-heading',
  'pr-branch-author': 'pr-branch-author',
  'pr-branch-avatar': 'pr-branch-avatar',
  'pr-branch-checkout': 'pr-branch-checkout',
  'pr-branch-refs': 'pr-branch-refs',
  'pr-branch-ref-pair': 'pr-branch-ref-pair',
  'pr-branch-stat': 'pr-branch-stat',
  'pr-branch-diff': 'pr-branch-diff',
  'pr-header-actions': 'pr-header-actions',
  'pr-merged-state': 'pr-merged-state',
  'pr-closed-state': 'pr-closed-state',
  'pr-merge-caption': 'sr-only',
  'pr-branch-summary': 'pr-branch-summary',
  'pr-branch-description-action': 'pr-branch-description-action',
  'pr-label-pill': 'pr-label-pill',
  'pr-label-dot': 'pr-label-dot',
  'pr-inspector-comments-section': 'pr-inspector-comments-section',
  'pr-inspector-comments-sticky': 'pr-inspector-comments-sticky',
  'pr-inspector-comments-toggle': 'pr-inspector-comments-toggle',
  'pr-inspector-comments-sort': 'pr-inspector-comments-sort',
  'pr-inspector-comments-body': 'pr-inspector-comments-body',
  'pr-inspector-review': 'pr-inspector-review',
  'pr-inspector-section-caption': 'pr-inspector-section-caption',
  'pr-inspector-review-count': 'pr-inspector-review-count',
  'pr-inspector-comments': 'pr-inspector-comments',
  'pr-inspector-comment': 'pr-inspector-comment',
  'pr-inspector-comment-head': 'pr-inspector-comment-head',
  'pr-inspector-comment-avatar': 'pr-inspector-comment-avatar',
  'pr-inspector-comment-age': 'pr-inspector-comment-age',
  'pr-inspector-comment-body': 'pr-inspector-comment-body',
  'pr-inspector-comment-links': 'pr-inspector-comment-links',
  'pr-inspector-link': 'pr-inspector-link',
  'pr-inspector-reply': 'pr-inspector-reply',
  'pr-inspector-reply-actions': 'pr-inspector-reply-actions',
  'pr-inspector-thread-actions': 'pr-inspector-thread-actions',
  'changes-inline-list': 'changes-inline-list',
  'changes-inline-empty': 'changes-inline-empty',
  'changes-inline-diff': 'changes-inline-diff',
  'changes-diff-toolbar': 'changes-diff-toolbar',
  'changes-diff-scope-wrap': 'changes-diff-scope-wrap',
  'changes-diff-scope': 'changes-diff-scope',
  'changes-diff-scope-menu': 'changes-diff-scope-menu',
  'changes-diff-refs': 'changes-diff-refs',
  'changes-diff-stat': 'changes-diff-stat',
  'changes-diff-actions': 'changes-diff-actions',
  'changes-diff-segment': 'changes-diff-segment',
  'changes-inline-group': 'changes-inline-group',
  'changes-inline-file': 'changes-inline-file',
  'changes-inline-loading': 'changes-inline-loading',
  'changes-inline-file-button': 'changes-inline-file-button',
  'changes-inline-chevron': 'changes-inline-chevron',
  'changes-inline-status': 'changes-inline-status'
} as const

type PrTabSurface = keyof typeof SURFACE_CLASSES
type PrTabState = string
const STATE_CLASSES: Record<string, string> = {
  hidden: 'is-hidden',
  detached: 'is-detached',
  wrapped: 'is-wrapped',
  split: 'is-split',
  open: 'is-open',
  merged: 'is-merged',
  closed: 'is-closed',
  resolved: 'is-resolved',
  'open-state': 'is-open',
  compact: 'pr-branch-toolbar'
}

type PrTabProps<T extends React.ElementType> = {
  as: T
  surface: PrTabSurface
  state?: PrTabState | null
  states?: PrTabState[]
  enabled?: boolean
  baseClass?: string
} & Omit<React.ComponentPropsWithRef<T>, 'className'>

export function PrTab<T extends React.ElementType>({
  as,
  surface,
  state,
  states = [],
  enabled = true,
  baseClass = '',
  ...props
}: PrTabProps<T>): JSX.Element {
  const activeStates = [...(state ? [state] : []), ...states]
  const modifier = activeStates.map((value) => ` ${STATE_CLASSES[value] ?? (value.startsWith('is-') ? value : `is-${value}`)}`).join('')
  const className = enabled ? `${SURFACE_CLASSES[surface]}${modifier}${baseClass ? ` ${baseClass}` : ''}` : baseClass
  return React.createElement(as, { ...props, className })
}
