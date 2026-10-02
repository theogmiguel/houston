import { useCallback, useEffect, useRef, useState } from 'react'
import { rememberTaskKeys } from './taskLinks'
import type { HoustonClient } from './client'
import type { Task } from './generated/Task'
import type { TaskAcceptanceItem } from './generated/TaskAcceptanceItem'
import type { TaskComment } from './generated/TaskComment'
import type { TaskCounts } from './generated/TaskCounts'
import type { TaskErrorKind } from './generated/TaskErrorKind'
import type { TaskHistoryEntry } from './generated/TaskHistoryEntry'
import type { TaskPatch } from './generated/TaskPatch'
import type { TaskRun } from './generated/TaskRun'
import type { TaskSummary } from './generated/TaskSummary'
import type { TasksAccess } from './generated/TasksAccess'

export interface TasksSnapshot {
  workspace: string
  tasks: TaskSummary[]
  counts: TaskCounts
}

export interface TaskDetailData {
  task: Task
  acceptance: TaskAcceptanceItem[]
  comments: TaskComment[]
  history: TaskHistoryEntry[]
  runs: TaskRun[]
}

/// A typed refusal as the daemon sent it. `message` already names the limit,
/// the actual value and the operation; the fields let the UI pick a treatment
/// (a conflict gets the reload banner, access gets an empty state).
export interface TaskRefusal {
  id: number | null
  kind: TaskErrorKind
  message: string
  expected: number | null
  actual: number | null
  limit: number | null
  requested: number | null
}

export interface UseTasks {
  snapshot: TasksSnapshot | null
  detail: TaskDetailData | null
  refusal: TaskRefusal | null
  access: TasksAccess | null
  openTask: (id: number) => void
  closeTask: () => void
  reloadTask: (id: number) => void
  refresh: () => void
  saveTask: (id: number | null, expectedRevision: number | null, patch: TaskPatch) => void
  comment: (id: number, body: string) => void
  check: (id: number, item: number, checked: boolean) => void
  archive: (id: number, archived: boolean, expectedRevision: number) => void
  setAccess: (access: TasksAccess) => void
}

/// The workspace's Tasks access setting alone. Settings ▸ Tasks edits it
/// without needing the backlog itself, so it does not subscribe to snapshots.
export function useTasksAccess(
  client: HoustonClient | null,
  workspace: string | null
): { access: TasksAccess | null; setAccess: (access: TasksAccess) => void } {
  const [access, setAccessState] = useState<TasksAccess | null>(null)

  useEffect(() => {
    setAccessState(null)
    if (!client || !workspace) return
    const off = client.subscribe('tasks_access', (msg) => {
      if (msg.workspace === workspace) setAccessState(msg.access)
    })
    client.tasksAccessGet(workspace)
    return off
  }, [client, workspace])

  const setAccessValue = useCallback(
    (next: TasksAccess) => {
      if (client && workspace) client.tasksAccessSet(workspace, next)
    },
    [client, workspace]
  )

  return { access, setAccess: setAccessValue }
}

/// A workspace's task snapshot and the open task, re-read whenever the daemon
/// broadcasts a change. Writes are optimistic only in what they clear: the
/// daemon's `task_changed` drives every read.
export function useTasks(client: HoustonClient | null, workspace: string | null): UseTasks {
  const [snapshot, setSnapshot] = useState<TasksSnapshot | null>(null)
  const [detail, setDetail] = useState<TaskDetailData | null>(null)
  const [refusal, setRefusal] = useState<TaskRefusal | null>(null)
  const [access, setAccess] = useState<TasksAccess | null>(null)
  const openId = useRef<number | null>(null)

  useEffect(() => {
    setSnapshot(null)
    setDetail(null)
    setRefusal(null)
    setAccess(null)
    openId.current = null
    if (!client || !workspace) return
    const offSnapshot = client.subscribe('task_snapshot', (msg) => {
      if (msg.workspace !== workspace) return
      rememberTaskKeys(msg.workspace, msg.tasks)
      setSnapshot({ workspace: msg.workspace, tasks: msg.tasks, counts: msg.counts })
    })
    const offDetail = client.subscribe('task_detail', (msg) => {
      if (msg.task.workspace !== workspace) return
      if (openId.current !== null && msg.task.id !== openId.current) return
      setRefusal((current) => (current?.id === msg.task.id ? null : current))
      setDetail({ task: msg.task, acceptance: msg.acceptance, comments: msg.comments, history: msg.history, runs: msg.runs })
    })
    const offChanged = client.subscribe('task_changed', (msg) => {
      if (msg.workspace !== workspace) return
      client.taskSnapshot(workspace)
      if (openId.current === msg.id) client.taskGet(msg.id)
    })
    const offRefused = client.subscribe('task_refused', (msg) => {
      setRefusal({
        id: msg.id ?? null,
        kind: msg.kind,
        message: msg.message,
        expected: msg.expected ?? null,
        actual: msg.actual ?? null,
        limit: msg.limit ?? null,
        requested: msg.requested ?? null
      })
    })
    const offAccess = client.subscribe('tasks_access', (msg) => {
      if (msg.workspace === workspace) setAccess(msg.access)
    })
    client.taskSnapshot(workspace)
    client.tasksAccessGet(workspace)
    return () => {
      offSnapshot()
      offDetail()
      offChanged()
      offRefused()
      offAccess()
    }
  }, [client, workspace])

  const openTask = useCallback(
    (id: number) => {
      if (!client) return
      openId.current = id
      setDetail(null)
      setRefusal(null)
      client.taskGet(id)
    },
    [client]
  )

  const closeTask = useCallback(() => {
    openId.current = null
    setDetail(null)
    setRefusal(null)
  }, [])

  const reloadTask = useCallback(
    (id: number) => {
      if (!client) return
      setRefusal((current) => (current?.id === id ? null : current))
      client.taskGet(id)
    },
    [client]
  )

  const refresh = useCallback(() => {
    if (client && workspace) client.taskSnapshot(workspace)
  }, [client, workspace])

  const saveTask = useCallback(
    (id: number | null, expectedRevision: number | null, patch: TaskPatch) => {
      if (!client || !workspace) return
      setRefusal(null)
      client.taskSave(workspace, id, expectedRevision, patch)
    },
    [client, workspace]
  )

  const comment = useCallback(
    (id: number, body: string) => {
      if (!client) return
      setRefusal(null)
      client.taskComment(id, body)
    },
    [client]
  )

  const check = useCallback(
    (id: number, item: number, checked: boolean) => {
      if (!client) return
      setRefusal(null)
      client.taskCheck(id, item, checked)
    },
    [client]
  )

  const archive = useCallback(
    (id: number, archived: boolean, expectedRevision: number) => {
      if (!client) return
      setRefusal(null)
      client.taskArchive(id, archived, expectedRevision)
    },
    [client]
  )

  const setAccessValue = useCallback(
    (next: TasksAccess) => {
      if (!client || !workspace) return
      setRefusal(null)
      client.tasksAccessSet(workspace, next)
    },
    [client, workspace]
  )

  return {
    snapshot: snapshot?.workspace === workspace ? snapshot : null,
    detail: detail?.task.workspace === workspace ? detail : null,
    refusal,
    access,
    openTask,
    closeTask,
    reloadTask,
    refresh,
    saveTask,
    comment,
    check,
    archive,
    setAccess: setAccessValue
  }
}
