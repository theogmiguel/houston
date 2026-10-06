import { useEffect, useState } from 'react'
import type { HarnessReview } from '../../houston/generated/HarnessReview'
import type { HarnessReport, HarnessReportError } from '../../houston/useHarness'
import { MarkdownPreview } from '../MarkdownPreview'
import { Select } from '../ui/Select'
import { DetailState, FeedbackBanner } from '../ui/navPrimitives'
import { InlineCluster, ReportFrame, CenteredEmptyNote } from '../ui/navText'
import { FieldActionButton } from '../ui/formPrimitives'
import { formatDay, formatWindow } from './harnessFormat'

export function HarnessReportView({
  reviews,
  initialReviewId,
  report,
  reportError,
  onLoadReport,
  onOpenFile,
  onReveal
}: {
  reviews: HarnessReview[]
  initialReviewId?: number
  report: HarnessReport | null
  reportError: HarnessReportError | null
  onLoadReport: (reviewId: number) => void
  onOpenFile: (path: string) => void
  onReveal: (path: string) => void
}): React.JSX.Element {
  const published = reviews.filter((r) => r.status === 'published')
  const [selected, setSelected] = useState<number | null>(initialReviewId ?? published[0]?.id ?? null)
  const current = published.find((r) => r.id === selected) ?? published[0] ?? null

  useEffect(() => {
    if (current) onLoadReport(current.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id])

  if (!current) {
    return (
      <CenteredEmptyNote>No report yet. A review writes its report once it publishes.</CenteredEmptyNote>
    )
  }
  const shown = report?.reviewId === current.id ? report : null
  const dir = current.run_dir
  return (
    <div className="grid gap-[var(--space-2-5)]">
      <InlineCluster>
        <Select
          aria-label="Review"
          value={String(current.id)}
          options={published.map((r) => ({
            value: String(r.id),
            label: `${formatDay(r.started_at_ms)} · ${formatWindow(r.window)}`
          }))}
          onChange={(v) => setSelected(Number(v))}
        />
        <FieldActionButton onClick={() => onOpenFile(`${dir}/report.md`)}>
          Open report.md
        </FieldActionButton>
        <FieldActionButton onClick={() => onOpenFile(`${dir}/findings.json`)}>
          Open findings.json
        </FieldActionButton>
        <FieldActionButton onClick={() => onReveal(`${dir}/report.md`)}>
          Show in folder
        </FieldActionButton>
      </InlineCluster>
      {shown?.truncated && (
        <FeedbackBanner tone="warning">
          This report is longer than Houston shows here; open report.md to read all of it.
        </FeedbackBanner>
      )}
      {shown ? (
        <ReportFrame data-testid="harness-report">
          <MarkdownPreview source={shown.markdown} variant="chat" />
        </ReportFrame>
      ) : reportError?.reviewId === current.id ? (
        <DetailState
          heading="Could not load the report"
          detail={reportError.message}
          tone="error"
          action={
            <FieldActionButton onClick={() => onLoadReport(current.id)}>
              Retry
            </FieldActionButton>
          }
        />
      ) : (
        <DetailState heading="Loading the report" detail={`Reading ${dir}/report.md`} />
      )}
    </div>
  )
}
