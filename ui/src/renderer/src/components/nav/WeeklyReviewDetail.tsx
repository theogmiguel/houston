import { useState, type ComponentProps } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { RoutineWorkspaceOption } from '../../houston/routineTypes'
import { useHarness, type HarnessState, type HarnessReport, type HarnessReportError } from '../../houston/useHarness'
import { setRailView } from '../../railView'
import { setSettingsOpen, setSettingsSection } from '../../settingsNav'
import { MarkdownPreview } from '../MarkdownPreview'
import { Button, Card, Drawer, Notice, SectionHead, Segmented, StatusLabel, Text } from '../ui'
import type { HarnessReview } from '../../houston/generated/HarnessReview'
import type { Routine } from '../../houston/routineTypes'
import { TaskAgentIcon } from '../ui/TaskSurface'
import { engineLabel } from '../engineLabel'
import { formatAgo } from '../tasks/format'
import { formatRunTime, nextUpTimeLabel } from './routineFormat'
import { Toggle } from '../ui/settingsPrimitives'
import { RoutineDetail } from '../ui/RoutineDetail'
import { HarnessReviewConsent, HarnessSetupFields, type HarnessSetupValue } from './HarnessSurface'
import { scheduleFields, scheduleLabel, scheduleOf, type HarnessSchedule } from './harnessFormat'

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

export function WeeklyReviewDetail({ client = null, workspaceName, onUpdateReviewSchedule, grouped = false, ...props }: ComponentProps<typeof RoutineDetail> & {
  grouped?: boolean
  client?: HoustonClient | null
  workspaceName?: string | null
  onUpdateReviewSchedule?: (fields: ReturnType<typeof scheduleFields>) => void
}): React.JSX.Element {
  const { routine, now, onOpenSession } = props
  const workspace = routine.workspace_id ?? null
  const { state, report, reportError, loadReport } = useHarness(client, workspace)
  const [reportId, setReportId] = useState<number | null>(null)
  const workspaceLabel = workspaceName ?? workspace ?? 'an unavailable workspace'
  const currentReview = state?.reviews.find((review) => review.status === 'running')
  return <>
    <RoutineDetail {...props} heading={grouped ? workspaceLabel : 'Weekly review'}
      description={grouped ? <div className="grid gap-[var(--space-1)]">
        <Text size="small" tone="muted">Next run: {routine.enabled ? nextUpTimeLabel(routine.next_run_at_ms, now) : 'Paused'}</Text>
        <Text size="small" tone="muted">Last run: {routine.last_run_at_ms == null ? 'Never' : formatRunTime(routine.last_run_at_ms, now)}</Text>
      </div> : <ReviewDescription />}
      activity={currentReview && <ReviewRunningBanner review={currentReview} workspaceName={workspaceLabel} now={now} onOpenSession={onOpenSession} />}
      settings={<ReviewSettings routine={routine} workspaceName={workspaceLabel} onEdit={props.onEdit} onToggleEnabled={props.onToggleEnabled} onUpdateSchedule={onUpdateReviewSchedule} />}
      history={<WeeklyReviewRuns workspace={workspace} connected={!!client} state={state}
        onOpenReport={(id) => { setReportId(id); loadReport(id) }} />}
    />
    <WeeklyReviewReport reportId={reportId} report={report} error={reportError} onClose={() => setReportId(null)} onRetry={loadReport} />
  </>
}

function WeeklyReviewRuns({ workspace, connected, state, onOpenReport }: {
  workspace: string | null
  connected: boolean
  state: HarnessState | null
  onOpenReport: (id: number) => void
}): React.JSX.Element {
  return (
    <section className="grid gap-[var(--space-2)]" aria-label="Recent runs">
      <SectionHead title="Recent runs" variant="sentence" tone="muted" />
      {!connected || !workspace ? <Text tone="muted">Connect to the daemon with a workspace to read review history.</Text> : !state ? <Text role="status" tone="muted">Loading reviews…</Text> : !state.reviews.length ? <Text tone="muted">No reviews yet.</Text> : <Card>
        {state.reviews.map((review) => <Card.Row key={review.id} heading={`${reviewRunDate(review.started_at_ms)} · ${review.sessions == null ? 'sessions not reported' : `${review.sessions} sessions`}`}
          meta={reviewRunMeta(review)}
          status={review.status === 'running' ? <StatusLabel status="Running" size="small" /> : review.status === 'failed' ? <StatusLabel status="Failed" size="small" /> : null}
          action={review.status === 'published' ? <Button variant="muted-link" size="sm" data-testid={`review-open-report-${review.id}`} onClick={() => onOpenReport(review.id)}>Open report</Button> : null} />)}
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

export function ReviewDescription(): React.JSX.Element {
  return <Text as="p" size="small" tone="secondary" flush>Reads recent session summaries and looks for mistakes your agents repeat. Findings arrive in <Button variant="muted-link" size="sm" onClick={() => setRailView('tasks')}>Tasks › Suggested</Button>; the report and trend live in <Button variant="muted-link" size="sm" onClick={() => { setSettingsSection('agents-review'); setSettingsOpen(true) }}>Settings › Agents › Review</Button>.</Text>
}

function ReviewSettings({ routine, workspaceName, onEdit, onToggleEnabled, onUpdateSchedule }: {
  routine: Routine
  workspaceName: string
  onEdit: () => void
  onToggleEnabled: () => void
  onUpdateSchedule?: (fields: ReturnType<typeof scheduleFields>) => void
}): React.JSX.Element {
  const schedule = scheduleOf(routine)
  const options: { value: HarnessSchedule; label: string; disabled?: boolean }[] = [
    { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'off', label: 'Only when I run it' }
  ]
  if (schedule === 'custom') options.push({ value: 'custom', label: 'Custom', disabled: true })
  return <Card layout="fields" shape="card" role="group" aria-label="Routine settings">
    <Card.Field label="Schedule">
      <Segmented aria-label="Review schedule" size="xs" value={schedule} options={options} onChange={(value) => { if (value !== 'custom') onUpdateSchedule?.(scheduleFields(value, routine.cadence)) }} />
      <Text size="small" tone="muted">{reviewScheduleDescription(routine)}</Text>
    </Card.Field>
    <Card.Field label="Reads"><Text>Sessions in {workspaceName} since the previous review.</Text></Card.Field>
    <Card.Field label="Runs with"><TaskAgentIcon agent={routine.engine} /><Text>{engineLabel(routine.engine)}</Text>{routine.model && <><Text tone="muted">·</Text><Text size="small" mono tone="muted">{routine.model}</Text></>}<Button variant="muted-link" aria-label="Change review provider and model" onClick={onEdit}>Change</Button></Card.Field>
    <Card.Field label="Enabled"><Toggle on={routine.enabled} onChange={onToggleEnabled} data-testid="routine-enabled" aria-label="Weekly review enabled" /></Card.Field>
  </Card>
}

function ReviewRunningBanner({ review, workspaceName, now, onOpenSession }: {
  review: HarnessReview
  workspaceName: string
  now: number
  onOpenSession: (id: number) => void
}): React.JSX.Element {
  const count = review.sessions == null ? '' : `${review.sessions} `
  const started = formatAgo(review.started_at_ms, now).replace('m ago', ' min ago')
  return <Notice tone="info" variant="routine" action={review.session_id == null ? undefined : { label: 'Open pane', onClick: () => onOpenSession(review.session_id!) }}>Reading {count}sessions in {workspaceName} · started {started} in a background pane</Notice>
}

function reviewScheduleDescription(routine: Routine): string {
  switch (scheduleOf(routine)) {
    case 'weekly': return 'Mondays at 09:00'
    case 'daily': return 'Daily at 09:00'
    case 'off': return 'Scheduled runs are off'
    case 'custom': return scheduleLabel(routine)
  }
}

function reviewRunDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '')
}

function reviewRunMeta(review: HarnessReview): string {
  if (review.status === 'running') return 'Reading sessions'
  if (review.status === 'failed') return review.error ?? 'Review failed'
  return `${review.finding_count} findings${review.summary ? ` · ${review.summary}` : ''}`
}
