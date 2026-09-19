import type { GitBranchInfo } from '../../houston/generated/GitBranchInfo'

// The daemon caps each listing at 200 (T3's own limit); the menu filters what
// it was given, so the cap is a display fact, not a second cap.
export const BRANCH_MENU_LIMIT = 200

export interface BranchRow {
  branch: GitBranchInfo
  title: string
  note: string | null
  remote: boolean
}

export function branchTitle(b: GitBranchInfo): string {
  if (!b.is_remote) return b.name
  const remote = b.remote_name
  return remote && b.name.startsWith(`${remote}/`) ? b.name.slice(remote.length + 1) : b.name
}

export function branchNote(b: GitBranchInfo): string | null {
  const parts: string[] = []
  if (b.is_remote) {
    const shown = branchTitle(b)
    if (shown !== b.name) parts.push(b.name)
  }
  if (b.upstream && b.upstream !== b.name) parts.push(`tracks ${b.upstream}`)
  if (b.worktree_path) parts.push(`checked out at ${b.worktree_path}`)
  if (b.is_default) parts.push('default')
  return parts.length > 0 ? parts.join(' · ') : null
}

export function filterBranches(branches: GitBranchInfo[], query: string): BranchRow[] {
  const q = query.trim().toLowerCase()
  const rows: BranchRow[] = []
  for (const b of branches) {
    if (rows.length >= BRANCH_MENU_LIMIT) break
    if (q.length > 0 && !b.name.toLowerCase().includes(q)) continue
    rows.push({ branch: b, title: branchTitle(b), note: branchNote(b), remote: b.is_remote })
  }
  return rows
}

export function branchSortKey(b: GitBranchInfo): [number, number, string] {
  const rank = b.current ? 0 : b.is_default ? 1 : b.is_remote ? 3 : 2
  const worktree = b.worktree_path ? 0 : 1
  return [rank, worktree, b.name]
}

export function sortBranches(branches: GitBranchInfo[]): GitBranchInfo[] {
  return [...branches].sort((a, b) => {
    const ka = branchSortKey(a)
    const kb = branchSortKey(b)
    if (ka[0] !== kb[0]) return ka[0] - kb[0]
    if (ka[1] !== kb[1]) return ka[1] - kb[1]
    return ka[2].localeCompare(kb[2])
  })
}

export function switchBranchDisabledReason(b: GitBranchInfo): string | null {
  if (b.current) return 'This is the branch already checked out'
  return null
}

export function deleteBranchDisabledReason(
  b: GitBranchInfo,
  branchCount: number
): string | null {
  if (b.is_remote) return 'Remote branches are deleted on the remote, not here'
  if (b.current) return 'The checked-out branch cannot be deleted'
  if (b.worktree_path) return 'This branch is checked out in a worktree — remove that worktree first'
  if (branchCount <= 1) return 'The last branch in the repository cannot be deleted'
  return null
}

/// A cheap shape check so the Create button can disable without a round trip;
/// the daemon still runs `git check-ref-format` and owns the refusal.
export function nameShapeLooksValid(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length === 0) return false
  if (trimmed.startsWith('-')) return false
  if (/\s/.test(trimmed)) return false
  return true
}

export function renameTargetLooksValid(from: string, to: string): boolean {
  return nameShapeLooksValid(to) && to.trim() !== from
}
