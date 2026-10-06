import type { HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'
import { Button } from './Button'

export interface DiscussionEntryProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export function DiscussionEntry({ children, className = '', ...props }: DiscussionEntryProps): React.JSX.Element {
  return <div {...props} className={`flex flex-col gap-[var(--space-1)] px-[var(--space-3)] py-[var(--space-2)] border-t border-t-[var(--divider)] first:border-t-0 ${className}`}>{children}</div>
}

export function DiscussionBody({ children, className = '' }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <Text size="small" tone="secondary" className={`whitespace-pre-wrap break-words ${className}`}>{children}</Text>
}

export function DiscussionMeta({ children, tone = 'faint', align = 'start', ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode; tone?: 'faint' | 'ok'; align?: 'start' | 'end' }): React.JSX.Element {
  return <Text {...props} size="small" tone={tone} className={align === 'end' ? 'ml-auto' : ''}>{children}</Text>
}

export function DiscussionPath({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" mono breakAll tone="primary">{children}</Text>
}

export function DiscussionResolveAction({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="ml-auto">{children}</div>
}

export function DiscussionActionsRow({ children, wrap = false }: { children: ReactNode; wrap?: boolean }): React.JSX.Element {
  return <div className={`flex items-center gap-[var(--space-2)] ${wrap ? 'flex-wrap' : ''}`}>{children}</div>
}

export function DiscussionComposer({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-[var(--space-1-5)]">{children}</div>
}

export function DiscussionCommentRow({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`flex flex-col gap-[var(--space-0-5)] ${props.className ?? ''}`}>{children}</div>
}

export function DiscussionThreadHeader({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)] flex-wrap">{children}</div>
}

export function DiscussionCommentMetaRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)]">{children}</div>
}

export function DiscussionThreadList({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`flex flex-col ${props.className ?? ''}`}>{children}</div>
}

export function DiscussionErrorMessage({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <Text {...props} as="div" size="small" tone="danger" className="px-[var(--space-3)] py-[var(--space-1-5)] break-words [overflow-wrap:anywhere]">{children}</Text>
}

export function DiscussionComposerPanel({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-[var(--space-1-5)] p-[var(--space-3)] border-t border-t-[var(--divider)]">{children}</div>
}

export function DiscussionAuthor({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" weight="small" tone="primary">{children}</Text>
}

export function DiscussionEntrySpecimen(): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-[var(--tr-radius-sm)] border border-[var(--divider)]">
      <DiscussionEntry>
        <DiscussionActionsRow><DiscussionAuthor>Reviewer</DiscussionAuthor><DiscussionMeta>Updated</DiscussionMeta></DiscussionActionsRow>
        <DiscussionBody>Could we preserve this status after refresh?</DiscussionBody>
        <DiscussionMeta>2 minutes ago</DiscussionMeta>
      </DiscussionEntry>
      <DiscussionActionsRow>
        <Button variant="discussion-edit-action">Edit</Button>
        <Button variant="discussion-cancel-action">Cancel</Button>
        <Button variant="discussion-reply-action">Reply</Button>
        <Button variant="discussion-submit-action">Comment</Button>
      </DiscussionActionsRow>
    </div>
  )
}
