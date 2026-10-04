import { useEffect, useState } from 'react'
import type { HarnessReview } from '../../houston/generated/HarnessReview'
import type { HarnessReport, HarnessReportError } from '../../houston/useHarness'
import { MarkdownPreview } from '../MarkdownPreview'
import { Select } from '../Select'
import { NavDetailState, NavFeedback, SECONDARY_BUTTON } from './navChrome'
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
      <p className="py-[24px] text-center [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)]">
        No report yet. A review writes its report once it publishes.
      </p>
    )
  }
  const shown = report?.reviewId === current.id ? report : null
  const dir = current.run_dir
  return (
    <div className="flex flex-col gap-[10px]">
      <div className="flex flex-wrap items-center gap-[8px]">
        <Select
          aria-label="Review"
          value={String(current.id)}
          options={published.map((r) => ({
            value: String(r.id),
            label: `${formatDay(r.started_at_ms)} · ${formatWindow(r.window)}`
          }))}
          onChange={(v) => setSelected(Number(v))}
        />
        <button type="button" className={SECONDARY_BUTTON} onClick={() => onOpenFile(`${dir}/report.md`)}>
          Open report.md
        </button>
        <button type="button" className={SECONDARY_BUTTON} onClick={() => onOpenFile(`${dir}/findings.json`)}>
          Open findings.json
        </button>
        <button type="button" className={SECONDARY_BUTTON} onClick={() => onReveal(`${dir}/report.md`)}>
          Show in folder
        </button>
      </div>
      {shown?.truncated && (
        <NavFeedback tone="warning">
          This report is longer than Houston shows here; open report.md to read all of it.
        </NavFeedback>
      )}
      {shown ? (
        <div
          data-testid="harness-report"
          className="rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--card-bg)] p-[var(--space-5)]"
        >
          <MarkdownPreview source={shown.markdown} variant="chat" />
        </div>
      ) : reportError?.reviewId === current.id ? (
        <NavDetailState
          title="Could not load the report"
          detail={reportError.message}
          tone="error"
          action={
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => onLoadReport(current.id)}
            >
              Retry
            </button>
          }
        />
      ) : (
        <NavDetailState title="Loading the report" detail={`Reading ${dir}/report.md`} />
      )}
    </div>
  )
}
