import type { TaskReviewCategory } from '../../houston/generated/TaskReviewCategory'
import type { TaskReviewFinding } from '../../houston/generated/TaskReviewFinding'
import type { TaskReviewFocus } from '../../houston/generated/TaskReviewFocus'
import type { TaskReviewSeverity } from '../../houston/generated/TaskReviewSeverity'
import type { TaskReviewVerdict as TaskReviewVerdictData } from '../../houston/generated/TaskReviewVerdict'
import { Chip, TaskMono, TaskRunNote, Text, type ChipTone } from '../ui'

const FOCUS_LABEL: Readonly<Record<TaskReviewFocus, string>> = {
  bugs: 'Bugs',
  security: 'Security',
  performance: 'Performance',
  full: 'Full'
}

const VERDICT_LABEL: Readonly<Record<TaskReviewVerdictData['verdict'], string>> = {
  pass: 'Passed',
  fail: 'Failed',
  skipped: 'Skipped'
}

const VERDICT_TONE: Readonly<Record<TaskReviewVerdictData['verdict'], ChipTone>> = {
  pass: 'success',
  fail: 'danger',
  skipped: 'default'
}

const SEVERITY_TONE: Readonly<Record<TaskReviewSeverity, ChipTone>> = {
  high: 'danger',
  medium: 'warning',
  low: 'info',
  nit: 'default'
}

const CATEGORY_LABEL: Readonly<Record<TaskReviewCategory, string>> = {
  bug: 'Bug',
  security: 'Security',
  performance: 'Performance',
  other: 'Other'
}

export function shortHeadSha(head: string): string {
  return head.length > 7 ? head.slice(0, 7) : head
}

/** What the reviewer read, what it decided and where it found problems. */
export function TaskReviewResult({ review }: { review: TaskReviewVerdictData }): React.JSX.Element {
  return (
    <section aria-label="Review result" data-testid="task-review-result" className="grid gap-[var(--space-2)] px-[var(--space-2-5)] pb-[var(--space-2)]">
      <div className="flex min-w-0 flex-wrap items-center gap-[var(--space-2)]">
        <Chip variant="state" tone={VERDICT_TONE[review.verdict]} label={VERDICT_LABEL[review.verdict]} />
        <Text size="caption" tone="muted">Focus: {FOCUS_LABEL[review.focus]}</Text>
        <Text size="caption" tone="muted">Reviewed <TaskMono>{shortHeadSha(review.head_sha)}</TaskMono></Text>
        {review.outdated && <Chip variant="state" tone="warning" label="Review outdated" />}
      </div>
      {review.outdated && (
        <Text size="caption" tone="muted">The branch moved past this reviewed head, so these findings may no longer apply.</Text>
      )}
      {review.verdict === 'skipped' && review.skipped_reason && <TaskRunNote kind="reason">{review.skipped_reason}</TaskRunNote>}
      {review.findings.length > 0 && (
        <ul aria-label="Review findings" className="m-0 grid list-none gap-0 p-0">
          {review.findings.map((finding, index) => <FindingRow key={`${finding.path}:${finding.line}:${index}`} finding={finding} />)}
        </ul>
      )}
    </section>
  )
}

function FindingRow({ finding }: { finding: TaskReviewFinding }): React.JSX.Element {
  return (
    <li className="grid min-w-0 gap-[var(--space-1)] border-t border-[var(--divider)] py-[var(--space-1-5)] first:border-t-0">
      <div className="flex min-w-0 flex-wrap items-center gap-[var(--space-2)]">
        <Text size="caption" mono>{finding.path}:{finding.line}</Text>
        <Chip variant="state" tone={SEVERITY_TONE[finding.severity]} label={finding.severity} />
        <Text size="caption" tone="muted">{CATEGORY_LABEL[finding.category]}</Text>
      </div>
      <Text size="sm" tone="secondary">{finding.message}</Text>
    </li>
  )
}
