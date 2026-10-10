import type { PrInfo, SessionInfo } from '../../houston/client'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { SessionActivity } from '../../houston/generated/SessionActivity'
import type { SessionCheckout } from '../../houston/generated/SessionCheckout'
import { gridStatus, liftDelegatedWork, type GridStatusModel } from '../ui/railRows'
import { orderGridPanes } from '../ui/railRowModel'

export type CheckoutIdentity =
  | { kind: 'primary'; root: string; branch: string | null; detached: boolean }
  | { kind: 'worktree'; root: string; slug: string; branch: string | null; detached: boolean }
  | { kind: 'folder'; root: string }
  | { kind: 'remote'; host: string }

export type RailAgentRow = {
  session: SessionInfo
  // A shell pane reports the agent CLI it is running; every other pane is its own kind.
  agent: AgentKind
  depth: number
  checkout: CheckoutIdentity
  leading: string
  trailing: string | null
  model: string | null
  unread: boolean
}

export type RailCard = {
  gridId: string
  workspace: string
  title: string
  pinned: boolean
  status: GridStatusModel
  checkouts: CheckoutIdentity[]
  pr: { gh: string; pr: PrInfo | null } | null
  diff: { added: number; deleted: number } | null
  agents: RailAgentRow[]
  lastActivityMs: number
}

export type RailCardSource = {
  gridId: string
  workspace: string
  title: string
  pinned?: boolean
  paneIds: readonly number[]
  sessions: readonly SessionInfo[]
  branches?: ReadonlyMap<number, string>
  diffByDir?: ReadonlyMap<string, { added: number; deleted: number }>
  prByDir?: ReadonlyMap<string, { gh: string; pr: PrInfo | null }>
}

// Distinguishes a working agent with no recent hook update from active work.
export const RAIL_QUIET_MS = 10 * 60_000

export function isRailCardQuiet(status: GridStatusModel, now: number): boolean {
  return status.kind === 'working' && status.since != null && now - status.since >= RAIL_QUIET_MS
}

function checkoutIdentity(session: SessionInfo, branches: ReadonlyMap<number, string>): CheckoutIdentity {
  const checkout = (session as SessionInfo & { checkout?: SessionCheckout | null }).checkout
  const checkoutKind = checkout?.kind
  const worktree = typeof checkoutKind === 'object' ? checkoutKind.worktree : undefined
  const branch = checkout?.branch ?? branches.get(session.id) ?? session.worktree?.branch ?? null
  if (session.ssh_host) return { kind: 'remote', host: session.ssh_host }
  if (worktree || session.worktree) {
    return {
      kind: 'worktree',
      root: checkout?.root ?? session.worktree?.path ?? session.checkout_root ?? session.cwd,
      slug: worktree?.slug ?? session.worktree?.branch ?? 'worktree',
      branch,
      detached: branch === null,
    }
  }
  if (checkoutKind === 'primary' || session.checkout_root) {
    return {
      kind: 'primary',
      root: checkout?.root ?? session.checkout_root ?? session.cwd,
      branch,
      detached: branch === null,
    }
  }
  if (checkoutKind === 'folder') return { kind: 'folder', root: checkout?.root ?? session.cwd }
  return { kind: 'folder', root: session.cwd }
}

function activityOf(session: SessionInfo): SessionActivity | null {
  return (session as SessionInfo & { activity?: SessionActivity | null }).activity ?? null
}

export function buildRailCard(source: RailCardSource): RailCard {
  const branches = source.branches ?? new Map<number, string>()
  const panes = orderGridPanes(source.sessions, source.paneIds).map((pane) => ({ ...pane, session: liftDelegatedWork(pane.session, source.sessions) }))
  const checkouts: CheckoutIdentity[] = []
  const checkoutKeys = new Set<string>()
  const agents = panes.map(({ session, depth }): RailAgentRow => {
    const checkout = checkoutIdentity(session, branches)
    const checkoutKey = checkout.kind === 'remote' ? `remote:${checkout.host}` : `${checkout.kind}:${checkout.root}`
    if (!checkoutKeys.has(checkoutKey)) {
      checkoutKeys.add(checkoutKey)
      checkouts.push(checkout)
    }
    const activity = activityOf(session)
    const leading = activity?.prompt?.trim() || session.title || session.agent
    return {
      session,
      agent: session.agent === 'shell' ? (session.running_agent ?? 'shell') : session.agent,
      depth,
      checkout,
      leading,
      trailing: activity?.last_message?.trim() || null,
      model: activity?.model ?? null,
      unread: session.inbox_unread > 0 || session.children_waiting > 0,
    }
  })
  const primaryPaneId = panes[0]?.session.id
  const primaryCheckout = primaryPaneId == null ? null : checkouts[0]
  const checkoutRoot = primaryCheckout && 'root' in primaryCheckout ? primaryCheckout.root : null
  const status = gridStatus(panes.map(({ session }) => session))
  const statusSince = panes.reduce((latest, { session }) => Math.max(latest, session.status_since_ms ?? 0), 0)
  const diff = checkoutRoot ? (source.diffByDir?.get(checkoutRoot) ?? null) : null
  const pr = checkoutRoot ? (source.prByDir?.get(checkoutRoot) ?? null) : null
  return {
    gridId: source.gridId,
    workspace: source.workspace,
    title: source.title,
    pinned: source.pinned ?? false,
    status,
    checkouts,
    pr,
    diff: diff ? { added: diff.added, deleted: diff.deleted } : null,
    agents,
    lastActivityMs: statusSince,
  }
}
