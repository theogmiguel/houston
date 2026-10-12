import type { GitBranchInfo } from '../../houston/generated/GitBranchInfo'

export function recentBranches(branches: GitBranchInfo[]): GitBranchInfo[] {
  const rank = (branch: GitBranchInfo): number => branch.current ? 0 : 1
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

export function branchAgeLabel(committedAt: number | null | undefined, now = Date.now()): string | null {
  if (committedAt == null) return null
  const minutes = Math.max(0, Math.floor((now / 1000 - committedAt) / 60))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function branchMetaLabel(branch: GitBranchInfo): string | null {
  return [branch.is_default ? 'default' : null, branchSyncLabel(branch), branchAgeLabel(branch.committed_at)].filter(Boolean).join(' · ') || null
}
