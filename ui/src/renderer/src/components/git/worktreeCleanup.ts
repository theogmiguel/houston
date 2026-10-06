import type { ManagedWorktreeInfo } from '../../houston/generated/ManagedWorktreeInfo'
import type { WorktreeKeep } from '../../houston/generated/WorktreeKeep'

export type WorktreeCleanupView =
  | { status: 'pending' }
  | { status: 'refused'; message: string }
  | { status: 'ready'; entries: ManagedWorktreeInfo[] }

const GB = 1_000_000_000
const MB = 1_000_000

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  return `${(bytes / MB).toFixed(1)} MB`
}

export function ageLabel(atMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - atMs) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

function inLabel(untilMs: number, nowMs: number): string {
  const minutes = Math.max(1, Math.ceil((untilMs - nowMs) / 60_000))
  if (minutes < 60) return `${minutes} min`
  return `${Math.ceil(minutes / 60)} h`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function keepLine(keep: WorktreeKeep, nowMs: number): string {
  switch (keep.kind) {
    case 'stale':
      return `Idle ${keep.idle_days} days · removed in ${keep.removal_in_days} days`
    case 'branch_changed':
      return keep.current === null
        ? 'Kept: its HEAD is detached from the branch Houston created'
        : `Kept: switched to ${keep.current}`
    case 'dirty':
      return `Kept: ${plural(keep.files, 'uncommitted file', 'uncommitted files')}`
    case 'ignored_files':
      return `Kept: ${plural(keep.files, 'ignored file', 'ignored files')} removal would delete`
    case 'commits_outside_pr':
      return `Kept: ${plural(keep.count, 'commit', 'commits')} not in PR #${keep.pr}`
    case 'not_integrated':
      return `Kept: ${plural(keep.count, 'commit', 'commits')} not in ${keep.base}`
    case 'pr_head_unavailable':
      return `Kept: the head of PR #${keep.pr} could not be fetched`
    case 'in_use':
      return `Kept: in use by pane ${keep.session}`
    case 'grace':
      return `Kept: merged, removable in ${inLabel(keep.until_ms, nowMs)}`
    case 'not_merged':
      return keep.state === 'CLOSED'
        ? 'Kept: its PR was closed without merging'
        : `Kept: its PR is ${keep.state.toLowerCase()}`
    case 'no_pr':
      return 'Kept: no pull request for this branch'
    case 'gh_unavailable':
      if (keep.gh === 'missing') return 'Kept: gh is not installed, so the PR cannot be checked'
      if (keep.gh === 'unauthenticated') return 'Kept: gh is not signed in, so the PR cannot be checked'
      return 'Kept: gh could not answer; the next check retries'
    case 'probably_integrated':
      return 'Kept: its upstream branch is gone, so it is probably integrated — remove it by hand'
    case 'remove_failed':
      return `Kept: removing it failed: ${keep.message}`
  }
}

export function isRemovable(entry: ManagedWorktreeInfo): boolean {
  return entry.checked_at_ms !== null && entry.status === 'ready' && entry.keep === null
}

export function removablePaths(entries: ManagedWorktreeInfo[]): string[] {
  return entries.filter(isRemovable).map((e) => e.path)
}

export function removableSummary(entries: ManagedWorktreeInfo[]): { count: number; bytes: number } {
  const removable = entries.filter(isRemovable)
  return {
    count: removable.length,
    bytes: removable.reduce((sum, e) => sum + (e.bytes ?? 0), 0)
  }
}

export function cleanupHeader(entries: ManagedWorktreeInfo[]): string {
  const { count, bytes } = removableSummary(entries)
  return `${count} merged · ${formatBytes(bytes)} reclaimable`
}

export function sizeLine(entry: ManagedWorktreeInfo, nowMs: number): string {
  if (entry.bytes === null || entry.measured_at_ms === null) return 'not measured yet'
  return `${formatBytes(entry.bytes)} · measured ${ageLabel(entry.measured_at_ms, nowMs)}`
}

export function statusLine(entry: ManagedWorktreeInfo, nowMs: number): string {
  if (entry.checked_at_ms === null) return 'not checked yet'
  if (entry.status === 'stale' && entry.keep !== null) return keepLine(entry.keep, nowMs)
  if (entry.keep === null) return 'can be removed'
  return keepLine(entry.keep, nowMs)
}

export function cleanNowConfirm(entries: ManagedWorktreeInfo[]): string {
  const removable = entries.filter(isRemovable)
  const { bytes } = removableSummary(entries)
  const paths = removable.map((e) => e.path).join('\n')
  return `Remove ${plural(removable.length, 'worktree', 'worktrees')} and their branches, freeing ${formatBytes(bytes)}?\n${paths}`
}
