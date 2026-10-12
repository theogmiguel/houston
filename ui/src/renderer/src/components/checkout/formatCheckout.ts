import type { SessionCheckout } from '../../houston/generated/SessionCheckout'
import type { SessionInfo } from '../../houston/client'

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

// The directory whose git facts describe the checkout a session runs in. Rail fetching and
// rail/popover reads must share it, or a card looks up a key that was never polled.
export function sessionCheckoutRoot(session: Pick<SessionInfo, 'cwd' | 'checkout_root' | 'worktree' | 'checkout'>): string {
  return session.checkout?.root ?? session.worktree?.path ?? session.checkout_root ?? session.cwd
}

// Shortens a path under the user's home directory to `~`. The renderer does not know the
// home directory, so the common `/home/<user>`, `/Users/<user>` and `C:\Users\<user>` shapes are matched.
export function tildePath(path: string): string {
  return path.replace(/^(?:\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/, '~')
}
