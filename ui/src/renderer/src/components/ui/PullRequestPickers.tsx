import { ReviewButton } from './ReviewButtonRoles'
import type { HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'
import { MetadataRow, MetadataValue } from './MetadataRow'
import { PullRequestLabel } from './PullRequestLabel'
import { OptionCandidateList } from './OptionCandidateList'

export function ReactionList({ children, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }): React.JSX.Element {
  return <span {...props} className={`inline-flex items-center gap-[var(--space-1)] flex-wrap ${props.className ?? ''}`}>{children}</span>
}

export function ReactionOptionList({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="inline-flex items-center gap-[var(--space-0-5)]">{children}</span>
}

export function PickerSection({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`flex flex-col gap-[var(--space-1)] ${props.className ?? ''}`}>{children}</div>
}

export function PickerFieldLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="span" size="small" weight="small" tone="muted" className="flex-none w-[var(--tr-stack-label-width)]">{children}</Text>
}

export function ReviewerValue({ children, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }): React.JSX.Element {
  return <MetadataValue {...props} className={`min-w-0 flex-1 ${props.className ?? ''}`}>{children}</MetadataValue>
}

export function CandidateCheck({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="flex-none w-3.5 inline-flex justify-center text-[var(--accent)]">{children}</span>
}

export function CandidateName({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" tone="primary" className="flex-1 min-w-0 truncate">{children}</Text>
}

export function CandidateStatus({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" tone="faint" className="flex-none">{children}</Text>
}

export function CandidateDescription({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" tone="faint" className="flex-none max-w-[var(--tr-candidate-description-max)] truncate">{children}</Text>
}

export function CandidateEmptyMessage({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="small" tone="muted" className="px-[var(--space-2)] py-[var(--space-1-5)]">{children}</Text>
}

export function PickerErrorMessage({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" tone="danger" className="break-words [overflow-wrap:anywhere]">{children}</Text>
}

export function CandidateActions({ children, align = 'start', ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; align?: 'start' | 'end' }): React.JSX.Element {
  return <div {...props} className={`flex items-center gap-[var(--space-2)] p-[var(--space-1-5)] border-t border-t-[var(--divider)] ${align === 'end' ? 'justify-end' : ''} ${props.className ?? ''}`}>{children}</div>
}

export function LabelSummaryRow({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <MetadataRow {...props} className={`flex-wrap ${props.className ?? ''}`}>{children}</MetadataRow>
}

export function LabelSummary({ labels, children, ...props }: HTMLAttributes<HTMLSpanElement> & { labels?: ReactNode; children?: ReactNode }): React.JSX.Element {
  return <span {...props} className={`min-w-0 flex-1 inline-flex items-center gap-[var(--space-1)] flex-wrap ${props.className ?? ''}`}>{labels ?? children}</span>
}

export function PickerRoleSpecimen(): React.JSX.Element {
  return <PickerSection><MetadataRow><PickerFieldLabel>Reviewers</PickerFieldLabel><ReviewerValue>octocat</ReviewerValue></MetadataRow><PickerErrorMessage>One candidate could not be loaded.</PickerErrorMessage><OptionCandidateList><CandidateName>octocat</CandidateName><CandidateStatus>requested</CandidateStatus><CandidateEmptyMessage>No candidates</CandidateEmptyMessage><CandidateActions><ReviewButton variant="primary-action">Apply</ReviewButton><ReviewButton variant="secondary-action">Cancel</ReviewButton><ReviewButton variant="picker-done-action">Done</ReviewButton><PullRequestLabel>bug</PullRequestLabel></CandidateActions></OptionCandidateList></PickerSection>
}
