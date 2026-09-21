// The renderer's in-memory view of a directory's checkout, as the `git_branch`
// reply carries it. Nothing is persisted: a fact lives for the connection that
// received it, and `null` means git had no answer, never "unknown value".

import { isLive, type SessionInfo } from './houston/client'

export interface CheckoutFacts {
  branch: string | null
  toplevel: string | null
  common_dir: string | null
}

export interface CheckoutEntry {
  session: SessionInfo
  toplevel: string
  commonDir: string
}

export type CheckoutWarningKind = 'shared-checkout' | 'same-repository'

export interface CheckoutWarningView {
  kind: CheckoutWarningKind
  /** The chip's own words, already naming the count or the other workspace. */
  label: string
  entries: CheckoutEntry[]
}

// Live panes only: an exited session has no branch to move, and a remote pane
// has no local checkout. A missing toplevel or common dir is "unknown" and is
// excluded from both groups rather than guessed at.
function liveCheckoutEntries(
  sessions: Iterable<SessionInfo>,
  facts: ReadonlyMap<string, CheckoutFacts>
): CheckoutEntry[] {
  const out: CheckoutEntry[] = []
  for (const session of sessions) {
    if (!isLive(session.state) || session.agent === 'ssh') continue
    const fact = facts.get(session.cwd)
    if (!fact?.toplevel || !fact.common_dir) continue
    out.push({ session, toplevel: fact.toplevel, commonDir: fact.common_dir })
  }
  return out
}

function groupBy(
  entries: CheckoutEntry[],
  key: (entry: CheckoutEntry) => string
): Map<string, CheckoutEntry[]> {
  const groups = new Map<string, CheckoutEntry[]>()
  for (const entry of entries) {
    const k = key(entry)
    const group = groups.get(k)
    if (group) group.push(entry)
    else groups.set(k, [entry])
  }
  return groups
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

// The workspaces a same-repository group names beside the selected one: the
// other workspaces when there are any, else the checkouts other than the first
// one the selected workspace's own sessions sit in.
function otherLabels(
  group: CheckoutEntry[],
  selectedWs: string,
  workspaceName: (path: string) => string
): string[] {
  const others = [
    ...new Set(group.map((e) => e.session.project_dir).filter((p) => p !== selectedWs))
  ]
  if (others.length > 0) return others.map(workspaceName)
  const mine = group.find((e) => e.session.project_dir === selectedWs)
  const seen = new Set(mine ? [mine.toplevel] : [])
  return [
    ...new Set(group.map((e) => e.toplevel).filter((t) => !seen.has(t)))
  ].map(basename)
}

/** The top bar's checkout warnings for one selected workspace (`all` qualifies
 * every group). Groups span every live session: the hazardous pair is a main
 * checkout and its worktree, which are separate workspaces. */
export function checkoutWarnings(
  sessions: Iterable<SessionInfo>,
  facts: ReadonlyMap<string, CheckoutFacts>,
  selectedWs: string,
  workspaceName: (path: string) => string
): CheckoutWarningView[] {
  const entries = liveCheckoutEntries(sessions, facts)
  const involvesSelected = (group: CheckoutEntry[]): boolean =>
    selectedWs === 'all' || group.some((e) => e.session.project_dir === selectedWs)

  const warnings: CheckoutWarningView[] = []

  for (const group of groupBy(entries, (e) => e.toplevel).values()) {
    if (group.length < 2 || !involvesSelected(group)) continue
    warnings.push({
      kind: 'shared-checkout',
      label: `Shared checkout · ${group.length} panes`,
      entries: group
    })
  }

  for (const group of groupBy(entries, (e) => e.commonDir).values()) {
    const checkouts = new Set(group.map((e) => e.toplevel))
    if (checkouts.size < 2 || !involvesSelected(group)) continue
    warnings.push({
      kind: 'same-repository',
      label: `Same repository · ${otherLabels(group, selectedWs, workspaceName).join(', ')}`,
      entries: group
    })
  }

  return warnings
}
