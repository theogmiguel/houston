import { lazy, Suspense, useEffect, useState } from 'react'
import { Button, EmptyState, ListDetail, Notice, PageFrame, PageHeader, StatusLabel, type ListDetailItem, NavSurfaceFrame } from '../ui'
import type { HoustonClient } from '../../houston/client'
import { WeeklyReviewDetail, WeeklyReviewSetup } from './WeeklyReviewDetail'
import { Text } from '../ui'
import { IconClock, IconPlus } from '../icons'
import { ListDetailMeta } from '../ui/ListDetail'
import { scheduleFields, scheduleLabel } from './harnessFormat'
import { formatRoutineError, nextUpTimeLabel, formatCadence } from './routineFormat'
import { RoutineEditor, type RoutineFormValue } from './RoutineEditor'
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

export function sortRoutines(routines: Routine[]): Routine[] {
  return [...routines].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'harness_review' ? -1 : 1
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

export function RoutinesSurface(props: {
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
  selectedRoutineId?: number | null
  onRoutineSelect?: (id: number | null) => void
  showLimitNotice?: boolean
}): React.JSX.Element {
  const {
    client = null, routines, running, engineRefusals = [], runs, runsLoading, workspaces, error, onDismissError, onCreate,
    onUpdate, onDelete, onRunNow, onLoadRuns, onOpenSession, onRequest, now,
    selectedRoutineId, onRoutineSelect, showLimitNotice = true
  } = props
  const [panel, setPanel] = useState<Panel>(null)
  const [localSelection, setLocalSelection] = useState<string | null>(null)
  const [pendingRuns, setPendingRuns] = useState<Set<number>>(() => new Set())
  const selectedId = selectedRoutineId === undefined ? localSelection : selectedRoutineId == null ? null : String(selectedRoutineId)
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const slotsFull = running.length >= ROUTINE_RUNS_CONCURRENT
  const waitingIds = new Set(sortRoutines(routines)
    .filter((routine) => routine.enabled && !running.includes(routine.id) && routine.next_run_at_ms <= now)
    .map((routine) => routine.id))
  const routineItems: Array<ListDetailItem & { routine: Routine | null; setupWorkspace?: RoutineWorkspaceOption }> = sortRoutines(routines).map((routine) => ({
    id: String(routine.id),
    section: routine.kind === 'harness_review' ? 'Built in' : 'Yours',
    title: routine.kind === 'harness_review' ? 'Weekly review' : routine.name,
    subLayout: 'full-width',
    sub: <ListDetailMeta left={routineMeta(routine, routine.workspace_id ? workspaceById.get(routine.workspace_id)?.name ?? routine.workspace_id : null)} right={routineStatus(routine, running.includes(routine.id), slotsFull && waitingIds.has(routine.id), now)} />,
    routine
  }))
  const setupItems = client ? workspaces.filter((workspace) => !routines.some((routine) => routine.kind === 'harness_review' && routine.workspace_id === workspace.id)).map((workspace) => ({
    id: `setup:${workspace.id}`, section: 'Built in', title: 'Weekly review',
    sub: <Text size="small" tone="muted">{workspace.name} · Not set up</Text>, routine: null, setupWorkspace: workspace,
    right: <Button variant="muted-link" size="sm" data-testid={`review-setup-${workspace.id}`} onClick={() => { onDismissError(); setPanel({ mode: 'review-setup', workspace }) }}>Set up Weekly review</Button>
  })) : []
  const items = [...routineItems.filter((item) => item.section === 'Built in'), ...setupItems, ...routineItems.filter((item) => item.section === 'Yours')]
  const selected = items.find((item) => item.id === selectedId)?.routine ?? null

  useEffect(() => {
    if (selectedRoutineId !== undefined) return
    if (localSelection && !routines.some((routine) => String(routine.id) === localSelection)) {
      setLocalSelection(routines[0] ? String(sortRoutines(routines)[0].id) : null)
    } else if (localSelection === null && routines.length > 0) {
      setLocalSelection(String(sortRoutines(routines)[0].id))
    }
  }, [localSelection, routines, selectedRoutineId])

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

  function selectRoutine(value: string | null): void {
    const setupWorkspace = items.find((item) => item.id === value)?.setupWorkspace
    if (setupWorkspace) { onDismissError(); setPanel({ mode: 'review-setup', workspace: setupWorkspace }); return }
    setLocalSelection(value)
    onRoutineSelect?.(value === null ? null : Number(value))
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
          <PageHeader heading="Routines" description="Prompts that run on a schedule, each in its own pane. Houston offers one weekly review per workspace." />
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
        description="Prompts that run on a schedule, each in its own pane. Houston offers one weekly review per workspace."
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
          const routine = item.routine
          if (!routine) return <EmptyState icon={IconClock} heading="Review setup" description="This workspace has no review routine yet." />
          const Detail = routine.kind === 'harness_review' ? WeeklyReviewDetail : RoutineDetail
          return (
            <Suspense fallback={<p role="status">Loading routine details…</p>}>
              <Detail
                client={client}
                workspaceName={routine.workspace_id ? workspaceById.get(routine.workspace_id)?.name ?? routine.workspace_id : null}
                routine={routine}
                engineRefusals={engineRefusals}
                runs={runs[routine.id]}
                runsLoading={runsLoading === routine.id}
                now={now}
                running={running.includes(routine.id)}
                pending={pendingRuns.has(routine.id)}
                atLimit={showLimitNotice && slotsFull ? { running: running.length, limit: ROUTINE_RUNS_CONCURRENT } : null}
                onRunNow={() => {
                  onRequest({ routineName: routine.name })
                  setPendingRuns((current) => new Set(current).add(routine.id))
                  onRunNow(routine.id)
                }}
                onToggleEnabled={() => {
                  onRequest({ routineName: routine.name })
                  onUpdate({ id: routine.id, expected_revision: routine.revision, enabled: !routine.enabled })
                }}
                onEdit={() => { onDismissError(); setPanel({ mode: 'edit', routine }) }}
                onDelete={() => { onRequest({ routineName: routine.name }); onDelete(routine.id, routine.revision) }}
                onUpdateReviewSchedule={(fields: ReturnType<typeof scheduleFields>) => onUpdate({ id: routine.id, expected_revision: routine.revision, ...fields })}
                onUpdateSchedule={(cadence) => onUpdate({ id: routine.id, expected_revision: routine.revision, cadence })}
                onUpdateEngine={(engine) => onUpdate({ id: routine.id, expected_revision: routine.revision, engine })}
                onOpenSession={onOpenSession}
              />
            </Suspense>
          )
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
  const cadence = !routine.enabled ? 'Paused' : routine.kind === 'harness_review' ? scheduleLabel(routine) : formatCadence(routine.cadence)
  const label = cadence.charAt(0).toUpperCase() + cadence.slice(1)
  return `${label}${workspaceName ? ` · ${workspaceName}` : ''}`
}
