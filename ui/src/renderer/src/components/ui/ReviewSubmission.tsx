import type { HTMLAttributes, ReactNode } from 'react'
import { Button } from './Button'
import { Select } from './Select'
import { TextArea } from './TextArea'
import { Text } from './Text'

function ReviewRegion({ children, className, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; className: string }): React.JSX.Element {
  return <div {...props} className={className}>{children}</div>
}

export function ReviewComposer({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <ReviewRegion {...props} className="flex flex-col gap-[var(--space-2)] p-[var(--space-2-5)]">{children}</ReviewRegion>
}

export function ReviewToolbar({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <ReviewRegion {...props} className="flex items-center gap-[var(--space-2)]">{children}</ReviewRegion>
}

export function ReviewDraftList({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <ReviewRegion {...props} className="flex flex-col gap-[var(--space-1)]">{children}</ReviewRegion>
}

export function ReviewDraftRow({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <ReviewRegion {...props} className="flex items-start gap-[var(--space-2)]">{children}</ReviewRegion>
}

export function ReviewDraftBody({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" mono tone="secondary" className="flex-1 min-w-0 break-words">{children}</Text>
}

export function ReviewSubmitFooter({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <ReviewRegion {...props} className="flex items-center gap-[var(--space-2)]">{children}</ReviewRegion>
}

export function ReviewBarPanel({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <ReviewRegion {...props} className="flex flex-none flex-col gap-[var(--space-2)] border-t border-t-[var(--border)] bg-[var(--material-shell-bg)]">{children}</ReviewRegion>
}

export function ReviewSubmissionSpecimen(): React.JSX.Element {
  return <ReviewBarPanel><ReviewComposer><ReviewToolbar><Text size="small" weight="small" tone="primary">Review</Text><Select aria-label="Review verdict" value="comment" options={[{ value: 'comment', label: 'Comment' }]} onChange={() => {}} /></ReviewToolbar><TextArea rows={3} aria-label="Review body" /><ReviewDraftList><ReviewDraftRow><ReviewDraftBody>src/lib.rs:17 — Update this branch before submit.</ReviewDraftBody><Button variant="secondary">Remove</Button></ReviewDraftRow></ReviewDraftList><ReviewSubmitFooter><Text size="small" tone="faint">Nothing is sent until you submit.</Text><span className="flex-1" /><Button variant="primary">Submit review</Button></ReviewSubmitFooter></ReviewComposer></ReviewBarPanel>
}
