import { useCallback, useEffect, useRef, useState } from 'react'
import { rememberTaskKeys } from './taskLinks'
import type { HoustonClient } from './client'
import type { AgentKind } from './generated/AgentKind'
import type { Task } from './generated/Task'
import type { TaskAcceptanceItem } from './generated/TaskAcceptanceItem'
import type { TaskComment } from './generated/TaskComment'
import type { TaskCounts } from './generated/TaskCounts'
import type { TaskErrorKind } from './generated/TaskErrorKind'
import type { TaskGithubSettings } from './generated/TaskGithubSettings'
import type { TaskHistoryEntry } from './generated/TaskHistoryEntry'
import type { TaskPatch } from './generated/TaskPatch'
import type { TaskPromptDelivery } from './generated/TaskPromptDelivery'
import type { TaskQueueRefusal } from './generated/TaskQueueRefusal'
import type { TaskRun } from './generated/TaskRun'
import type { TaskRunAction } from './generated/TaskRunAction'
import type { TaskSummary } from './generated/TaskSummary'
import type { TasksAccess } from './generated/TasksAccess'

export interface TasksSnapshot {
  scope: string
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
  /// The bound pane's task, watched without being opened, so the Now card can
  /// show its acceptance list.
  watched: TaskDetailData | null
  refusal: TaskRefusal | null
  access: TasksAccess | null
  openTask: (id: number) => void
  closeTask: () => void
  watchTask: (id: number | null) => void
  reloadTask: (id: number) => void
  refresh: () => void
  saveTask: (id: number | null, expectedRevision: number | null, patch: TaskPatch) => void
  comment: (id: number, body: string) => void
  check: (id: number, item: number, checked: boolean) => void
  archive: (id: number, archived: boolean, expectedRevision: number) => void
  setAccess: (access: TasksAccess) => void
  /// `force` is the user's "start anyway" past the readiness gate.
  startTask: (id: number, agent: AgentKind, workspace?: string | null, force?: boolean) => void
  runControl: (runId: number, action: TaskRunAction) => void
  /// Opens a GitHub issue for the task in its workspace's repository.
  openIssue: (id: number) => void
  /// Creates a task and opens it: the daemon's create reply is the only signal
  /// that names the new id, so the detail opens on its `task_changed`.
  createTask: (patch: TaskPatch, onCreated?: (id: number) => void) => void
}

/// A workspace's review defaults, from `task_review_settings`.
export interface TaskReviewSettings {
  reviewer: AgentKind | null
  reworkRounds: number
}

/// Settings ▸ Tasks ▸ Review edits the workspace's reviewer and rework rounds;
/// the daemon's broadcast is the only thing that moves the controls, and its
/// refusal (over the cap) is kept until the next successful set.
export function useTaskReviewSettings(
  client: HoustonClient | null,
  workspace: string | null
): {
  settings: TaskReviewSettings | null
  refusal: TaskRefusal | null
  setReviewSettings: (reviewer: AgentKind | null, reworkRounds: number) => void
} {
  const [settings, setSettings] = useState<TaskReviewSettings | null>(null)
  const [refusal, setRefusal] = useState<TaskRefusal | null>(null)
  const pending = useRef(false)

  useEffect(() => {
    setSettings(null)
    setRefusal(null)
    pending.current = false
    if (!client || !workspace) return
    const offSettings = client.subscribe('task_review_settings', (msg) => {
      if (msg.workspace !== workspace) return
      pending.current = false
      setRefusal(null)
      setSettings({ reviewer: msg.reviewer ?? null, reworkRounds: msg.rework_rounds })
    })
    const offRefused = client.subscribe('task_refused', (msg) => {
      if (!pending.current) return
      pending.current = false
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
    client.taskReviewSettingsGet(workspace)
    return () => {
      offSettings()
      offRefused()
    }
  }, [client, workspace])

  const setReviewSettings = useCallback(
    (reviewer: AgentKind | null, reworkRounds: number) => {
      if (!client || !workspace) return
      pending.current = true
      setRefusal(null)
      client.taskReviewSettingsSet(workspace, reviewer, reworkRounds)
    },
    [client, workspace]
  )

  return { settings, refusal, setReviewSettings }
}

/// A workspace's GitHub Issues connector, from `task_github`, with the
/// repository its remote names and the last sync's outcome.
export interface TaskGithubState {
  settings: TaskGithubSettings
  repository: string | null
  lastSyncAtMs: number | null
  error: string | null
}

export function useTaskGithub(
  client: HoustonClient | null,
  workspace: string | null
): {
  state: TaskGithubState | null
  refusal: TaskRefusal | null
  setGithub: (settings: TaskGithubSettings) => void
} {
  const [state, setState] = useState<TaskGithubState | null>(null)
  const [refusal, setRefusal] = useState<TaskRefusal | null>(null)
  const pending = useRef(false)

  useEffect(() => {
    setState(null)
    setRefusal(null)
    pending.current = false
    if (!client || !workspace) return
    const offState = client.subscribe('task_github', (msg) => {
      if (msg.workspace !== workspace) return
      pending.current = false
      setRefusal(null)
      setState({
        settings: msg.settings,
        repository: msg.repository ?? null,
        lastSyncAtMs: msg.last_sync_at_ms ?? null,
        error: msg.error ?? null
      })
    })
    const offRefused = client.subscribe('task_refused', (msg) => {
      if (!pending.current) return
      pending.current = false
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
    client.taskGithubGet(workspace)
    return () => {
      offState()
      offRefused()
    }
  }, [client, workspace])

  const setGithub = useCallback(
    (settings: TaskGithubSettings) => {
      if (!client || !workspace) return
      pending.current = true
      setRefusal(null)
      client.taskGithubSet(workspace, settings)
    },
    [client, workspace]
  )

  return { state, refusal, setGithub }
}

/// The `task_queue_result` the roster's "Run next N" comes back with.
export interface TaskQueueResult {
  workspace: string
  started: string[]
  refused: TaskQueueRefusal[]
  readyCount: number
  freeChildren: number
}

/// The roster queue: the workspace snapshot (ready count and todo pool) and the
/// answer to a run. Subscribes while the roster column is expanded, so the
/// Queue count is real before the view opens; a collapsed roster costs nothing.
export function useTaskQueue(
  client: HoustonClient | null,
  workspace: string | null,
  enabled: boolean
): {
  tasks: TaskSummary[]
  readyCount: number | null
  result: TaskQueueResult | null
  /// The all-or-nothing slot refusal, which comes back as a direct
  /// `task_refused` (not on the result); null once a run answers.
  refusal: string | null
  run: (orchestratorSession: number, count: number) => void
} {
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [readyCount, setReadyCount] = useState<number | null>(null)
  const [result, setResult] = useState<TaskQueueResult | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const pending = useRef(false)

  useEffect(() => {
    if (!client || !workspace || !enabled) return
    const offSnapshot = client.subscribe('task_snapshot', (msg) => {
      if (msg.scope !== workspace) return
      setTasks(msg.tasks)
      setReadyCount(msg.counts.ready)
    })
    const offResult = client.subscribe('task_queue_result', (msg) => {
      if (msg.workspace !== workspace) return
      pending.current = false
      setRefusal(null)
      setResult({
        workspace: msg.workspace,
        started: msg.started,
        refused: msg.refused,
        readyCount: msg.ready_count,
        freeChildren: msg.free_children
      })
    })
    const offRefused = client.subscribe('task_refused', (msg) => {
      if (!pending.current) return
      pending.current = false
      setRefusal(msg.message)
    })
    client.taskSnapshot(workspace)
    return () => {
      offSnapshot()
      offResult()
      offRefused()
    }
  }, [client, workspace, enabled])

  const run = useCallback(
    (orchestratorSession: number, count: number) => {
      if (!client) return
      pending.current = true
      setResult(null)
      setRefusal(null)
      client.taskQueueRun(orchestratorSession, count)
    },
    [client]
  )

  return { tasks, readyCount, result, refusal, run }
}

/// A workspace's Start defaults, from `task_start_settings`.
export interface TaskStartSettings {
  agent: AgentKind
  delivery: TaskPromptDelivery
}

/// Settings ▸ Tasks edits the workspace's Start defaults without loading the
/// backlog; the daemon's broadcast is the only thing that moves the controls.
export function useTaskStartSettings(
  client: HoustonClient | null,
  workspace: string | null
): { settings: TaskStartSettings | null; setStartSettings: (agent: AgentKind, delivery: TaskPromptDelivery) => void } {
  const [settings, setSettings] = useState<TaskStartSettings | null>(null)

  useEffect(() => {
    setSettings(null)
    if (!client || !workspace) return
    const off = client.subscribe('task_start_settings', (msg) => {
      if (msg.workspace === workspace) setSettings({ agent: msg.agent, delivery: msg.delivery })
    })
    client.taskStartSettingsGet(workspace)
    return off
  }, [client, workspace])

  const setStartSettings = useCallback(
    (agent: AgentKind, delivery: TaskPromptDelivery) => {
      if (client && workspace) client.taskStartSettingsSet(workspace, agent, delivery)
    },
    [client, workspace]
  )

  return { settings, setStartSettings }
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

/// A scoped global snapshot and the open task, re-read whenever the daemon
/// broadcasts a change. Writes are optimistic only in what they clear: the
/// daemon's `task_changed` drives every read.
export function useTasks(client: HoustonClient | null, workspace: string | null, scope = workspace ?? 'all'): UseTasks {
  const [snapshot, setSnapshot] = useState<TasksSnapshot | null>(null)
  const [detail, setDetail] = useState<TaskDetailData | null>(null)
  const [watched, setWatched] = useState<TaskDetailData | null>(null)
  const [refusal, setRefusal] = useState<TaskRefusal | null>(null)
  const [access, setAccess] = useState<TasksAccess | null>(null)
  const openId = useRef<number | null>(null)
  const watchedId = useRef<number | null>(null)
  const pendingCreate = useRef<((id: number) => void) | null>(null)

  useEffect(() => {
    setSnapshot(null)
    setDetail(null)
    setWatched(null)
    setRefusal(null)
    setAccess(null)
    openId.current = null
    watchedId.current = null
    pendingCreate.current = null
    if (!client) return
    const offSnapshot = client.subscribe('task_snapshot', (msg) => {
      if (msg.scope !== scope) return
      rememberTaskKeys(msg.scope, msg.tasks)
      setSnapshot({ scope: msg.scope, tasks: msg.tasks, counts: msg.counts })
    })
    const offDetail = client.subscribe('task_detail', (msg) => {
      const data = { task: msg.task, acceptance: msg.acceptance, comments: msg.comments, history: msg.history, runs: msg.runs }
      if (watchedId.current === msg.task.id) setWatched(data)
      if (openId.current !== msg.task.id) return
      setRefusal((current) => (current?.id === msg.task.id ? null : current))
      setDetail(data)
    })
    const offChanged = client.subscribe('task_changed', (msg) => {
      if (pendingCreate.current !== null) {
        const onCreated = pendingCreate.current
        pendingCreate.current = null
        onCreated(msg.id)
      }
      client.taskSnapshot(scope)
      if (openId.current === msg.id) client.taskGet(msg.id)
      if (watchedId.current === msg.id) client.taskGet(msg.id)
    })
    // A run's own broadcast carries no workspace, so the snapshot is re-read
    // for every run change; the detail is re-read only when the id matches.
    const offRun = client.subscribe('task_run_changed', (msg) => {
      client.taskSnapshot(scope)
      if (openId.current === msg.run.task_id) client.taskGet(msg.run.task_id)
      if (watchedId.current === msg.run.task_id) client.taskGet(msg.run.task_id)
    })
    const offRefused = client.subscribe('task_refused', (msg) => {
      pendingCreate.current = null
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
    client.taskSnapshot(scope)
    if (workspace) client.tasksAccessGet(workspace)
    return () => {
      offSnapshot()
      offDetail()
      offChanged()
      offRun()
      offRefused()
      offAccess()
    }
  }, [client, workspace, scope])

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

  const watchTask = useCallback(
    (id: number | null) => {
      watchedId.current = id
      setWatched(null)
      if (id !== null && client) client.taskGet(id)
    },
    [client]
  )

  const reloadTask = useCallback(
    (id: number) => {
      if (!client) return
      setRefusal((current) => (current?.id === id ? null : current))
      client.taskGet(id)
    },
    [client]
  )

  const refresh = useCallback(() => {
    if (client) client.taskSnapshot(scope)
  }, [client, workspace, scope])

  const saveTask = useCallback(
    (id: number | null, expectedRevision: number | null, patch: TaskPatch) => {
      if (!client) return
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

  const startTask = useCallback(
    (id: number, agent: AgentKind, assignedWorkspace?: string | null, force = false) => {
      if (!client) return
      setRefusal(null)
      client.taskStart(id, agent, null, assignedWorkspace ?? null, force)
    },
    [client]
  )

  const openIssue = useCallback(
    (id: number) => {
      if (!client) return
      setRefusal(null)
      client.taskGithubOpenIssue(id)
    },
    [client]
  )

  const runControl = useCallback(
    (runId: number, action: TaskRunAction) => {
      if (!client) return
      setRefusal(null)
      client.taskRunControl(runId, action)
    },
    [client]
  )

  const createTask = useCallback(
    (patch: TaskPatch, onCreated?: (id: number) => void) => {
      if (!client) return
      setRefusal(null)
      pendingCreate.current = onCreated ?? null
      client.taskSave(workspace, null, null, patch)
    },
    [client, workspace]
  )

  return {
    snapshot: snapshot?.scope === scope ? snapshot : null,
    detail,
    watched,
    refusal,
    access,
    openTask,
    closeTask,
    watchTask,
    reloadTask,
    refresh,
    saveTask,
    comment,
    check,
    archive,
    setAccess: setAccessValue,
    startTask,
    runControl,
    openIssue,
    createTask
  }
}
