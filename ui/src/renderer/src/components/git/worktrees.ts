import type { GitWorktreeInfo } from '../../houston/generated/GitWorktreeInfo'

export function shortSha(sha: string | null | undefined): string {
  if (!sha) return ''
  return sha.slice(0, 7)
}

export function worktreeTitle(w: GitWorktreeInfo): string {
  if (w.branch) return w.branch
  if (w.is_detached) return `detached @ ${shortSha(w.head)}`
  return w.path.split('/').filter(Boolean).pop() ?? w.path
}

export function worktreeSubtitle(w: GitWorktreeInfo): string {
  const parts: string[] = [w.path]
  if (w.is_main) parts.push('main checkout')
  if (w.is_bare) parts.push('bare')
  if (w.dirty) parts.push('uncommitted changes')
  if (w.head && w.is_detached) parts.push(shortSha(w.head))
  return parts.join(' · ')
}

// The daemon refuses these too; this only disables the control so the pane can
// say why before a round trip.
export function worktreeActionDisabledReason(w: GitWorktreeInfo): string | null {
  if (w.is_main) return 'The main checkout cannot be removed from here'
  if (w.is_bare) return 'A bare repository has no working tree to remove'
  return null
}

export function worktreeRemoveConfirm(w: GitWorktreeInfo, force: boolean): string {
  const name = worktreeTitle(w)
  if (force) {
    return `Force-remove the worktree "${name}" at ${w.path}? Uncommitted changes there are lost. The branch itself is kept.`
  }
  return `Remove the worktree "${name}" at ${w.path}? The branch itself is kept.`
}

export function worktreeRemoveLabel(force: boolean): string {
  return force ? 'Force remove' : 'Remove worktree'
}

export function worktreePathName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.split('/').filter(Boolean).pop() ?? trimmed
}
