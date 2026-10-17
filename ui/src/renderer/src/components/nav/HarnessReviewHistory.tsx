import { useState } from 'react'
import type { HarnessFinding } from '../../houston/generated/HarnessFinding'
import type { HarnessReview } from '../../houston/generated/HarnessReview'
import type { HarnessState } from '../../houston/useHarness'
import { openSideTasks } from '../../sidePanel'
import { IconChevronLeft } from '../icons'
import { Button, Caption, Card, Count, StatusLabel, type StatusLabelValue } from '../ui'
import { SectionTitle } from '../ui/navText'
import { ReviewFinding, ReviewFindingList, ReviewOutcome, ReviewOutcomeList } from '../ui/ReviewFinding'
import { HarnessReportView } from './HarnessReportView'
import { formatHarnessDate } from './harnessFormat'

export function HarnessReviewHistory({
  state,
  report,
  reportError,
  onLoadReport,
  onOpenFile,
  onReveal,
  deltaOverrides
}: {
  state: HarnessState
  report: Parameters<typeof HarnessReportView>[0]['report']
  reportError: Parameters<typeof HarnessReportView>[0]['reportError']
  onLoadReport: (reviewId: number) => void
  onOpenFile: (path: string) => void
  onReveal: (path: string) => void
  deltaOverrides?: Record<number, { new: number; gone: number }>
}): React.JSX.Element {
  const [reportId, setReportId] = useState<number | null>(null)
  const published = state.reviews.filter((review) => review.status === 'published')
  const latest = published[0] ?? null

  if (reportId !== null) {
    return (
      <section className="grid gap-[var(--space-2)]">
        <Button variant="ghost" size="sm" icon={IconChevronLeft} className="justify-self-start" onClick={() => setReportId(null)}>Back to reviews</Button>
        <HarnessReportView
          reviews={published}
          initialReviewId={reportId}
          report={report}
          reportError={reportError}
          onLoadReport={onLoadReport}
          onOpenFile={onOpenFile}
          onReveal={onReveal}
        />
      </section>
    )
  }

  return (
    <section className="grid gap-[var(--space-3)]" aria-label="Reviews">
      <SectionTitle>Review history{published.length > 0 && <Count value={published.length} />}</SectionTitle>
      {latest ? (
        <ReviewFindingList label="Published reviews">
          {published.map((review) => (
            <ReviewFinding
              key={review.id}
              heading={`Review #${review.id}`}
              meta={`${formatHarnessDate(review.started_at_ms, review === latest)} · ${review.sessions == null ? 'Session total not reported' : `${review.sessions} sessions`} · ${reviewDelta(review, state.findings, deltaOverrides?.[review.id])}`}
              secondaryAction={review === latest ? <Button variant="ghost" onClick={() => setReportId(review.id)}>Full report</Button> : undefined}
              defaultOpen={review === latest}
              detail={<ReviewOutcomes review={review} findings={state.findings} />}
            />
          ))}
        </ReviewFindingList>
      ) : (
        <Card shape="card" padding="md"><Caption>No published reviews yet. Each review lists what it found new, what is still there and what is gone.</Caption></Card>
      )}
    </section>
  )
}

type Outcome = 'new' | 'still' | 'gone'

const OUTCOME: Record<Outcome, { status: StatusLabelValue; label: string }> = {
  new: { status: 'Open', label: 'New' },
  still: { status: 'Fixing', label: 'Still there' },
  gone: { status: 'Verified', label: 'Gone' }
}

/** Sorts a review's findings into what it raised, what it saw again and what a fix removed. */
export function reviewOutcomes(review: HarnessReview, findings: HarnessFinding[]): { finding: HarnessFinding; outcome: Outcome }[] {
  const related = findings.filter((finding) => finding.review_id === review.id || finding.verification?.review_id === review.id)
  const outcomeOf = (finding: HarnessFinding): Outcome => {
    if (finding.verification?.review_id === review.id && finding.verification.verdict === 'gone') return 'gone'
    return !finding.recurred && !finding.task ? 'new' : 'still'
  }
  const order: Outcome[] = ['new', 'still', 'gone']
  return related.map((finding) => ({ finding, outcome: outcomeOf(finding) })).sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome))
}

function ReviewOutcomes({ review, findings }: { review: HarnessReview; findings: HarnessFinding[] }): React.JSX.Element {
  const outcomes = reviewOutcomes(review, findings)
  if (outcomes.length === 0) return <Caption>No finding details are available for this review.</Caption>
  return (
    <ReviewOutcomeList label={`Review #${review.id} findings`}>
      {outcomes.map(({ finding, outcome }) => {
        const task = finding.task
        return (
          <ReviewOutcome
            key={finding.key}
            status={<StatusLabel status={OUTCOME[outcome].status} size="small">{OUTCOME[outcome].label}</StatusLabel>}
            heading={finding.title}
            meta={<>
              {task && <><Button variant="body-link" onClick={() => openSideTasks(false, task.task_id)}>{task.key}</Button>{' · '}</>}
              {outcome === 'gone' ? `${finding.verification?.sessions_after ?? 0} sessions since it merged` : task && outcome === 'still' ? 'not merged yet' : `${finding.count} sessions`}
            </>}
          />
        )
      })}
    </ReviewOutcomeList>
  )
}

function reviewDelta(review: HarnessReview, findings: HarnessFinding[], override?: { new: number; gone: number }): string {
  if (override) return `${override.new} new · ${override.gone} gone`
  const outcomes = reviewOutcomes(review, findings)
  return `${outcomes.filter((item) => item.outcome === 'new').length} new · ${outcomes.filter((item) => item.outcome === 'gone').length} gone`
}
