import { useState, type ComponentProps } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { RoutineWorkspaceOption } from '../../houston/routineTypes'
import { useHarness, type HarnessState, type HarnessReport, type HarnessReportError } from '../../houston/useHarness'
import { setRailView } from '../../railView'
import { setSettingsOpen, setSettingsSection } from '../../settingsNav'
import { MarkdownPreview } from '../MarkdownPreview'
import { Button, Card, Chip, Drawer, Field, Notice, SectionHead, Select, Text } from '../ui'
import { RoutineDetail } from '../ui/RoutineDetail'
import { HarnessReviewConsent, HarnessSetupFields, type HarnessSetupValue } from './HarnessSurface'
import { formatHarnessDate, scheduleFields, scheduleLabel, scheduleOf, SCHEDULE_OPTIONS, type HarnessSchedule } from './harnessFormat'

export function WeeklyReviewSetup({ client, workspace, onCancel, onCreate }: {
  client: HoustonClient | null
  workspace: RoutineWorkspaceOption
  onCancel: () => void
  onCreate: (setup: HarnessSetupValue) => void
}): React.JSX.Element {
  const { state } = useHarness(client, workspace.id)
  return <div className="grid gap-[var(--space-3)]">
    {state ? <Card padding="md"><HarnessSetupFields models={state.models} engineRefusals={state.engineRefusals} onSubmit={onCreate} submitLabel="Create routine" /></Card> : <Text role="status" tone="muted">Loading review setup…</Text>}
    <HarnessReviewConsent />
    <Button variant="ghost" className="justify-self-start" onClick={onCancel}>Cancel</Button>
  </div>
}

export function WeeklyReviewDetail({ client = null, workspaceName, onUpdateReviewSchedule, ...props }: ComponentProps<typeof RoutineDetail> & {
  client?: HoustonClient | null
  workspaceName?: string | null
  onUpdateReviewSchedule?: (fields: ReturnType<typeof scheduleFields>) => void
}): React.JSX.Element {
  const { routine, now, onOpenSession } = props
  const workspace = routine.workspace_id ?? null
  const { state, report, reportError, loadReport } = useHarness(client, workspace)
  const [reportId, setReportId] = useState<number | null>(null)
  const schedule = scheduleOf(routine)
  const options = schedule === 'custom' ? [...SCHEDULE_OPTIONS, { value: 'custom' as const, label: scheduleLabel(routine) }] : SCHEDULE_OPTIONS
  const currentReview = state?.reviews.find((review) => review.status === 'running')
  return <>
    <RoutineDetail {...props} heading="Weekly review"
      description={<div className="grid gap-[var(--space-3)]">
        <Text as="p" size="small" tone="secondary" flush>Reads recent session summaries and looks for mistakes your agents repeat. Findings arrive in <Button variant="link" size="sm" onClick={() => setRailView('tasks')}>Tasks › Suggested</Button>; the report and trend live in <Button variant="link" size="sm" onClick={() => { setSettingsSection('agents-review'); setSettingsOpen(true) }}>Settings › Agents › Review</Button>.</Text>
        <Field label="Reads"><Text>Sessions in {workspaceName ?? workspace ?? 'an unavailable workspace'} since the previous review.</Text></Field>
        {currentReview && <Notice tone="info" action={currentReview.session_id == null ? undefined : { label: 'Open pane', onClick: () => onOpenSession(currentReview.session_id!) }}>Review running in {workspaceName ?? workspace}; started {formatHarnessDate(currentReview.started_at_ms, true, now)}.</Notice>}
      </div>}
      scheduleControl={<div className="grid gap-[var(--space-1)]"><Select aria-label="Review schedule" value={schedule} options={options} onChange={(value) => { if (value !== 'custom') onUpdateReviewSchedule?.(scheduleFields(value as Exclude<HarnessSchedule, 'custom'>, routine.cadence)) }} /><Text size="small" tone="muted">{scheduleLabel(routine)}</Text></div>}
      history={<WeeklyReviewRuns workspace={workspace} connected={!!client} state={state} now={now}
        onOpenReport={(id) => { setReportId(id); loadReport(id) }} />}
    />
    <WeeklyReviewReport reportId={reportId} report={report} error={reportError} onClose={() => setReportId(null)} onRetry={loadReport} />
  </>
}

function WeeklyReviewRuns({ workspace, connected, state, now, onOpenReport }: {
  workspace: string | null
  connected: boolean
  state: HarnessState | null
  now: number
  onOpenReport: (id: number) => void
}): React.JSX.Element {
  return (
    <section className="grid gap-[var(--space-2)]" aria-label="Recent runs">
      <SectionHead title="Recent runs" count={state?.reviews.length} />
      {!connected || !workspace ? <Text tone="muted">Connect to the daemon with a workspace to read review history.</Text> : !state ? <Text role="status" tone="muted">Loading reviews…</Text> : !state.reviews.length ? <Text tone="muted">No reviews yet.</Text> : <Card>
        {state.reviews.map((review) => <Card.Row key={review.id} heading={`${formatHarnessDate(review.started_at_ms, false, now)} · ${review.sessions == null ? 'sessions not reported' : `${review.sessions} sessions`}`}
          meta={review.error ?? review.summary ?? (review.status === 'running' ? 'Reading sessions' : `${review.finding_count} findings`)}
          status={<Chip variant="state" label={review.status === 'published' ? 'Published' : review.status === 'running' ? 'Running' : 'Failed'} tone={review.status === 'failed' ? 'danger' : review.status === 'running' ? 'info' : 'success'} />}
          action={review.status === 'published' ? <Button variant="link" size="sm" data-testid={`review-open-report-${review.id}`} onClick={() => onOpenReport(review.id)}>Open report</Button> : null} />)}
      </Card>}
    </section>
  )
}

function WeeklyReviewReport({ reportId, report, error, onClose, onRetry }: {
  reportId: number | null
  report: HarnessReport | null
  error: HarnessReportError | null
  onClose: () => void
  onRetry: (id: number) => void
}): React.JSX.Element {
  const shownReport = report?.reviewId === reportId ? report : null
  return (
    <Drawer open={reportId !== null} heading="Weekly review report" onClose={onClose}>
      {shownReport ? <>{shownReport.truncated && <Notice tone="warn">This report is truncated. The complete report is in the workspace’s review directory.</Notice>}<MarkdownPreview source={shownReport.markdown} variant="chat" /></> : error?.reviewId === reportId ? <Notice tone="danger" action={{ label: 'Retry', onClick: () => { if (reportId !== null) onRetry(reportId) } }}>{error.message}</Notice> : <Text role="status" tone="muted">Loading report…</Text>}
    </Drawer>
  )
}
