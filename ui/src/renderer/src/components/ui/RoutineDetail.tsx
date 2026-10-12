import { Card, Chip, Button, Notice, SectionHead, Segmented, Select, StatusLabel, Table, type TableColumn } from './index'
import { ActionMenu } from './ActionMenu'
import { IconPlay } from '../icons'
import { Toggle } from './settingsPrimitives'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { Routine, RoutineRun } from '../../houston/routineTypes'
import type { RoutineEngineRefusal } from '../../houston/generated/RoutineEngineRefusal'
import { routineEngineOptions } from '../nav/routineEngines'
import { formatCadence, formatRunTime } from '../nav/routineFormat'

type ScheduleChoice = 'manual' | 'daily' | 'weekly'

interface RunRow {
  id: string
  started: string
  result: React.ReactNode
  took: string
  sessionId: number | null
}

function scheduleChoice(routine: Routine): ScheduleChoice {
  if (routine.cadence.type === 'interval') return 'manual'
  return routine.cadence.weekdays == null ? 'daily' : 'weekly'
}

function cadenceFor(choice: Exclude<ScheduleChoice, 'manual'>, routine: Routine): Routine['cadence'] {
  const clock = routine.cadence.type === 'clock' ? routine.cadence : { type: 'clock' as const, hour: 9, minute: 0, weekdays: null }
  return choice === 'daily'
    ? { ...clock, weekdays: null }
    : { ...clock, weekdays: clock.weekdays?.length ? clock.weekdays : [2] }
}

function runResult(run: RoutineRun): React.JSX.Element {
  const state = run.status === 'running'
    ? 'Running'
    : run.status === 'ok'
      ? 'Done'
      : 'Failed'
  return <StatusLabel status={state} size="small" />
}

function runRows(runs: RoutineRun[] | undefined, now: number): RunRow[] {
  return (runs ?? []).map((run) => ({
    id: String(run.id),
    started: formatRunTime(run.started_at_ms, now),
    result: runResult(run),
    took: run.ended_at_ms == null ? '—' : `${Math.max(1, Math.round((run.ended_at_ms - run.started_at_ms) / 60_000))}m`,
    sessionId: run.session_id ?? null
  }))
}

export function RoutineDetail({
  routine,
  engineRefusals = [],
  runs,
  runsLoading,
  now,
  running,
  pending,
  atLimit,
  onRunNow,
  onToggleEnabled,
  onEdit,
  onDelete,
  onUpdateSchedule,
  onUpdateEngine,
  onOpenSession,
  heading,
  subheading = false,
  description,
  scheduleControl,
  history,
  settings,
  activity
}: {
  routine: Routine
  heading?: string
  /** Renders the title as a sub-heading of a page that already carries the main heading. */
  subheading?: boolean
  description?: React.ReactNode
  scheduleControl?: React.ReactElement
  history?: React.ReactNode
  settings?: React.ReactNode
  activity?: React.ReactNode
  engineRefusals?: readonly RoutineEngineRefusal[]
  runs?: RoutineRun[]
  runsLoading: boolean
  now: number
  running: boolean
  pending: boolean
  atLimit: { running: number; limit: number } | null
  onRunNow: () => void
  onToggleEnabled: () => void
  onEdit: () => void
  onDelete: () => void
  onUpdateSchedule: (cadence: Routine['cadence']) => void
  onUpdateEngine: (engine: AgentKind) => void
  onOpenSession: (sessionId: number) => void
}): React.JSX.Element {
  const displayName = heading ?? routine.name
  const rows = runRows(runs, now)
  const columns: TableColumn<RunRow>[] = [
    { key: 'started', header: 'Started', weight: 'regular' },
    { key: 'result', header: 'Result', render: (result) => result },
    { key: 'took', header: 'Took', numeric: true, weight: 'regular' }
  ]

  return (
    <div className="grid min-w-0 gap-[var(--space-3)]" data-testid="routine-detail">
      <RoutineDetailHeader routine={routine} displayName={displayName} subheading={subheading} description={description} running={running} pending={pending} onRunNow={onRunNow} onEdit={onEdit} onDelete={onDelete} />
      {activity}
      {atLimit && <Notice tone="warn" className="w-full"><span data-testid="routine-limit-notice">{atLimit.running} of {atLimit.limit} running. Routines run {atLimit.limit} at a time (Settings › Routines).</span></Notice>}
      {settings ?? <RoutineSettings routine={routine} engineRefusals={engineRefusals} scheduleControl={scheduleControl}
        onUpdateSchedule={onUpdateSchedule} onUpdateEngine={onUpdateEngine} onToggleEnabled={onToggleEnabled} displayName={displayName} />}
      {history ?? <>
        <SectionHead title="Runs" count={runs?.length ?? 0} />
        {runsLoading ? <p role="status" className="m-0 text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">Loading runs…</p> : (
          <Table
            aria-label="Routine runs"
            variant="framed"
            density="compact"
            rows={rows}
            getRowId={(row) => row.id}
            columns={columns}
            rowAction={(row) => row.sessionId == null ? null : <Button variant="ghost" size="sm" data-testid="routine-run-open" onClick={() => onOpenSession(row.sessionId!)}>Open pane</Button>}
            empty={{ heading: 'No runs yet', description: 'Run this routine to see its history here.' }}
          />
        )}
      </>}
      <span className="sr-only">Current schedule: {formatCadence(routine.cadence)}.</span>
    </div>
  )
}

function RoutineDetailHeader({ routine, displayName, subheading, description, running, pending, onRunNow, onEdit, onDelete }: {
  routine: Routine
  displayName: string
  subheading: boolean
  description?: React.ReactNode
  running: boolean
  pending: boolean
  onRunNow: () => void
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  return <header data-testid="routine-detail-header" className="flex min-w-0 items-start gap-[var(--space-3)]">
    <div className="grid min-w-0 flex-1 gap-[var(--space-1)]">
      <div className="flex min-w-0 items-center gap-[var(--space-1-5)]">
        {subheading
          ? <h3 className="m-0 min-w-0 truncate text-[length:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)]">{displayName}</h3>
          : <h2 className="m-0 min-w-0 truncate text-[length:var(--tr-text-subhead-size)] font-[var(--tr-text-subhead-weight)] tracking-[var(--tr-text-subhead-tracking)] text-[var(--text-primary)]">{displayName}</h2>}
        {routine.kind === 'harness_review' && !subheading && <Chip variant="label" label="Built in" />}
      </div>
      {description}
    </div>
    <Button variant="secondary" icon={IconPlay} data-testid="routine-run-now" disabled={running || pending} onClick={onRunNow} className="flex-none">{pending ? 'Starting…' : 'Run now'}</Button>
    <ActionMenu label="Routine actions" iconOnly items={[{ label: 'Edit', onSelect: onEdit }, { label: 'Delete', onSelect: onDelete, tone: 'danger' }]} />
  </header>
}

function RoutineSettings({ routine, displayName, engineRefusals, scheduleControl, onUpdateSchedule, onUpdateEngine, onToggleEnabled }: {
  routine: Routine
  displayName: string
  engineRefusals: readonly RoutineEngineRefusal[]
  scheduleControl?: React.ReactElement
  onUpdateSchedule: (cadence: Routine['cadence']) => void
  onUpdateEngine: (engine: AgentKind) => void
  onToggleEnabled: () => void
}): React.JSX.Element {
  return <Card layout="fields" shape="card" role="group" aria-label="Routine settings">
    <Card.Field label="Schedule">{scheduleControl ?? <Segmented aria-label="Schedule" value={scheduleChoice(routine)} onChange={(value) => { if (value !== 'manual') onUpdateSchedule(cadenceFor(value, routine)) }} options={[{ value: 'manual', label: 'Manual', disabled: true }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]} />}</Card.Field>
    <Card.Field label="Runs on"><Select aria-label="Runs on" data-testid="routine-detail-engine" value={routine.engine} options={routineEngineOptions(engineRefusals, routine.permission_mode, "Change the routine's access with Edit first.")} onChange={(value) => onUpdateEngine(value as AgentKind)} width="full" /></Card.Field>
    <Card.Field label="Enabled"><Toggle on={routine.enabled} onChange={onToggleEnabled} data-testid="routine-enabled" aria-label={`Enable ${displayName}`} /></Card.Field>
  </Card>
}
