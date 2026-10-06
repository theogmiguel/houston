import { IconChevronDown, IconExternal, IconPencil, IconPlay, IconTrash } from '../icons'
import { lastRunLabel, nextRunLabel, formatCadence, formatRunTime } from './routineFormat'
import type { Routine, RoutineRun, RoutineWorkspaceOption } from '../../houston/routineTypes'
import type { RoutineOutcome } from '../../houston/generated/RoutineOutcome'
import type { RoutineRunStatus } from '../../houston/generated/RoutineRunStatus'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { IconAction, FieldSwitch } from '../ui/navPrimitives'
import { Text } from '../ui/Text'
import { StatusChip as ToneStatusChip } from '../ui/navText'
import { ListRow, ListRowActions, ListRowDetail, ListRowFooter, ListRowTitle, RunHistory } from '../ui/navRow'

const OUTCOME_CHIP: Record<RoutineOutcome, { label: string; tone: string }> = {
  ok: { label: 'Ok', tone: 'var(--ok)' },
  denied: { label: 'Denied', tone: 'var(--warn)' },
  killed_at_cap: { label: 'Stopped at its ceiling', tone: 'var(--warn)' },
  engine_refused: { label: 'Could not start', tone: 'var(--text-muted)' },
  failed: { label: 'Failed', tone: 'var(--stop)' }
}

const RUN_STATUS: Record<RoutineRunStatus, { label: string; tone: string }> = {
  running: { label: 'Running', tone: 'var(--info)' },
  ok: OUTCOME_CHIP.ok,
  denied: OUTCOME_CHIP.denied,
  killed_at_cap: OUTCOME_CHIP.killed_at_cap,
  engine_refused: OUTCOME_CHIP.engine_refused,
  failed: OUTCOME_CHIP.failed
}

function StatusChip({
  status,
  testId
}: {
  status: RoutineRunStatus
  testId: string
}): React.JSX.Element {
  const { label, tone } = RUN_STATUS[status]
  return (
    <ToneStatusChip data-testid={testId} data-status={status} tone={tone}>
      {label}
    </ToneStatusChip>
  )
}

function OutcomeChip({ outcome }: { outcome: RoutineOutcome }): React.JSX.Element {
  const { label, tone } = OUTCOME_CHIP[outcome]
  return (
    <ToneStatusChip data-testid="routine-outcome" data-outcome={outcome} tone={tone}>
      {label}
    </ToneStatusChip>
  )
}

/// Newest first: the routine's independent run records, with the pane each one
/// opened when it still exists.
export function RoutineHistory({
  runs,
  loading,
  now,
  onOpenSession
}: {
  runs: RoutineRun[] | undefined
  loading: boolean
  now: number
  onOpenSession?: (sessionId: number) => void
}): React.JSX.Element {
  if (loading) {
    return (
      <RunHistory state="loading" data-testid="routine-history">
        Loading runs…
      </RunHistory>
    )
  }
  if (!runs || runs.length === 0) {
    return (
      <RunHistory state="empty" data-testid="routine-history">
        No runs yet.
      </RunHistory>
    )
  }
  return (
    <RunHistory state="list" data-testid="routine-history">
      {runs.map((run) => (
        <div
          key={run.id}
          data-testid="routine-run-row"
          className="flex items-center gap-[var(--space-2)] min-w-0"
        >
          <StatusChip status={run.status} testId="routine-run-status" />
          <Text size="small" tone="muted" className="flex-none">
            {run.trigger === 'manual' ? 'Run now' : 'Scheduled'}
          </Text>
          <Text size="small" tone="muted" tabular className="flex-none">
            {formatRunTime(run.started_at_ms, now)}
          </Text>
          {run.error && (
            <Tooltip label={run.error}>
              <Text data-testid="routine-run-error" size="small" tone="warning" className="flex-1 min-w-0 truncate">
                {run.error}
              </Text>
            </Tooltip>
          )}
          <span className="flex-1" />
          {run.session_id != null && onOpenSession && (
            <IconAction
              data-testid="routine-run-open"
              aria-label="Open this run's pane"
              onClick={() => onOpenSession(run.session_id!)}
            >
              <Icon glyph={IconExternal} role="small" />
            </IconAction>
          )}
        </div>
      ))}
    </RunHistory>
  )
}

function RoutineHeadChip({
  running,
  outcome
}: {
  running: boolean
  outcome: RoutineOutcome | null | undefined
}): React.JSX.Element | null {
  if (running) return <StatusChip status="running" testId="routine-outcome" />
  return outcome != null ? <OutcomeChip outcome={outcome} /> : null
}

function RoutineStatusLine({
  running,
  waitingForSlot,
  lastError,
  enabled,
  lastRunAtMs,
  nextRunAtMs,
  now
}: {
  running: boolean
  waitingForSlot: { running: number; limit: number } | undefined
  lastError: string | null | undefined
  enabled: boolean
  lastRunAtMs: number | null | undefined
  nextRunAtMs: number
  now: number
}): React.JSX.Element {
  if (running) return <Text  tone="info" className="truncate">Running</Text>
  if (waitingForSlot) {
    return (
      <Text  tone="muted" className="truncate">
        waiting for a slot (
        <Text  tabular>
          {waitingForSlot.running} of {waitingForSlot.limit}
        </Text>{' '}
        running)
      </Text>
    )
  }
  if (lastError != null) {
    return (
      <Tooltip label={lastError}>
        <Text  tone="warning" className="truncate">{lastError}</Text>
      </Tooltip>
    )
  }
  if (!enabled) return <span>Paused</span>
  const next = <Text  tabular>{nextRunLabel(nextRunAtMs, now)}</Text>
  if (lastRunAtMs == null) return <span className="truncate">{next}</span>
  return (
    <span className="truncate">
      {next} &middot; last run{' '}
      <Text  tabular>{lastRunLabel(lastRunAtMs, now)}</Text>
    </span>
  )
}

function routineDetail(routine: Routine, workspace: RoutineWorkspaceOption | undefined): string {
  const access =
    routine.permission_mode === 'bypass_permissions' ? 'full access' : 'accept edits'
  return [
    formatCadence(routine.cadence),
    workspace?.name,
    access,
    routine.isolate ? 'isolated' : null
  ]
    .filter(Boolean)
    .join(' · ')
}

function routineState(
  running: boolean,
  failing: boolean,
  enabled: boolean
): 'running' | 'failing' | 'scheduled' | 'paused' {
  if (running) return 'running'
  if (failing) return 'failing'
  return enabled ? 'scheduled' : 'paused'
}

export function RoutineRow(props: {
  routine: Routine
  workspace: RoutineWorkspaceOption | undefined
  now: number
  running?: boolean
  waitingForSlot?: { running: number; limit: number }
  historyOpen?: boolean
  runs?: RoutineRun[]
  runsLoading?: boolean
  onToggleHistory?: () => void
  onOpenSession?: (sessionId: number) => void
  onRunNow?: () => void
  onEdit: () => void
  onToggleEnabled: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { routine, workspace, now, onEdit, onToggleEnabled, onDelete } = props
  const running = props.running ?? false
  const historyOpen = props.historyOpen ?? false
  const runsLoading = props.runsLoading ?? false
  const failing = routine.last_error != null
  const lastSessionId = routine.last_run_session_id

  return (
    <ListRow data-testid="routine-row" data-state={routineState(running, failing, routine.enabled)}>
      <div className="flex items-center gap-[var(--space-2)] min-w-0">
        <Tooltip label={routine.name}>
          <ListRowTitle>{routine.name}</ListRowTitle>
        </Tooltip>
        <RoutineHeadChip running={running} outcome={routine.last_outcome} />
        <span className="flex-1" />
        <FieldSwitch
          on={routine.enabled}
          label={routine.enabled ? `Pause ${routine.name}` : `Resume ${routine.name}`}
          onChange={onToggleEnabled}
          testId="routine-switch"
        />
      </div>
      <Tooltip label={formatCadence(routine.cadence)}>
        <ListRowDetail>{routineDetail(routine, workspace)}</ListRowDetail>
      </Tooltip>
      <ListRowFooter>
        <RoutineStatusLine
          running={running}
          waitingForSlot={props.waitingForSlot}
          lastError={routine.last_error}
          enabled={routine.enabled}
          lastRunAtMs={routine.last_run_at_ms}
          nextRunAtMs={routine.next_run_at_ms}
          now={now}
        />
        <ListRowActions>
          {lastSessionId != null && props.onOpenSession && (
            <Tooltip label="Open the last run's pane">
              <IconAction
                data-testid="routine-open-session"
                aria-label={`Open ${routine.name}'s last run pane`}
                onClick={() => props.onOpenSession?.(lastSessionId)}
              >
                <Icon glyph={IconExternal} role="small" />
              </IconAction>
            </Tooltip>
          )}
          {props.onToggleHistory && (
            <Tooltip label="Run history, newest first">
              <IconAction
                data-testid="routine-history-toggle"
                aria-expanded={historyOpen}
                aria-label={`${routine.name} run history`}
                onClick={props.onToggleHistory}
              >
                <Icon glyph={IconChevronDown} role="small" />
              </IconAction>
            </Tooltip>
          )}
          {props.onRunNow && (
            <Tooltip label="Run this routine now, on its own cadence's path">
              <IconAction
                data-testid="routine-run-now"
                aria-label={`Run ${routine.name} now`}
                onClick={props.onRunNow}
              >
                <Icon glyph={IconPlay} role="small" />
              </IconAction>
            </Tooltip>
          )}
          <Tooltip label="Edit this routine">
            <IconAction
              data-testid="routine-edit"
              aria-label={`Edit ${routine.name}`}
              onClick={onEdit}
            >
              <Icon glyph={IconPencil} role="small" />
            </IconAction>
          </Tooltip>
          <Tooltip label="Delete this routine">
            <IconAction
              data-testid="routine-delete"
              aria-label={`Delete ${routine.name}`}
              danger
              onClick={onDelete}
            >
              <Icon glyph={IconTrash} role="small" />
            </IconAction>
          </Tooltip>
        </ListRowActions>
      </ListRowFooter>
      {historyOpen && (
        <RoutineHistory
          runs={props.runs}
          loading={runsLoading}
          now={now}
          onOpenSession={props.onOpenSession}
        />
      )}
    </ListRow>
  )
}
