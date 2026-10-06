import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionInfo, HoustonClient } from '../../houston/client'
import type { TaskPatch } from '../../houston/generated/TaskPatch'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import type { SelectOption } from '../Select'
import { useTaskStartSettings, useTasks, type TaskRefusal } from '../../houston/useTasks'
import { BTN_GHOST } from '../buttonChrome'
import { HIT_TARGET_28 } from '../hitTarget'
import { Icon } from '../Icon'
import { IconAlertTriangle, IconChevronLeft } from '../icons'
import { TaskComposer } from './TaskComposer'
import { TaskDetail } from './TaskDetail'
import { TaskNowCard } from './TaskNowCard'
import { TasksList } from './TasksList'

type TasksView = 'list' | 'task' | 'create'

/// The Tasks side tab: owns the list/detail switch, reads and writes through
/// `useTasks` (only a `task_changed` broadcast moves the screen), and pins the
/// focused pane's task above the list when it belongs to this workspace.
export function TasksTab({
  client,
  workspace,
  workspaces = [],
  boundSession = null,
  sessions,
  onFocusPane,
  onReviewChild,
  onStartRequested,
  compose = false,
  onComposeHandled,
  openTaskId,
  onOpenTaskHandled,
  createDraft,
  onCreateDraftHandled
}: {
  client: HoustonClient | null
  workspace: string
  workspaces?: { path: string; name: string }[]
  boundSession?: SessionInfo | null
  sessions?: ReadonlyMap<number, SessionInfo>
  onFocusPane?: (id: number) => void
  onReviewChild?: (child: SessionInfo) => void
  /// Called with the task id as Start is sent, so the host can place the pane
  /// the daemon creates for this client's own Start.
  onStartRequested?: (taskId: number, workspace: string) => void
  compose?: boolean
  onComposeHandled?: () => void
  openTaskId?: number
  onOpenTaskHandled?: () => void
  /// The palette's "New task from terminal selection": created on arrival, then
  /// its detail opens. A creation refusal stays on the list view.
  createDraft?: { title: string; description: string } | null
  onCreateDraftHandled?: () => void
}): React.JSX.Element {
  const [scope, setScope] = useState<'all' | 'workspace'>(() => readStoredScope(workspace))
  const tasks = useTasks(client, workspace || null, scope === 'all' ? 'all' : workspace || 'unassigned')
  const workspaceOptions = workspaces.map((item) => ({ value: item.path, label: item.name }))
  const changeScope = (next: 'all' | 'workspace'): void => {
    setScope(next)
    try { localStorage.setItem(`houston.tasks.scope:${workspace}`, next) } catch {}
  }
  const { settings: startSettings } = useTaskStartSettings(client, tasks.detail?.task.workspace ?? workspace)
  const [view, setView] = useState<TasksView>('list')
  const [createStatus, setCreateStatus] = useState<TaskStatus | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!compose) return
    setCreateStatus(undefined)
    setView('create')
    onComposeHandled?.()
  }, [compose, onComposeHandled])

  useEffect(() => {
    if (openTaskId === undefined) return
    tasks.openTask(openTaskId)
    setView('task')
    onOpenTaskHandled?.()
  }, [openTaskId, onOpenTaskHandled, tasks.openTask])

  // StrictMode runs mount effects twice; the draft's identity is the guard so
  // one palette command never creates two tasks.
  const handledDraft = useRef<object | null>(null)
  useEffect(() => {
    if (!createDraft || handledDraft.current === createDraft) return
    handledDraft.current = createDraft
    tasks.createTask({ title: createDraft.title, description: createDraft.description }, (id) => {
      tasks.openTask(id)
      setView('task')
    })
    onCreateDraftHandled?.()
  }, [createDraft, onCreateDraftHandled, tasks.createTask, tasks.openTask])

  const boundTaskId = boundTaskIdOf(boundSession, workspace)
  const boundSummary = useMemo(
    () => (boundTaskId === null ? null : tasks.snapshot?.tasks.find((task) => task.id === boundTaskId) ?? null),
    [boundTaskId, tasks.snapshot]
  )

  useEffect(() => {
    tasks.watchTask(boundTaskId)
  }, [boundTaskId, tasks.watchTask])

  const parentOptions = useMemo<SelectOption[]>(() => {
    const openId = tasks.detail?.task.id
    return (tasks.snapshot?.tasks ?? [])
      .filter((task) => task.archived_at_ms == null && task.id !== openId)
      .sort((a, b) => a.number - b.number)
      .map((task) => ({ value: String(task.id), label: `${task.key} — ${task.title}` }))
  }, [tasks.snapshot, tasks.detail])

  const onCreate = (patch: TaskPatch): void => {
    tasks.saveTask(null, null, patch)
    setView('list')
  }

  if (view === 'create') {
    return (
      <TaskComposer
        defaultStatus={createStatus ?? 'backlog'}
        parentOptions={parentOptions}
        onCancel={() => setView('list')}
        onCreate={onCreate}
      />
    )
  }

  if (view === 'task') {
    if (tasks.detail) {
      return (
        <TaskDetail
          detail={tasks.detail}
          access={tasks.access}
          refusal={tasks.refusal}
          now={now}
          parentOptions={parentOptions}
          workspaceOptions={workspaceOptions}
          sessions={sessions ?? EMPTY_SESSIONS}
          startSettings={startSettings}
          onBack={() => {
            tasks.closeTask()
            setView('list')
          }}
          onReload={tasks.reloadTask}
          onSave={(id, expectedRevision, patch) => tasks.saveTask(id, expectedRevision, patch)}
          onCheck={tasks.check}
          onComment={tasks.comment}
          onArchive={tasks.archive}
          onStart={(id, agent, assignedWorkspace, force) => {
            const target = tasks.detail?.task.workspace ?? assignedWorkspace
            if (target) onStartRequested?.(id, target)
            tasks.startTask(id, agent, assignedWorkspace, force)
          }}
          onRunControl={tasks.runControl}
          onOpenIssue={tasks.openIssue}
          onOpenSession={(sessionId) => onFocusPane?.(sessionId)}
          onReview={(session) => onReviewChild?.(session)}
        />
      )
    }
    return (
      <TaskDetailLoading
        refusal={tasks.refusal}
        onBack={() => {
          tasks.closeTask()
          setView('list')
        }}
      />
    )
  }

  return (
    <TasksList
      scope={scope}
      onScope={changeScope}
      showWorkspace={scope === 'all'}
      tasks={tasks.snapshot?.tasks ?? []}
      selectedId={null}
      now={now}
      access={tasks.access}
      refusal={tasks.refusal}
      nowCard={
        boundTaskId !== null && boundSession !== null ? (
          <TaskNowCard
            session={boundSession}
            summary={boundSummary}
            detail={tasks.watched}
            onOpenSession={(sessionId) => onFocusPane?.(sessionId)}
            onStop={(runId) => tasks.runControl(runId, 'stop')}
          />
        ) : undefined
      }
      onOpen={(id) => {
        tasks.openTask(id)
        setView('task')
      }}
      onNew={(status) => {
        setCreateStatus(status)
        setView('create')
      }}
      onAccess={tasks.setAccess}
    />
  )
}

function boundTaskIdOf(session: SessionInfo | null, workspace: string): number | null {
  return session?.task != null && session.project_dir === workspace ? session.task.task_id : null
}

function readStoredScope(workspace: string): 'all' | 'workspace' {
  try {
    return localStorage.getItem(`houston.tasks.scope:${workspace}`) === 'workspace' ? 'workspace' : 'all'
  } catch {
    return 'all'
  }
}

/// Shown while the opened task's detail is in flight, or when the daemon refused it.
function TaskDetailLoading({
  refusal,
  onBack
}: {
  refusal: TaskRefusal | null
  onBack: () => void
}): React.JSX.Element {
  return (
    <div className="tasks-root" data-testid="task-detail-loading">
      <div className="tk-head">
        <button type="button" className={`btn ${BTN_GHOST} ${HIT_TARGET_28}`} onClick={onBack}>
          <Icon glyph={IconChevronLeft} role="small" />
          Tasks
        </button>
      </div>
      {refusal && refusal.id !== null && (
        <div className="tk-banner error">
          <Icon glyph={IconAlertTriangle} role="small" />
          <span className="msg">{refusal.message}</span>
        </div>
      )}
    </div>
  )
}

const EMPTY_SESSIONS: ReadonlyMap<number, SessionInfo> = new Map()
