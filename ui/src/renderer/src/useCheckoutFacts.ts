// The checkout facts lifecycle: each pane's directory, what git last answered
// for it, and the requests that keep those answers fresh. The pure grouping
// lives in `checkoutFacts.ts`; this module owns the state and the effects.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Conn } from './App'
import { checkoutNotes, type CheckoutFacts } from './checkoutFacts'
import {
  isLive,
  type AgentKind,
  type HoustonClient,
  type ServerMsg,
  type SessionInfo,
  type Workspace
} from './houston/client'

export interface CheckoutFactsApi {
  /** Branch per session id, once git has answered for that pane's cwd. */
  chips: Map<number, string>
  /** Consultative checkout note per session id, for the chip's tooltip. */
  notes: Map<number, string>
  /** Feed every `ServerMsg` here; unrelated messages are ignored. */
  handleMessage: (msg: ServerMsg) => void
  /** A replaced connection: forget the answers and pending asks. */
  reset: (roster: SessionInfo[]) => void
  /** A session was added: ask for its directory's identity. */
  requestForSession: (target: HoustonClient, session: SessionInfo) => void
  /** A fresh roster: ask for every live session's directory. */
  requestForRoster: (target: HoustonClient, roster: SessionInfo[]) => void
}

function checkoutFactsFromReply(
  msg: Extract<ServerMsg, { type: 'git_branch' }>
): CheckoutFacts {
  return {
    branch: msg.branch,
    toplevel: msg.toplevel ?? null,
    common_dir: msg.common_dir ?? null
  }
}

// A reply settles the ask for its own directory; an unrelated reply returns the
// set unchanged, so the state update bails instead of re-rendering every pane.
function settlePendingDir(
  pending: ReadonlySet<string>,
  dir: string
): ReadonlySet<string> {
  if (!pending.has(dir)) return pending
  const next = new Set(pending)
  next.delete(dir)
  return next
}

export function useCheckoutFacts({
  conn,
  activeId,
  sessions,
  sessionsRef,
  workspaces
}: {
  conn: Conn
  activeId: number | null
  sessions: Map<number, SessionInfo>
  sessionsRef: { current: Map<number, SessionInfo> }
  workspaces: Workspace[]
}): CheckoutFactsApi {
  const [facts, setFacts] = useState<Map<string, CheckoutFacts>>(new Map())
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  // The live cwd per session, resolved with `sessionCwd` when the pane is
  // focused; the roster's initial cwd is the fallback.
  const [paneCwds, setPaneCwds] = useState<Map<number, string>>(new Map())
  const pendingRef = useRef<ReadonlySet<string>>(pending)
  pendingRef.current = pending

  const dirOf = useCallback(
    (session: SessionInfo): string => paneCwds.get(session.id) ?? session.cwd,
    [paneCwds]
  )

  const request = useCallback(
    (target: HoustonClient, dir: string, agent: AgentKind): void => {
      if (!dir || agent === 'ssh') return
      if (pendingRef.current.has(dir)) return
      const next = new Set(pendingRef.current)
      next.add(dir)
      pendingRef.current = next
      setPending(next)
      target.gitBranch(dir)
    },
    []
  )

  const handleMessage = useCallback((msg: ServerMsg): void => {
    if (msg.type !== 'git_branch') return
    setFacts((prev) => {
      const next = new Map(prev).set(msg.dir, checkoutFactsFromReply(msg))
      // One checkout has one branch: a reply keeps every other known directory
      // on the same toplevel consistent, so two panes in one checkout never
      // disagree until both are focused again.
      if (msg.toplevel != null) {
        for (const [dir, known] of next) {
          if (dir !== msg.dir && known.toplevel === msg.toplevel) {
            next.set(dir, { ...known, branch: msg.branch })
          }
        }
      }
      return next
    })
    pendingRef.current = settlePendingDir(pendingRef.current, msg.dir)
    setPending(pendingRef.current)
  }, [])

  const reset = useCallback((roster: SessionInfo[]): void => {
    setFacts(new Map())
    pendingRef.current = new Set()
    setPending(new Set())
    setPaneCwds(new Map(roster.map((s) => [s.id, s.cwd])))
  }, [])

  const requestForSession = useCallback(
    (target: HoustonClient, session: SessionInfo): void => {
      setPaneCwds((prev) => new Map(prev).set(session.id, session.cwd))
      request(target, session.cwd, session.agent)
    },
    [request]
  )

  const requestForRoster = useCallback(
    (target: HoustonClient, roster: SessionInfo[]): void => {
      for (const s of roster) if (isLive(s.state)) request(target, s.cwd, s.agent)
    },
    [request]
  )

  // A pane's branch is a live git fact, not stored state: focus resolves the
  // session's live cwd and asks again on refocus, so a `git switch` shows up
  // without a timer. While the ask is unanswered the chip stays off.
  useEffect(() => {
    if (conn.kind !== 'ready' || activeId === null) return
    const info = sessionsRef.current.get(activeId)
    if (!info) return
    const target = conn.client
    target.sessionCwd(activeId).then(
      (cwd) => {
        setPaneCwds((prev) => new Map(prev).set(activeId, cwd))
        request(target, cwd, info.agent)
      },
      () => {
        // The session ended between the focus and the resolve; the chip is
        // absent, which is the honest answer.
      }
    )
  }, [activeId, conn, request, sessionsRef])

  const chips = useMemo(() => {
    const out = new Map<number, string>()
    for (const s of sessions.values()) {
      if (s.agent === 'ssh') continue
      const dir = paneCwds.get(s.id) ?? s.cwd
      if (pending.has(dir)) continue
      const branch = facts.get(dir)?.branch
      if (branch) out.set(s.id, branch)
    }
    return out
  }, [sessions, facts, pending, paneCwds])

  const notes = useMemo(
    () =>
      checkoutNotes(sessions.values(), facts, dirOf, (path) =>
        basenameOf(workspaces.find((w) => w.path === path)?.name ?? path)
      ),
    [sessions, facts, dirOf, workspaces]
  )

  return { chips, notes, handleMessage, reset, requestForSession, requestForRoster }
}

function basenameOf(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}
