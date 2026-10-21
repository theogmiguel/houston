import { useCallback, useEffect, useRef, useState } from 'react'
import type { HoustonClient, SessionInfo } from './houston/client'
import type { InboxRow } from './houston/generated/InboxRow'
import { addressedToOperator, ownUserInput } from './sessionAttention'
import { openSideOverview, selectOverviewChild } from './sidePanel'

export interface WaitingRequest {
  key: string
  since: number
  session: number | null
  row: InboxRow | null
}

export interface RequestOrigin {
  workspace: string
  grid: string | null
  pane: number | null
  peek: number | null
}

export interface RequestNavigation {
  focusPane: (session: number) => void
  switchWorkspace: (path: string) => void
  selectGrid: (path: string, gridId: string) => void
  setActivePane: (session: number) => void
}

function byAge(a: WaitingRequest, b: WaitingRequest): number {
  return a.since - b.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

/** Requests assigned to the operator, oldest first: the same amber state the taskbar counts, plus Addressed to you rows. */
export function waitingRequests(sessions: ReadonlyMap<number, SessionInfo>, rows: readonly InboxRow[]): WaitingRequest[] {
  const requests: WaitingRequest[] = []
  for (const session of sessions.values()) {
    if (!ownUserInput(session) || session.hidden) continue
    requests.push({ key: `pane:${session.id}`, since: session.status_since_ms ?? session.delegation?.started_at ?? 0, session: session.id, row: null })
  }
  for (const row of rows) {
    if (addressedToOperator(row, sessions)) requests.push({ key: `inbox:${row.id}`, since: Number(row.created_at), session: null, row })
  }
  return requests.sort(byAge)
}

/** The request after `last` in age order, wrapping; a `last` answered meanwhile still marks the position. */
export function requestAfter(requests: readonly WaitingRequest[], last: WaitingRequest | null): WaitingRequest | null {
  if (requests.length === 0) return null
  if (last === null) return requests[0]
  return requests.find((request) => byAge(request, last) > 0) ?? requests[0]
}

export function focusWaitingRequest(request: WaitingRequest, sessions: ReadonlyMap<number, SessionInfo>, nav: RequestNavigation): void {
  if (request.session !== null) {
    nav.focusPane(request.session)
    return
  }
  const row = request.row!
  const owner = [row.original_to, row.from_session].find((id): id is number => id != null && sessions.has(id))
  if (owner === undefined) {
    nav.switchWorkspace(row.workspace)
    return
  }
  nav.focusPane(owner)
  if ([...sessions.values()].some((session) => session.spawned_by === owner)) openSideOverview(owner)
}

export function restoreRequestOrigin(origin: RequestOrigin, sessions: ReadonlyMap<number, SessionInfo>, nav: RequestNavigation): void {
  if (origin.grid !== null) nav.selectGrid(origin.workspace, origin.grid)
  else nav.switchWorkspace(origin.workspace)
  const pane = origin.pane
  if (pane === null || !sessions.has(pane)) return
  nav.setActivePane(pane)
  window.setTimeout(() => selectOverviewChild(pane, origin.peek), 0)
}

/** Operator inbox rows (`to_session = 0`, unresolved) for every workspace, kept current by row pushes. */
export function useOperatorInbox(client: HoustonClient | null, workspaces: readonly string[]): InboxRow[] {
  const [rows, setRows] = useState<InboxRow[]>([])
  const workspaceKey = workspaces.join('\0')
  useEffect(() => {
    if (!client) return
    const known = new Set(workspaces)
    const open = (row: InboxRow): boolean => row.to_session === 0 && row.resolved_at == null
    setRows((current) => current.every((row) => known.has(row.workspace)) ? current : current.filter((row) => known.has(row.workspace)))
    const offRows = client.subscribe('inbox_rows', (message) => {
      if (!known.has(message.workspace)) return
      const operator = message.rows.filter(open)
      setRows((current) => operator.length === 0 && !current.some((row) => row.workspace === message.workspace)
        ? current
        : [...current.filter((row) => row.workspace !== message.workspace), ...operator])
    })
    const offChanged = client.subscribe('inbox_changed', (message) => {
      if (!known.has(message.workspace)) return
      const row = message.row
      setRows((current) => !open(row) && !current.some((other) => other.id === row.id)
        ? current
        : [...current.filter((other) => other.id !== row.id), ...(open(row) ? [row] : [])])
    })
    for (const path of workspaces) client.inboxList(path)
    return () => { offRows(); offChanged() }
  }, [client, workspaceKey])
  return rows
}

export interface NextRequestControls {
  count: number
  next: () => void
  back: () => void
  canGoBack: boolean
}

/** Next request cycles oldest first; Back returns to where the operator was before the first jump. */
export function useNextRequest(options: {
  requests: () => WaitingRequest[]
  focus: (request: WaitingRequest) => void
  captureOrigin: () => RequestOrigin
  restoreOrigin: (origin: RequestOrigin) => void
  nothingWaiting: () => void
}): NextRequestControls {
  const latest = useRef(options)
  latest.current = options
  const last = useRef<WaitingRequest | null>(null)
  const [origin, setOrigin] = useState<RequestOrigin | null>(null)
  const originRef = useRef<RequestOrigin | null>(null)
  const next = useCallback((): void => {
    const target = requestAfter(latest.current.requests(), last.current)
    if (target === null) {
      latest.current.nothingWaiting()
      return
    }
    if (originRef.current === null) {
      originRef.current = latest.current.captureOrigin()
      setOrigin(originRef.current)
    }
    last.current = target
    latest.current.focus(target)
  }, [])
  const back = useCallback((): void => {
    const saved = originRef.current
    if (saved === null) return
    originRef.current = null
    last.current = null
    setOrigin(null)
    latest.current.restoreOrigin(saved)
  }, [])
  return { count: options.requests().length, next, back, canGoBack: origin !== null }
}
