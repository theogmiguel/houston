import type { GitCheckpointInfo } from '../../houston/generated/GitCheckpointInfo'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatAge(createdMs: number | null | undefined, now: number): string {
  if (createdMs === null || createdMs === undefined || createdMs <= 0) return 'unknown time'
  const delta = now - createdMs
  if (delta < MINUTE) return 'just now'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} min ago`
  if (delta < DAY) return `${Math.floor(delta / HOUR)} h ago`
  return `${Math.floor(delta / DAY)} d ago`
}

export function checkpointOwnerLabel(owner: string): string {
  if (owner === 'manual') return 'manual'
  if (owner.startsWith('session_')) return `session ${owner.slice('session_'.length)}`
  return owner
}

export function checkpointTitle(c: GitCheckpointInfo): string {
  return c.label
}

export function checkpointSubtitle(c: GitCheckpointInfo, now: number): string {
  const parts = [checkpointOwnerLabel(c.owner), formatAge(c.created_ms, now)]
  parts.push(c.sha.slice(0, 7))
  return parts.join(' · ')
}

export function checkpointRestoreConfirm(c: GitCheckpointInfo): string {
  return (
    `Restore "${c.label}"? This replaces the current files and staging with the snapshot ` +
    `from ${checkpointOwnerLabel(c.owner)}. Commits are not moved, and anything newer than ` +
    `the snapshot is lost unless it is committed.`
  )
}

export function checkpointDeleteConfirm(c: GitCheckpointInfo): string {
  return `Delete checkpoint "${c.label}"? The snapshot is removed; the files it captured are not touched.`
}

/// A label a person can tell apart in the list without typing one.
export function defaultCheckpointLabel(now: number): string {
  const d = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `manual ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`
}
