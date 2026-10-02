import { useEffect, useMemo, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { TaskPatch } from '../../houston/generated/TaskPatch'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import type { SelectOption } from '../Select'
import { useTasks } from '../../houston/useTasks'
import { BTN_GHOST } from '../buttonChrome'
import { HIT_TARGET_28 } from '../hitTarget'
import { Icon } from '../Icon'
import { IconAlertTriangle, IconChevronLeft } from '../icons'
import { TaskComposer } from './TaskComposer'
import { TaskDetail } from './TaskDetail'
import { TasksList } from './TasksList'

type TasksView = 'list' | 'task' | 'create'

/// The Tasks side tab. Owns the list/detail switch; every read and write goes
/// through `useTasks`, so a `task_changed` broadcast is the only thing that
/// moves the screen.
export function TasksTab({
  client,
  workspace,
  compose = false,
  onComposeHandled,
  openTaskId,
  onOpenTaskHandled
}: {
  client: HoustonClient | null
  workspace: string
  compose?: boolean
  onComposeHandled?: () => void
  openTaskId?: number
  onOpenTaskHandled?: () => void
}): React.JSX.Element {
  const tasks = useTasks(client, workspace)
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

  const parentOptions = useMemo<SelectOption[]>(() => {
    const openId = tasks.detail?.task.id
    return (tasks.snapshot?.tasks ?? [])
      .filter((task) => task.archived_at_ms == null && task.id !== openId)
      .sort((a, b) => a.number - b.number)
      .map((task) => ({ value: String(task.id), label: `${task.key} — ${task.title}` }))
  }, [tasks.snapshot, tasks.detail])

  const workspaceName = workspace.replace(/\/+$/, '').split('/').pop() || workspace

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
          onBack={() => {
            tasks.closeTask()
            setView('list')
          }}
          onReload={tasks.reloadTask}
          onSave={(id, expectedRevision, patch) => tasks.saveTask(id, expectedRevision, patch)}
          onCheck={tasks.check}
          onComment={tasks.comment}
          onArchive={tasks.archive}
        />
      )
    }
    return (
      <div className="tasks-root" data-testid="task-detail-loading">
        <div className="tk-head">
          <button
            type="button"
            className={`btn ${BTN_GHOST} ${HIT_TARGET_28}`}
            onClick={() => {
              tasks.closeTask()
              setView('list')
            }}
          >
            <Icon glyph={IconChevronLeft} role="small" />
            Tasks
          </button>
        </div>
        {tasks.refusal && tasks.refusal.id !== null && (
          <div className="tk-banner error">
            <Icon glyph={IconAlertTriangle} role="small" />
            <span className="msg">{tasks.refusal.message}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <TasksList
      workspaceName={workspaceName}
      tasks={tasks.snapshot?.tasks ?? []}
      selectedId={null}
      now={now}
      access={tasks.access}
      refusal={tasks.refusal}
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
