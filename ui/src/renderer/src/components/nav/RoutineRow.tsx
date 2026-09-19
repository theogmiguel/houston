import { IconChevronDown, IconExternal, IconPencil, IconPlay, IconTrash } from '../icons'
import { lastRunLabel, nextRunLabel, formatCadence, formatRunTime } from './routineFormat'
import {
  CHROME_BUTTON,
  CHROME_BUTTON_DANGER,
  NavSwitch,
  ROW_STACK,
  ROW_ACTIONS,
  ROW_DETAIL,
  ROW_FOOTER,
  ROW_TITLE
} from './navChrome'
import type { Routine, RoutineRun, RoutineWorkspaceOption } from '../../houston/routineTypes'
import type { RoutineOutcome } from '../../houston/generated/RoutineOutcome'
import type { RoutineRunStatus } from '../../houston/generated/RoutineRunStatus'
import { Icon } from '../Icon'
import { Tooltip } from '../Tooltip'

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

const CHIP_CLS =
  'inline-flex flex-none items-center h-[18px] px-[7px] rounded-[var(--tr-radius-pill)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]'

function chipStyle(tone: string): React.CSSProperties {
  return { color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }
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
    <span
      data-testid={testId}
      data-status={status}
      className={CHIP_CLS}
      style={chipStyle(tone)}
    >
      {label}
    </span>
  )
}

function OutcomeChip({ outcome }: { outcome: RoutineOutcome }): React.JSX.Element {
  const { label, tone } = OUTCOME_CHIP[outcome]
  return (
    <span
      data-testid="routine-outcome"
      data-outcome={outcome}
      className={CHIP_CLS}
      style={chipStyle(tone)}
    >
      {label}
    </span>
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
      <div
        data-testid="routine-history"
        className="flex flex-col gap-[6px] pt-[8px] [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]"
      >
        Loading runs…
      </div>
    )
  }
  if (!runs || runs.length === 0) {
    return (
      <div
        data-testid="routine-history"
        className="flex flex-col gap-[6px] pt-[8px] [font-size:var(--tr-text-small-size)] text-[var(--text-faint)]"
      >
        No runs yet.
      </div>
    )
  }
  return (
    <div data-testid="routine-history" className="flex flex-col gap-[6px] pt-[8px]">
      {runs.map((run) => (
        <div
          key={run.id}
          data-testid="routine-run-row"
          className="flex items-center gap-[8px] min-w-0"
        >
          <StatusChip status={run.status} testId="routine-run-status" />
          <span className="flex-none [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">
            {run.trigger === 'manual' ? 'Run now' : 'Scheduled'}
          </span>
          <span className="flex-none tabular-nums [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">
            {formatRunTime(run.started_at_ms, now)}
          </span>
          {run.error && (
            <Tooltip label={run.error}>
              <span
                data-testid="routine-run-error"
                className="flex-1 min-w-0 truncate [font-size:var(--tr-text-small-size)] text-[var(--warning)]"
              >
                {run.error}
              </span>
            </Tooltip>
          )}
          <span className="flex-1" />
          {run.session_id != null && onOpenSession && (
            <button
              type="button"
              data-testid="routine-run-open"
              aria-label="Open this run's pane"
              className={CHROME_BUTTON}
              onClick={() => onOpenSession(run.session_id!)}
            >
              <Icon glyph={IconExternal} role="small" />
            </button>
          )}
        </div>
      ))}
    </div>
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
  if (running) return <span className="truncate text-[var(--info)]">Running</span>
  if (waitingForSlot) {
    return (
      <span className="truncate text-[var(--text-muted)]">
        waiting for a slot (
        <span className="tabular-nums">
          {waitingForSlot.running} of {waitingForSlot.limit}
        </span>{' '}
        running)
      </span>
    )
  }
  if (lastError != null) {
    return (
      <Tooltip label={lastError}>
        <span className="truncate text-[var(--warning)]">{lastError}</span>
      </Tooltip>
    )
  }
  if (!enabled) return <span>Paused</span>
  const next = <span className="tabular-nums">{nextRunLabel(nextRunAtMs, now)}</span>
  if (lastRunAtMs == null) return <span className="truncate">{next}</span>
  return (
    <span className="truncate">
      {next} &middot; last run{' '}
      <span className="tabular-nums">{lastRunLabel(lastRunAtMs, now)}</span>
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
    <div
      data-testid="routine-row"
      data-state={routineState(running, failing, routine.enabled)}
      className={ROW_STACK}
    >
      <div className="flex items-center gap-[8px] min-w-0">
        <Tooltip label={routine.name}>
          <strong className={ROW_TITLE}>{routine.name}</strong>
        </Tooltip>
        <RoutineHeadChip running={running} outcome={routine.last_outcome} />
        <span className="flex-1" />
        <NavSwitch
          on={routine.enabled}
          label={routine.enabled ? `Pause ${routine.name}` : `Resume ${routine.name}`}
          onChange={onToggleEnabled}
          testId="routine-switch"
        />
      </div>
      <Tooltip label={formatCadence(routine.cadence)}>
        <div className={`${ROW_DETAIL} mt-[4px]`}>{routineDetail(routine, workspace)}</div>
      </Tooltip>
      <div className={ROW_FOOTER}>
        <RoutineStatusLine
          running={running}
          waitingForSlot={props.waitingForSlot}
          lastError={routine.last_error}
          enabled={routine.enabled}
          lastRunAtMs={routine.last_run_at_ms}
          nextRunAtMs={routine.next_run_at_ms}
          now={now}
        />
        <div className={ROW_ACTIONS}>
          {lastSessionId != null && props.onOpenSession && (
            <Tooltip label="Open the last run's pane">
              <button
                type="button"
                data-testid="routine-open-session"
                aria-label={`Open ${routine.name}'s last run pane`}
                className={CHROME_BUTTON}
                onClick={() => props.onOpenSession?.(lastSessionId)}
              >
                <Icon glyph={IconExternal} role="small" />
              </button>
            </Tooltip>
          )}
          {props.onToggleHistory && (
            <Tooltip label="Run history, newest first">
              <button
                type="button"
                data-testid="routine-history-toggle"
                aria-expanded={historyOpen}
                aria-label={`${routine.name} run history`}
                className={CHROME_BUTTON}
                onClick={props.onToggleHistory}
              >
                <Icon glyph={IconChevronDown} role="small" />
              </button>
            </Tooltip>
          )}
          {props.onRunNow && (
            <Tooltip label="Run this routine now, on its own cadence's path">
              <button
                type="button"
                data-testid="routine-run-now"
                aria-label={`Run ${routine.name} now`}
                className={CHROME_BUTTON}
                onClick={props.onRunNow}
              >
                <Icon glyph={IconPlay} role="small" />
              </button>
            </Tooltip>
          )}
          <Tooltip label="Edit this routine">
            <button
              type="button"
              data-testid="routine-edit"
              aria-label={`Edit ${routine.name}`}
              className={CHROME_BUTTON}
              onClick={onEdit}
            >
              <Icon glyph={IconPencil} role="small" />
            </button>
          </Tooltip>
          <Tooltip label="Delete this routine">
            <button
              type="button"
              data-testid="routine-delete"
              aria-label={`Delete ${routine.name}`}
              className={CHROME_BUTTON_DANGER}
              onClick={onDelete}
            >
              <Icon glyph={IconTrash} role="small" />
            </button>
          </Tooltip>
        </div>
      </div>
      {historyOpen && (
        <RoutineHistory
          runs={props.runs}
          loading={runsLoading}
          now={now}
          onOpenSession={props.onOpenSession}
        />
      )}
    </div>
  )
}
