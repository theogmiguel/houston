import { lazy, Suspense, useEffect, useState, type ComponentProps } from 'react'
import { Button, EmptyState, ListDetail, Notice, PageFrame, PageHeader, StatusLabel, type ListDetailItem, NavSurfaceFrame } from '../ui'
import type { HoustonClient } from '../../houston/client'
import { WeeklyReviewDetail, WeeklyReviewSetup } from './WeeklyReviewDetail'
import { WeeklyReviewWorkspaces } from './WeeklyReviewWorkspaces'
import { IconClock, IconPlus } from '../icons'
import { ListDetailMeta } from '../ui/ListDetail'
import { scheduleFields } from './harnessFormat'
import { formatRoutineError, nextUpTimeLabel, formatCadence } from './routineFormat'
import { RoutineEditor, type RoutineFormValue } from './RoutineEditor'

import { useNightShiftFocus } from '../../nightShiftNav'
import type {
  Routine,
  RoutineDraft,
  RoutineMutation,
  RoutineRefusal,
  RoutineRun,
  RoutineWorkspaceOption
} from '../../houston/routineTypes'
import { ROUTINE_RUNS_CONCURRENT } from '../../houston/generated/DEFAULTS'
import type { RoutineEngineRefusal } from '../../houston/generated/RoutineEngineRefusal'

const RoutineDetail = lazy(() => import('../ui/RoutineDetail').then((module) => ({ default: module.RoutineDetail })))
const NightShiftView = lazy(() => import('./NightShiftView').then((module) => ({ default: module.NightShiftView })))

const KIND_ORDER: Record<Routine['kind'], number> = { harness_review: 0, night_shift: 1, user: 2 }

export function sortRoutines(routines: Routine[]): Routine[] {
  return [...routines].sort((a, b) => {
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    if (a.next_run_at_ms !== b.next_run_at_ms) return a.next_run_at_ms - b.next_run_at_ms
    return a.id - b.id
  })
}

type Panel = { mode: 'create' } | { mode: 'edit'; routine: Routine } | { mode: 'review-setup'; workspace: RoutineWorkspaceOption } | null

function routineStatus(routine: Routine, running: boolean, waiting: boolean, now: number): React.JSX.Element {
  if (running) return <StatusLabel status="Running" size="small" />
  if (waiting) return <StatusLabel status="Waiting for a slot" size="small" />
  if (!routine.enabled) return <StatusLabel status="Paused" size="small" />
  return <StatusLabel status="Idle" size="small">{`Next ${nextUpTimeLabel(routine.next_run_at_ms, now)}`}</StatusLabel>
}

type RoutinesSurfaceProps = {
  client?: HoustonClient | null
  routines: Routine[]
  running: number[]
  /** Engine and access pairs the daemon refuses; their choices are shown disabled. */
  engineRefusals?: RoutineEngineRefusal[]
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
  /** Zero selects Weekly review; individual review IDs also open the group. */
  selectedRoutineId?: number | null
  onRoutineSelect?: (id: number | null) => void
  showLimitNotice?: boolean
}

export function RoutinesSurface(props: RoutinesSurfaceProps): React.JSX.Element {
  const {
    client = null, routines, running, engineRefusals = [], runs, runsLoading, workspaces, error, onDismissError, onCreate,
    onUpdate, onLoadRuns, onRequest, now, selectedRoutineId, onRoutineSelect
  } = props
  const [panel, setPanel] = useState<Panel>(null)
  const [pendingRuns, setPendingRuns] = useState<Set<number>>(() => new Set())
  const reviews = sortRoutines(routines).filter((routine) => routine.kind === 'harness_review')
  const { selectedId, selectRoutine } = useRoutineSelection(routines, selectedRoutineId, onRoutineSelect)
  const nightFocus = useNightShiftFocus()
  // Without a notice to follow, Night shift opens on the workspace whose run is live.
  const nightLive = routines.find((routine) => routine.kind === 'night_shift' && running.includes(routine.id))?.workspace_id ?? null
  useEffect(() => {
    if (nightFocus && selectedId !== NIGHT_SELECTION) selectRoutine(NIGHT_SELECTION)
  }, [nightFocus]) // eslint-disable-line react-hooks/exhaustive-deps
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const slotsFull = running.length >= ROUTINE_RUNS_CONCURRENT
  const items = routineItems(routines, reviews, workspaces, running, slotsFull, now)
  const selected = items.find((item) => item.id === selectedId)?.routine ?? null

  useEffect(() => {
    if (selected && selected.kind !== 'harness_review' && runs[selected.id] === undefined && runsLoading !== selected.id) onLoadRuns(selected.id)
  }, [onLoadRuns, runs, runsLoading, selected])

  useEffect(() => {
    setPendingRuns((current) => {
      const next = new Set(current)
      for (const id of current) {
        if (running.includes(id) || runs[id]?.some((run) => run.status === 'running')) next.delete(id)
      }
      if (error) next.clear()
      return next.size === current.size ? current : next
    })
  }, [error, runs, running])

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

  if (panel?.mode === 'review-setup') {
    return <NavSurfaceFrame row><PageFrame width="wide" className="flex-1 min-w-0">
      <PageHeader heading="Set up Weekly review" description={`Review sessions in ${panel.workspace.name}.`} />
      {error && <Notice tone="danger">{formatRoutineError(error)}</Notice>}
      <WeeklyReviewSetup client={client} workspace={panel.workspace} onCancel={() => { onDismissError(); setPanel(null) }} onCreate={(setup) => {
        onRequest({ attemptedName: 'Weekly review' })
        client?.harnessRoutineCreate({ workspace: panel.workspace.id, ...setup })
        setPanel(null)
      }} />
    </PageFrame></NavSurfaceFrame>
  }

  if (panel) {
    return (
      <NavSurfaceFrame row>
        <PageFrame width="wide" className="flex-1 min-w-0">
          <PageHeader heading="Routines" description="Prompts that run on a schedule, each in its own pane. Set up Weekly review and Night shift for the workspaces you choose." />
          {error && <Notice tone="danger">{formatRoutineError(error)}</Notice>}
          <RoutineEditor
            mode={panel.mode}
            workspaces={workspaces}
            engineRefusals={engineRefusals}
            error={error ? formatRoutineError(error) : null}
            initial={panel.mode === 'edit' ? {
              engine: panel.routine.engine,
              model: panel.routine.model ?? null,
              effort: panel.routine.effort ?? null,
              name: panel.routine.name,
              prompt: panel.routine.prompt,
              cadence: panel.routine.cadence,
              workspaceId: panel.routine.workspace_id ?? null,
              permissionMode: panel.routine.permission_mode,
              isolate: panel.routine.isolate
            } : { engine: 'claude', model: null, effort: null, ...EMPTY_DRAFT }}
            onSubmit={submit}
            onCancel={() => { onDismissError(); setPanel(null) }}
          />
        </PageFrame>
      </NavSurfaceFrame>
    )
  }

  return (
    <NavSurfaceFrame row>
    <PageFrame width="wide" className="flex-1 min-w-0">
      <PageHeader
        heading="Routines"
        description="Prompts that run on a schedule, each in its own pane. Set up Weekly review and Night shift for the workspaces you choose."
        actions={<Button variant="primary" icon={IconPlus} data-testid="routine-create" onClick={() => { onDismissError(); setPanel({ mode: 'create' }) }}>New routine</Button>}
      />
      {error && <Notice tone="danger">{formatRoutineError(error)}</Notice>}
      <ListDetail
        items={items}
        sectionStyle="plain"
        selectedId={selectedId}
        onSelect={selectRoutine}
        backLabel="Routines"
        listEmpty={<EmptyState icon={IconClock} heading="No routines" description="Create a routine to run prompts on a schedule." />}
        renderDetail={(item) => {
          if (!item) return <EmptyState icon={IconClock} heading="Select a routine" description="Choose a routine to see its schedule and runs." />
          const detail = (routine: Routine, workspaceName: string | null): React.JSX.Element => <SurfaceRoutineDetail
            {...props} routine={routine} workspaceName={workspaceName} pending={pendingRuns.has(routine.id)} slotsFull={slotsFull}
            onStart={() => setPendingRuns((current) => new Set(current).add(routine.id))}
            onEdit={() => { onDismissError(); setPanel({ mode: 'edit', routine }) }} />
          if (item.id === NIGHT_SELECTION) return <Suspense fallback={<p role="status">Loading Night shift…</p>}>
            <NightShiftView key={nightFocus ? `${nightFocus.workspace}:${nightFocus.runId}` : 'night'}
              client={client} workspaces={workspaces} now={now} onOpenSession={props.onOpenSession}
              initialWorkspace={nightFocus?.workspace ?? nightLive} initialRunId={nightFocus?.runId ?? null} />
          </Suspense>
          if (item.id === REVIEW_SELECTION) return <WeeklyReviewWorkspaces reviews={reviews} workspaces={workspaces} connected={!!client}
            onSetup={(workspace) => { onDismissError(); setPanel({ mode: 'review-setup', workspace }) }} renderReview={detail} />
          return item.routine && detail(item.routine, item.routine.workspace_id ? workspaceById.get(item.routine.workspace_id)?.name ?? item.routine.workspace_id : null)
        }}
      />
    </PageFrame>
    </NavSurfaceFrame>
  )
}

const EMPTY_DRAFT = {
  name: '', prompt: '', workspaceId: null, permissionMode: 'accept_edits' as const,
  isolate: false, cadence: { type: 'interval' as const, seconds: 900 }
}

function routineMeta(routine: Routine, workspaceName: string | null): string {
  const cadence = !routine.enabled ? 'Paused' : formatCadence(routine.cadence)
  const label = cadence.charAt(0).toUpperCase() + cadence.slice(1)
  return `${label}${workspaceName ? ` · ${workspaceName}` : ''}`
}

// Zero identifies the aggregate only in renderer selection; daemon routine IDs are positive.
const REVIEW_SELECTION = '0'
const NIGHT_SELECTION = 'night'

function selectionFor(id: number | null, routines: Routine[]): string | null {
  if (id === null) return null
  const kind = routines.find((routine) => routine.id === id)?.kind
  return kind === 'harness_review' ? REVIEW_SELECTION : kind === 'night_shift' ? NIGHT_SELECTION : String(id)
}

function useRoutineSelection(routines: Routine[], controlled: number | null | undefined, onSelect?: (id: number | null) => void): {
  selectedId: string | null
  selectRoutine: (value: string | null) => void
} {
  const [local, setLocal] = useState<string | null>(null)
  const [picked, setPicked] = useState(false)
  useEffect(() => {
    if (controlled !== undefined) return
    // The default follows the roster until the user picks; it often arrives after the page opens.
    if (picked && (local === REVIEW_SELECTION || local === NIGHT_SELECTION || routines.some((routine) => String(routine.id) === local))) return
    const next = selectionFor(sortRoutines(routines)[0]?.id ?? 0, routines)
    if (next !== local) setLocal(next)
  }, [controlled, local, picked, routines])
  return {
    selectedId: controlled === undefined ? local : selectionFor(controlled, routines),
    selectRoutine: (value) => { setPicked(true); setLocal(value); onSelect?.(value === null || value === NIGHT_SELECTION ? null : Number(value)) }
  }
}

type RoutineItem = ListDetailItem & { routine: Routine | null }

function routineItems(routines: Routine[], reviews: Routine[], workspaces: RoutineWorkspaceOption[], running: number[], slotsFull: boolean, now: number): RoutineItem[] {
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  const active = reviews.filter((routine) => routine.enabled).length
  const summary = reviews.length === 0 ? 'Not set up' : `On in ${active} of ${workspaces.length} workspaces`
  const reviewRunning = reviews.some((routine) => running.includes(routine.id))
  const reviewSub = reviewRunning ? <ListDetailMeta left={summary} right={<StatusLabel status="Running" size="small" />} /> : summary
  const nights = routines.filter((routine) => routine.kind === 'night_shift')
  const nightRunning = nights.some((routine) => running.includes(routine.id))
  const nightSummary = nights.length === 0 ? 'Not set up' : `On in ${nights.filter((routine) => routine.enabled).length} of ${workspaces.length} workspaces`
  const nightSub = nightRunning ? <ListDetailMeta left={nightSummary} right={<StatusLabel status="Running" size="small" />} /> : nightSummary
  return [{ id: REVIEW_SELECTION, section: 'Built in', title: 'Weekly review', sub: reviewSub, ...(reviewRunning ? { subLayout: 'full-width' as const } : {}), routine: null },
    { id: NIGHT_SELECTION, section: 'Built in', title: 'Night shift', sub: nightSub, ...(nightRunning ? { subLayout: 'full-width' as const } : {}), routine: null },
    ...sortRoutines(routines).filter((routine) => routine.kind === 'user').map((routine) => ({
      id: String(routine.id), section: 'Yours', title: routine.name, subLayout: 'full-width' as const,
      sub: <ListDetailMeta left={routineMeta(routine, routine.workspace_id ? workspaceById.get(routine.workspace_id) ?? routine.workspace_id : null)} right={routineStatus(routine, running.includes(routine.id), slotsFull && routine.enabled && !running.includes(routine.id) && routine.next_run_at_ms <= now, now)} />,
      routine
    }))]
}

function SurfaceRoutineDetail({ routine, workspaceName, pending, slotsFull, onStart, onEdit, ...props }: RoutinesSurfaceProps & {
  routine: Routine
  workspaceName: string | null
  pending: boolean
  slotsFull: boolean
  onStart: () => void
  onEdit: () => void
}): React.JSX.Element {
  const { running, runs, runsLoading, now, onRequest, onRunNow, onUpdate, onDelete, onOpenSession, showLimitNotice = true } = props
  const common: ComponentProps<typeof RoutineDetail> = {
    routine, engineRefusals: props.engineRefusals, runs: runs[routine.id], runsLoading: runsLoading === routine.id, now,
    running: running.includes(routine.id), pending,
    atLimit: showLimitNotice && slotsFull ? { running: running.length, limit: ROUTINE_RUNS_CONCURRENT } : null,
    onRunNow: () => { onRequest({ routineName: routine.name }); onStart(); onRunNow(routine.id) },
    onToggleEnabled: () => { onRequest({ routineName: routine.name }); onUpdate({ id: routine.id, expected_revision: routine.revision, enabled: !routine.enabled }) },
    onEdit,
    onDelete: () => { onRequest({ routineName: routine.name }); onDelete(routine.id, routine.revision) },
    onUpdateSchedule: (cadence) => onUpdate({ id: routine.id, expected_revision: routine.revision, cadence }),
    onUpdateEngine: (engine) => onUpdate({ id: routine.id, expected_revision: routine.revision, engine }),
    onOpenSession
  }
  return <Suspense fallback={<p role="status">Loading routine details…</p>}>
    {routine.kind === 'harness_review' ? <WeeklyReviewDetail {...common} client={props.client} workspaceName={workspaceName} grouped
      onUpdateReviewSchedule={(fields: ReturnType<typeof scheduleFields>) => onUpdate({ id: routine.id, expected_revision: routine.revision, ...fields })} /> : <RoutineDetail {...common} />}
  </Suspense>
}
