import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { InboxRow } from '../../houston/generated/InboxRow'
import type { SessionInfo, HoustonClient } from '../../houston/client'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import { taskAgentLabel } from './format'

// What a task's waiting agent asked, shared by the Tasks and Factory pages.
// The daemon has no structured question for a run waiting for input; the
// text comes from the pane's hold reason or its newest needs-input inbox row.

export function useInboxRows(client: HoustonClient | null, workspaces: string[], setRows: Dispatch<SetStateAction<InboxRow[]>>): void {
  useEffect(() => {
    if (!client || workspaces.length === 0) return
    const known = new Set(workspaces)
    const offRows = client.subscribe('inbox_rows', (message) => {
      if (known.has(message.workspace)) setRows((current) => [...current.filter((row) => row.workspace !== message.workspace), ...message.rows])
    })
    const offChanged = client.subscribe('inbox_changed', (message) => {
      if (known.has(message.workspace)) setRows((current) => [...current.filter((row) => row.id !== message.row.id), message.row])
    })
    workspaces.forEach((path) => client.inboxList(path))
    return () => { offRows(); offChanged() }
  }, [client, workspaces, setRows])
}

export function questionFor(task: TaskSummary, sessions: ReadonlyMap<number, SessionInfo>, rows: InboxRow[]): string | null {
  const sessionId = task.open_run?.session_id
  if (sessionId == null) return null
  const holdReason = sessions.get(sessionId)?.delegation?.hold_reason?.trim()
  if (holdReason) return holdReason
  const row = rows
    .filter((item) => item.kind === 'needs_input' && item.from_session === sessionId && item.resolved_at == null)
    .sort((a, b) => Number(b.created_at - a.created_at))[0]
  if (!row) return null
  const body = row.body.trim()
  const specific = body.match(/^this child needs input:\s*(.*?)\s*\.?\s*Inspect it\s*\(/i)?.[1]?.trim().replace(/\.\s*$/, '')
  if (specific) return specific
  if (body.includes('did not say why')) return null
  return body || row.summary || null
}

export function queueAgentLabel(provider: AgentKind): string {
  const label = taskAgentLabel(provider)
  return provider === 'claude' ? `${label} Code` : label
}
