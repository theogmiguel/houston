import type { GitWorktreeInfo } from '../../houston/generated/GitWorktreeInfo'
import type { WorktreeCheckPart } from '../../houston/generated/WorktreeCheckPart'
import type { WorktreeCheckResult } from '../../houston/generated/WorktreeCheckResult'
import { ageLabel } from './worktreeCleanup'

export type WorktreeCheckView =
  | { path: string; status: 'pending' }
  | { path: string; status: 'ready'; check: WorktreeCheckResult }

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

const CHECK_PART_LABEL: Record<WorktreeCheckPart, string> = {
  changes: 'uncommitted changes',
  commits: 'commits ahead of the base',
  unpushed: 'unpushed commits'
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// What the delete confirm lists before the checkout leaves the disk. A part the
// daemon could not look at is a finding too, never silence.
export function worktreeCheckFindings(check: WorktreeCheckResult, nowMs: number): string[] {
  const lines: string[] = []
  if (check.dirty_files) {
    const files = count(check.dirty_files, 'uncommitted file', 'uncommitted files')
    lines.push(
      check.newest_change_ms === null
        ? files
        : `${files}, the newest changed ${ageLabel(check.newest_change_ms, nowMs)}`
    )
  }
  if (check.ahead) {
    lines.push(`${count(check.ahead, 'commit', 'commits')} not on ${check.base ?? 'the base'}`)
  }
  if (check.unpushed) {
    lines.push(`${count(check.unpushed, 'commit', 'commits')} not pushed to any remote`)
  }
  if (check.panes.length > 0) {
    const names = check.panes.map((p) => `${p.title} (#${p.session})`).join(', ')
    lines.push(`${count(check.panes.length, 'pane', 'panes')} working here: ${names}`)
  }
  for (const gap of check.gaps) {
    lines.push(`Could not check ${CHECK_PART_LABEL[gap.part]}: ${gap.reason}`)
  }
  return lines
}

export function worktreeRemoveLabel(force: boolean): string {
  return force ? 'Force remove' : 'Remove worktree'
}

export function worktreePathName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.split('/').filter(Boolean).pop() ?? trimmed
}
