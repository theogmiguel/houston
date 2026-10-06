import type { ElementType, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { variants } from './variants'
import { Text } from './Text'

export type PullRequestRole =
  | 'empty-panel' | 'empty-heading' | 'empty-description' | 'link-form' | 'action-row'
  | 'number-field' | 'error-message' | 'detail-error-panel' | 'header-actions'
  | 'secondary-caption' | 'pull-request-title' | 'branch-summary' | 'edit-form'
  | 'check-row' | 'check-name' | 'check-meta' | 'checks-panel' | 'check-details'
  | 'metadata-label' | 'metadata-value' | 'danger-metadata-value' | 'review-list'
  | 'review-row' | 'review-author' | 'inspector-header' | 'detail-content'
  | 'tab-frame' | 'tab-toolbar' | 'viewed-label' | 'merge-status' | 'scroll-area'
  | 'file-pane' | 'approval-requirement' | 'fill'
  | 'right-meta-label' | 'right-meta-value' | 'pull-request-command' | 'loading-indicator'
  | 'summary-content'

const roleClasses = variants('', {
  role: {
    'empty-panel': 'flex-1 min-h-0 flex flex-col items-center justify-center gap-[var(--space-2)] p-[var(--space-6)] text-center',
    'empty-heading': '[font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]',
    'empty-description': '[font-size:var(--tr-text-small-size)] text-[var(--text-muted)] max-w-[var(--tr-empty-compact-copy-max)]',
    'link-form': 'flex flex-col gap-[var(--space-1)]',
    'action-row': 'flex items-center gap-[var(--space-2)]',
    'number-field': 'h-[var(--h-ctl)] px-[var(--space-2)] rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--content-bg)] [font-size:var(--tr-text-small-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus-visible:outline-none focus-visible:border-[var(--border-focus)] w-[var(--tr-pr-number-width)]',
    'error-message': '[font-size:var(--tr-text-small-size)] text-[var(--danger)] break-words [overflow-wrap:anywhere]',
    'detail-error-panel': 'flex flex-col gap-[var(--space-1-5)] p-[var(--space-3)]',
    'header-actions': 'flex items-center gap-[var(--space-2)] flex-wrap',
    'secondary-caption': '[font-size:var(--tr-text-small-size)] text-[var(--text-muted)]',
    'pull-request-title': '[font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)] break-words',
    'branch-summary': 'font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-faint)] break-words',
    'edit-form': 'flex flex-col gap-[var(--space-1-5)]',
    'check-row': 'flex items-center gap-[var(--space-2)] h-[var(--h-row)] px-[var(--space-2-5)] [font-size:var(--tr-text-small-size)] border-t border-t-[var(--divider)] first:border-t-0',
    'check-name': 'flex-1 min-w-0 truncate text-[var(--text-primary)]',
    'check-meta': 'flex-none font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-faint)]',
    'checks-panel': 'flex flex-col gap-[var(--space-2)]',
    'check-details': 'flex items-center gap-[var(--space-2)]',
    'metadata-label': 'w-[var(--tr-stack-label-width)] flex-none text-[var(--text-muted)]',
    'metadata-value': 'min-w-0 flex-1 text-[var(--text-primary)]',
    'right-meta-label': 'ml-auto text-[var(--text-muted)]',
    'right-meta-value': 'ml-auto font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-faint)]',
    'pull-request-command': 'font-mono',
    'loading-indicator': 'loop-anim motion-safe:animate-[git-spin_0.9s_linear_infinite]',
    'summary-content': 'flex flex-col gap-[var(--space-2-5)] p-[var(--space-3)]',
    'danger-metadata-value': 'min-w-0 flex-1 text-[color-mix(in_srgb,var(--danger)_88%,var(--text-primary))]',
    'review-list': 'flex flex-col',
    'review-row': 'flex flex-col gap-[var(--space-0-5)] px-[var(--space-3)] py-[var(--space-1-5)] border-t border-t-[var(--divider)] first:border-t-0',
    'review-author': '[font-size:var(--tr-text-small-size)] text-[var(--text-primary)]',
    'inspector-header': 'flex flex-col gap-[var(--space-1-5)] p-[var(--space-3)] border-b border-b-[var(--divider)]',
    'detail-content': 'flex flex-col gap-[var(--space-3)]',
    'tab-frame': 'flex-1 min-h-0 flex flex-col',
    'tab-toolbar': 'flex-none flex items-center gap-[var(--space-2)] px-[var(--space-2-5)] py-[var(--space-1-5)] border-b border-b-[var(--divider)]',
    'viewed-label': '[font-size:var(--tr-text-small-size)] text-[var(--text-muted)]',
    'merge-status': 'ml-auto font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-faint)]',
    'scroll-area': 'flex-1 min-h-0 overflow-y-auto [scrollbar-width:var(--tr-scrollbar-thin)]',
    'file-pane': 'flex flex-col gap-[var(--space-2-5)] p-[var(--space-3)]',
    'approval-requirement': 'flex items-center',
    fill: 'flex-1'
  }
}, { role: 'action-row' })

export function PullRequestRole({ as: Tag = 'div', role, children, className = '', ...props }: HTMLAttributes<HTMLElement> & { as?: ElementType; role: PullRequestRole; children?: ReactNode }): React.JSX.Element {
  const roleClassName = `${roleClasses({ role })} ${className}`
  if (['empty-heading', 'empty-description', 'error-message', 'secondary-caption', 'pull-request-title', 'branch-summary', 'check-name', 'check-meta', 'metadata-label', 'metadata-value', 'danger-metadata-value', 'review-author', 'viewed-label', 'merge-status', 'right-meta-label', 'right-meta-value', 'pull-request-command'].includes(role)) {
    return <Text {...props} as={Tag} className={roleClassName}>{children}</Text>
  }
  return <Tag {...props} className={roleClassName}>{children}</Tag>
}

export function PullRequestNumberField({ variant = 'number', ...props }: InputHTMLAttributes<HTMLInputElement> & { variant?: 'number' | 'full' }): React.JSX.Element {
  return <input {...props} className={`h-[var(--h-ctl)] ${variant === 'number' ? 'w-[var(--tr-pr-number-width)]' : 'w-full'} rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--content-bg)] px-[var(--space-2)] [font-size:var(--tr-text-small-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus-visible:outline-none focus-visible:border-[var(--border-focus)]`} />
}

export function PullRequestRoleSpecimen(): React.JSX.Element {
  return <div className="flex flex-col gap-[var(--space-2)]"><PullRequestRole role="empty-heading">Pull request</PullRequestRole><PullRequestRole role="secondary-caption">Summary</PullRequestRole><PullRequestRole role="check-row">Checks</PullRequestRole><PullRequestRole role="metadata-label">Review</PullRequestRole></div>
}
