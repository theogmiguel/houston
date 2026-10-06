import type { SessionInfo, PrInfo } from '../../houston/client'

export interface RailLine2Details {
  branch: true
  worktree: true
  pullRequest: true
  otherBranches: boolean
  diff: boolean
}
export function line2DetailsForWidth(width: number): RailLine2Details {
  return {
    branch: true,
    worktree: true,
    pullRequest: true,
    otherBranches: width >= 260,
    diff: width >= 280,
  }
}

export interface RailPaneRow {
  session: SessionInfo
  depth: number
}

export interface RailHoverCheckout {
  path: string
  session: SessionInfo
  branch: string | undefined
  diff: { added: number; deleted: number; ahead?: number; behind?: number; changedFiles?: number } | undefined
  pr: { gh: string; pr: PrInfo | null } | undefined
}

export interface RailHoverCardModel {
  panes: RailPaneRow[]
  checkouts: RailHoverCheckout[]
}

export function orderGridPanes(sessions: readonly SessionInfo[], paneIds: readonly number[]): RailPaneRow[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const members = paneIds.flatMap((id) => byId.get(id) ?? [])
  const memberIds = new Set(members.map((session) => session.id))
  const children = new Map<number, SessionInfo[]>()
  for (const session of members) {
    if (session.spawned_by == null || !memberIds.has(session.spawned_by)) continue
    const group = children.get(session.spawned_by) ?? []
    group.push(session)
    children.set(session.spawned_by, group)
  }
  const rows: RailPaneRow[] = []
  const seen = new Set<number>()
  const visit = (session: SessionInfo, depth: number): void => {
    if (seen.has(session.id)) return
    seen.add(session.id)
    rows.push({ session, depth })
    for (const child of children.get(session.id) ?? []) visit(child, depth + 1)
  }
  for (const session of members) if (session.spawned_by == null || !memberIds.has(session.spawned_by)) visit(session, 0)
  for (const session of members) visit(session, 0)
  return rows
}

export function railHoverCardModel(
  sessions: readonly SessionInfo[],
  paneIds: readonly number[],
  branches: ReadonlyMap<number, string>,
  diffByDir: ReadonlyMap<string, { added: number; deleted: number; ahead?: number; behind?: number; changedFiles?: number }>,
  prByDir: ReadonlyMap<string, { gh: string; pr: PrInfo | null }>,
): RailHoverCardModel {
  const panes = orderGridPanes(sessions, paneIds)
  const checkoutSessions = new Map<string, SessionInfo>()
  for (const { session } of panes) {
    const path = session.worktree?.path ?? session.checkout_root ?? session.cwd
    if (!checkoutSessions.has(path)) checkoutSessions.set(path, session)
  }
  const checkouts = [...checkoutSessions.entries()].map(([path, session]) => ({
    path,
    session,
    branch: branches.get(session.id) ?? session.worktree?.branch,
    diff: diffByDir.get(path),
    pr: prByDir.get(path),
  }))
  return { panes, checkouts }
}
