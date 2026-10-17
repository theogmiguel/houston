import { useEffect, useState } from 'react'
import type { HarnessReview } from '../../houston/generated/HarnessReview'
import type { HarnessReport, HarnessReportError } from '../../houston/useHarness'
import { MarkdownPreview } from '../MarkdownPreview'
import { Select } from '../ui/Select'
import { ReportFrame, CenteredEmptyNote } from '../ui/navText'
import { SettingsToolbar } from '../ui/SettingsToolbar'
import { Button, Notice, Text } from '../ui'
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
    <div className="grid gap-[var(--space-3)]">
      <SettingsToolbar actions={<>
        <Button variant="secondary" onClick={() => onOpenFile(`${dir}/report.md`)}>Open report.md</Button>
        <Button variant="ghost" onClick={() => onOpenFile(`${dir}/findings.json`)}>Open findings.json</Button>
        <Button variant="ghost" onClick={() => onReveal(`${dir}/report.md`)}>Show in folder</Button>
      </>}>
        <Select
          aria-label="Review"
          value={String(current.id)}
          options={published.map((r) => ({
            value: String(r.id),
            label: `Review #${r.id} · ${formatDay(r.started_at_ms)} · ${formatWindow(r.window)}`
          }))}
          onChange={(v) => setSelected(Number(v))}
        />
      </SettingsToolbar>
      {shown?.truncated && (
        <Notice tone="warn">This report is longer than Houston shows here; open report.md to read all of it.</Notice>
      )}
      {shown ? (
        <ReportFrame data-testid="harness-report">
          <MarkdownPreview source={shown.markdown} variant="report" />
        </ReportFrame>
      ) : reportError?.reviewId === current.id ? (
        <Notice tone="danger" detail={reportError.message} action={{ label: 'Retry', onClick: () => onLoadReport(current.id) }}>
          Could not load the report.
        </Notice>
      ) : (
        <Text as="p" role="status" aria-busy="true" tone="muted" flush>Loading the report…</Text>
      )}
    </div>
  )
}
