import { useState } from 'react'
import type { HarnessFinding } from '../../houston/generated/HarnessFinding'
import type { HarnessReview } from '../../houston/generated/HarnessReview'
import type { HarnessState } from '../../houston/useHarness'
import { openSideTasks } from '../../sidePanel'
import { IconChevronDown, IconChevronRight } from '../icons'
import { Button, Card, SectionHead, StatusLabel } from '../ui'
import { HarnessReportView } from './HarnessReportView'

export function HarnessReviewHistory({
  state,
  report,
  reportError,
  onLoadReport,
  onOpenFile,
  onReveal
}: {
  state: HarnessState
  report: Parameters<typeof HarnessReportView>[0]['report']
  reportError: Parameters<typeof HarnessReportView>[0]['reportError']
  onLoadReport: (reviewId: number) => void
  onOpenFile: (path: string) => void
  onReveal: (path: string) => void
}): React.JSX.Element {
  const [reportId, setReportId] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const published = state.reviews.filter((review) => review.status === 'published')
  const latest = published[0] ?? null

  if (reportId !== null) {
    return (
      <section className="grid gap-[var(--space-2)]">
        <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setReportId(null)}>Back to reviews</Button>
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
    <section className="grid gap-[var(--space-2)]" aria-label="Reviews">
      <SectionHead title="Reviews" count={published.length} />
      {latest ? (
        <Card>
          <Card.Row
          heading={`Review #${latest.id}`}
          meta={`${formatReviewMoment(latest.started_at_ms)} · ${latest.sessions ?? 0} sessions · Claude Code, Codex`}
          compact
            action={<Button size="sm" variant="ghost" onClick={() => setReportId(latest.id)}>Full report</Button>}
          />
          <ReviewGroups review={latest} findings={state.findings} />
        </Card>
      ) : (
        <p>No published reviews yet.</p>
      )}
      {published.slice(1).map((review) => (
        <Card key={review.id}>
          <Card.Row
              heading={`Review #${review.id}`}
              meta={`${formatHistoryDate(review.started_at_ms)} · ${review.sessions ?? 0} sessions · ${review.finding_count} findings`}
              compact
              action={
                <Button
                  variant="icon"
                  icon={expanded === review.id ? IconChevronDown : IconChevronRight}
                  aria-label={`${expanded === review.id ? 'Collapse' : 'Expand'} review #${review.id}`}
                  aria-expanded={expanded === review.id}
                  onClick={() => setExpanded((current) => current === review.id ? null : review.id)}
                />
              }
          />
          {expanded === review.id && <ReviewGroups review={review} findings={state.findings} />}
        </Card>
      ))}
    </section>
  )
}

function ReviewGroups({ review, findings }: { review: HarnessReview; findings: HarnessFinding[] }): React.JSX.Element {
  const related = findings.filter((finding) => finding.review_id === review.id || finding.verification?.review_id === review.id)
  const gone = related.filter((finding) => finding.verification?.review_id === review.id && finding.verification.verdict === 'gone')
  const fresh = related.filter((finding) => !gone.includes(finding) && !finding.recurred && !finding.task)
  const still = related.filter((finding) => !gone.includes(finding) && !fresh.includes(finding))

  return (
    <div className="grid gap-[var(--space-1)] px-[var(--space-2-5)] pb-[var(--space-2)]">
      <ReviewGroup label="New" rail="new" findings={fresh} />
      <ReviewGroup label="Still there" rail="still" findings={still} />
      <ReviewGroup label="Gone" rail="gone" findings={gone} />
      {related.length === 0 && <p>No finding details are available for this review.</p>}
    </div>
  )
}

function ReviewGroup({
  label,
  rail,
  findings
}: {
  label: string
  rail: 'new' | 'still' | 'gone'
  findings: HarnessFinding[]
}): React.JSX.Element | null {
  if (findings.length === 0) return null
  return (
    <section aria-label={label}>
      <SectionHead title={label} count={findings.length} />
      {findings.map((finding) => (
        <Card.Row
          key={finding.key}
          rail={rail}
          compact
          heading={finding.title}
          meta={rail === 'gone' ? <>{finding.verification?.sessions_after ?? 0} sessions since it merged</> : `${finding.count} sessions`}
          status={finding.task ? <Button size="sm" variant="link" onClick={() => openSideTasks(false, finding.task?.task_id)}>{finding.task.key}</Button> : rail === 'gone' ? <StatusLabel status="Done" /> : undefined}
        />
      ))}
    </section>
  )
}

function formatReviewMoment(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

function formatHistoryDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
