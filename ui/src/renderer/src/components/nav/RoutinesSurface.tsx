import { useState } from 'react'
import { IconClock } from '../icons'
import { Group, SectionHead } from '../settingsPrimitives'
import { formatRoutineError, nextUpBucket } from './routineFormat'
import { NavColumn, NavEmpty, NavFeedback, PRIMARY_BUTTON } from './navChrome'
import { RoutineEditor, type RoutineFormValue } from './RoutineEditor'
import { RoutineRow } from './RoutineRow'
import type {
  Routine,
  RoutineDraft,
  RoutineMutation,
  RoutineRefusal,
  RoutineRun,
  RoutineWorkspaceOption
} from '../../houston/routineTypes'
import { Icon } from '../Icon'
import { MATERIAL_CLS, materialAttrs } from '../material'

export function sortRoutines(routines: Routine[]): Routine[] {
  return [...routines].sort((a, b) => {
    if (a.next_run_at_ms !== b.next_run_at_ms) return a.next_run_at_ms - b.next_run_at_ms
    return a.id - b.id
  })
}

type Panel = { mode: 'create' } | { mode: 'edit'; routine: Routine } | null

export function RoutinesSurface(props: {
  routines: Routine[]
  running: number[]
  runs: Record<number, RoutineRun[]>
  runsLoading: number | null
  workspaces: RoutineWorkspaceOption[]
  error: RoutineRefusal | null
  onDismissError: () => void
  onCreate: (draft: RoutineDraft) => void
  onUpdate: (mutation: RoutineMutation) => void
  onDelete: (id: number, expectedRevision: string) => void
  onRunNow: (id: number) => void
  onLoadRuns: (id: number) => void
  onOpenSession: (sessionId: number) => void
  onRequest: (request: { attemptedName?: string; routineName?: string }) => void
  now: number
}): React.JSX.Element {
  const {
    routines,
    running,
    runs,
    runsLoading,
    workspaces,
    error,
    onDismissError,
    onCreate,
    onUpdate,
    onDelete,
    onRunNow,
    onLoadRuns,
    onOpenSession,
    onRequest,
    now
  } = props
  const [panel, setPanel] = useState<Panel>(null)
  const [historyOpen, setHistoryOpen] = useState<number | null>(null)
  const workspaceById = new Map(workspaces.map((w) => [w.id, w]))
  const enabled = routines.filter((r) => r.enabled)
  const paused = sortRoutines(routines.filter((r) => !r.enabled))
  const today = sortRoutines(enabled.filter((r) => nextUpBucket(r.next_run_at_ms, now) === 'today'))
  const thisWeek = sortRoutines(enabled.filter((r) => nextUpBucket(r.next_run_at_ms, now) === 'week'))
  const later = sortRoutines(enabled.filter((r) => nextUpBucket(r.next_run_at_ms, now) === 'later'))

  function openEditor(r: Routine): void {
    onDismissError()
    setPanel({ mode: 'edit', routine: r })
  }

  function submit(value: RoutineFormValue): void {
    if (panel?.mode === 'edit') {
      onRequest({ attemptedName: value.name, routineName: panel.routine.name })
      onUpdate({
        id: panel.routine.id,
        expected_revision: panel.routine.revision,
        name: value.name,
        prompt: value.prompt,
        cadence: value.cadence,
        workspace_id: value.workspaceId,
        engine: value.engine,
        model: value.model,
        effort: value.effort,
        permission_mode: value.permissionMode,
        isolate: value.isolate
      })
    } else {
      onRequest({ attemptedName: value.name })
      onCreate({
        name: value.name,
        prompt: value.prompt,
        cadence: value.cadence,
        workspace_id: value.workspaceId,
        engine: value.engine,
        model: value.model,
        effort: value.effort,
        permission_mode: value.permissionMode,
        isolate: value.isolate
      })
    }
    setPanel(null)
  }

  if (panel) {
    return (
      <div
        data-testid="nav-surface"
        {...materialAttrs('base')}
        className={`flex-1 min-w-0 h-full min-h-0 flex flex-col overflow-hidden rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
      >
        <RoutineEditor
          mode={panel.mode}
          workspaces={workspaces}
          error={error ? formatRoutineError(error) : null}
          initial={
            panel.mode === 'edit'
              ? {
                  engine: panel.routine.engine,
                  model: panel.routine.model ?? null,
                  effort: panel.routine.effort ?? null,
                  name: panel.routine.name,
                  prompt: panel.routine.prompt,
                  cadence: panel.routine.cadence,
                  workspaceId: panel.routine.workspace_id ?? null,
                  permissionMode: panel.routine.permission_mode,
                  isolate: panel.routine.isolate
                }
              : { engine: 'claude', model: null, effort: null, ...EMPTY_DRAFT }
          }
          onSubmit={submit}
          onCancel={() => {
            onDismissError()
            setPanel(null)
          }}
        />
      </div>
    )
  }

  function toggleHistory(id: number): void {
    if (historyOpen === id) {
      setHistoryOpen(null)
      return
    }
    setHistoryOpen(id)
    if (runs[id] === undefined) onLoadRuns(id)
  }

  function renderRow(r: Routine): React.JSX.Element {
    const live = running.includes(r.id)
    return (
      <RoutineRow
        key={r.id}
        routine={r}
        workspace={r.workspace_id != null ? workspaceById.get(r.workspace_id) : undefined}
        now={now}
        running={live}
        historyOpen={historyOpen === r.id}
        runs={runs[r.id]}
        runsLoading={runsLoading === r.id}
        onToggleHistory={() => toggleHistory(r.id)}
        onOpenSession={onOpenSession}
        onRunNow={() => {
          onRequest({ routineName: r.name })
          onRunNow(r.id)
        }}
        onEdit={() => openEditor(r)}
        onToggleEnabled={() => {
          onRequest({ routineName: r.name })
          onUpdate({
            id: r.id,
            expected_revision: r.revision,
            enabled: !r.enabled
          })
        }}
        onDelete={() => {
          onRequest({ routineName: r.name })
          onDelete(r.id, r.revision)
        }}
      />
    )
  }

  const nothingScheduled = today.length + thisWeek.length + later.length + paused.length === 0

  return (
    <div
      data-testid="nav-surface"
      {...materialAttrs('base')}
      className={`flex-1 min-w-0 h-full min-h-0 overflow-y-auto rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      <NavColumn>
        <SectionHead
          title="Next up"
          lede="Every routine's clock, soonest first. Each run is independent: its own engine, prompt and directory, and its own pane you can open."
        />
        {error && (
          <NavFeedback tone="error" testId="routine-error" onDismiss={onDismissError}>
            {formatRoutineError(error)}
          </NavFeedback>
        )}
        <div className="flex items-center gap-[8px]">
          <span className="mr-auto [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
            {routines.length === 0
              ? 'Nothing scheduled.'
              : `${routines.length} routine${routines.length === 1 ? '' : 's'}`}
          </span>
          <button
            type="button"
            data-testid="routine-create"
            className={`${PRIMARY_BUTTON} min-w-[120px]`}
            onClick={() => {
              onDismissError()
              setPanel({ mode: 'create' })
            }}
          >
            New routine
          </button>
        </div>
        {nothingScheduled ? (
          <NavEmpty
            testId="routines-empty"
            title="Nothing scheduled."
            icon={<Icon glyph={IconClock} role="display" />}
            action={
              <button
                type="button"
                data-testid="routine-create-cta"
                className={`${PRIMARY_BUTTON} w-[160px]`}
                onClick={() => setPanel({ mode: 'create' })}
              >
                New routine
              </button>
            }
          >
            A routine is a prompt with a cadence, its own engine, prompt and working directory.
            Every run starts fresh in its own terminal pane.
          </NavEmpty>
        ) : (
          <>
            {today.length > 0 && <Group heading="Today">{today.map(renderRow)}</Group>}
            {thisWeek.length > 0 && <Group heading="This week">{thisWeek.map(renderRow)}</Group>}
            {later.length > 0 && <Group heading="Later">{later.map(renderRow)}</Group>}
            {paused.length > 0 && <Group heading="Paused">{paused.map(renderRow)}</Group>}
          </>
        )}
      </NavColumn>
    </div>
  )
}

const EMPTY_DRAFT = {
  name: '',
  prompt: '',
  cadence: { type: 'interval', seconds: 900 } as const,
  workspaceId: null,
  permissionMode: 'accept_edits' as const,
  isolate: false
}
