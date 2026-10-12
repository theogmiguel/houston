import type { GitBranchInfo } from '../../houston/generated/GitBranchInfo'

export function recentBranches(branches: GitBranchInfo[]): GitBranchInfo[] {
  const rank = (branch: GitBranchInfo): number => branch.current ? 0 : branch.is_default ? 1 : 2
  return [...branches].sort((a, b) => rank(a) - rank(b) || (b.committed_at ?? 0) - (a.committed_at ?? 0) || a.name.localeCompare(b.name))
}

export function branchSyncLabel(branch: GitBranchInfo): string | null {
  const parts = []
  if (branch.ahead) parts.push(`${branch.ahead} ahead`)
  if (branch.behind) parts.push(`${branch.behind} behind`)
  return parts.length ? parts.join(' · ') : null
}

// The daemon caps generated directory segments at 60 characters for nested paths.
const MAX_WORKTREE_SLUG = 60

export function worktreeSlug(name: string): string {
  return [...name].map((character) => /[a-z0-9_-]/i.test(character) ? character.toLowerCase() : '-')
    .join('').slice(0, MAX_WORKTREE_SLUG).replace(/^-+|-+$/g, '') || 'x'
}
