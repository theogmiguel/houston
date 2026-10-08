import type { SessionCheckout } from '../../houston/generated/SessionCheckout'

export function formatCheckout(
  checkout: SessionCheckout | null | undefined,
  opts?: { remoteHost?: string },
): {
  kind: 'primary' | 'worktree' | 'folder' | 'remote' | 'detached' | 'unknown'
  badge: string
  branch: string | null
  text: string
} {
  if (opts?.remoteHost) {
    return {
      kind: 'remote',
      badge: `remote ${opts.remoteHost}`,
      branch: null,
      text: `remote · ${opts.remoteHost}`,
    }
  }
  if (!checkout) return { kind: 'unknown', badge: 'unknown', branch: null, text: 'unknown' }

  const kind = checkout.kind
  if (kind === 'folder') {
    return { kind: 'folder', badge: 'folder', branch: null, text: 'folder' }
  }

  const worktree = typeof kind === 'object' ? kind.worktree : undefined
  const isWorktree = worktree != null
  const slug = worktree?.slug ?? 'worktree'
  const isPrimary = kind === 'primary'
  if (checkout.branch) {
    const badge = isWorktree ? `wt/${slug}` : isPrimary ? 'primary' : 'unknown'
    return {
      kind: isWorktree ? 'worktree' : isPrimary ? 'primary' : 'unknown',
      badge,
      branch: checkout.branch,
      text: `${badge} · ${checkout.branch}`,
    }
  }

  const sha = checkout.head?.slice(0, 7)
  const badge = `detached${sha ? ` ${sha}` : ''}`
  return {
    kind: 'detached',
    badge,
    branch: null,
    text: `${isWorktree ? `wt/${slug}` : isPrimary ? 'primary' : 'unknown'} · ${badge}`,
  }
}
