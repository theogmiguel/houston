import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HoustonClient } from './client'
import type { TaskSummary } from './generated/TaskSummary'
import { isTaskTrackerProvider, sendTaskWire, type TaskDomain, type TaskProject, type TaskTrackerProvider } from './taskDomain'

export type TaskTrackerSyncStates = Partial<Record<TaskTrackerProvider, { at: number | null; error: string | null }>>

export interface TaskProjectDraft {
  name: string
  external_url: string | null
  tracker_description: string | null
  local_decisions: string[]
}

export interface TaskProjects {
  /** Projects of every listed workspace, or null until each workspace has answered. */
  projects: TaskProject[] | null
  domains: Readonly<Record<number, TaskDomain>>
  syncStates: Readonly<Record<string, TaskTrackerSyncStates>>
  busy: boolean
  error: string | null
  clearError: () => void
  saveProject: (workspace: string, project: TaskProject | null, draft: TaskProjectDraft) => void
  archiveProject: (project: TaskProject, archived: boolean) => void
}

type ProjectsClient = Pick<HoustonClient, 'subscribeAll' | 'send'>

/** Projects, task domains and tracker sync for the workspaces a task list spans. */
export function useTaskProjects(client: ProjectsClient | null, workspaces: readonly string[], tasks: readonly TaskSummary[] | null): TaskProjects {
  const [byWorkspace, setByWorkspace] = useState<Record<string, TaskProject[]>>({})
  const [domains, setDomains] = useState<Record<number, TaskDomain>>({})
  const [syncStates, setSyncStates] = useState<Record<string, TaskTrackerSyncStates>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const requested = useRef(new Map<number, number>())
  const workspaceKey = workspaces.join('\n')

  useEffect(() => {
    setByWorkspace({})
    setSyncStates({})
    if (!client || workspaceKey === '') return
    const known = new Set(workspaceKey.split('\n'))
    const off = client.subscribeAll((message) => {
      if (message.type === 'task_projects_state' && known.has(message.workspace)) {
        busyRef.current = false
        setBusy(false)
        setByWorkspace((current) => ({ ...current, [message.workspace]: message.projects }))
      }
      if (message.type === 'task_project_changed' && known.has(message.workspace)) sendTaskWire(client, { type: 'task_projects_list', workspace: message.workspace })
      if (message.type === 'task_domain_state') setDomains((current) => ({ ...current, [message.domain.task_id]: message.domain }))
      if (message.type === 'task_plan_changed') sendTaskWire(client, { type: 'task_domain_get', id: message.id })
      if (message.type === 'task_tracker_sync_state' && known.has(message.workspace) && isTaskTrackerProvider(message.provider)) {
        const provider = message.provider
        setSyncStates((current) => ({ ...current, [message.workspace]: { ...current[message.workspace], [provider]: { at: message.last_sync_at_ms, error: message.error } } }))
      }
      if (message.type === 'task_refused' && busyRef.current) {
        busyRef.current = false
        setBusy(false)
        setError(message.message)
      }
    })
    for (const workspace of known) sendTaskWire(client, { type: 'task_projects_list', workspace })
    return off
  }, [client, workspaceKey])

  useEffect(() => {
    requested.current.clear()
    setDomains({})
  }, [client])

  useEffect(() => {
    if (!client || !tasks) return
    for (const task of tasks) {
      if (requested.current.get(task.id) === task.revision) continue
      requested.current.set(task.id, task.revision)
      sendTaskWire(client, { type: 'task_domain_get', id: task.id })
    }
  }, [client, tasks])

  const projects = useMemo(() => {
    if (workspaceKey === '') return []
    const lists = workspaceKey.split('\n').map((workspace) => byWorkspace[workspace])
    return lists.some((list) => list === undefined) ? null : lists.flat() as TaskProject[]
  }, [byWorkspace, workspaceKey])

  const saveProject = useCallback((workspace: string, project: TaskProject | null, draft: TaskProjectDraft): void => {
    if (!client || !draft.name.trim()) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    sendTaskWire(client, { type: 'task_project_save', workspace, id: project?.id ?? null, expected_revision: project?.revision ?? null, ...draft, name: draft.name.trim() })
  }, [client])

  const archiveProject = useCallback((project: TaskProject, archived: boolean): void => {
    if (!client) return
    setError(null)
    sendTaskWire(client, { type: 'task_project_archive', id: project.id, archived, expected_revision: project.revision })
  }, [client])

  const clearError = useCallback(() => setError(null), [])

  return { projects, domains, syncStates, busy, error, clearError, saveProject, archiveProject }
}
