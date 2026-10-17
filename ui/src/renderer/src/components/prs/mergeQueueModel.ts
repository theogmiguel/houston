import type { MergeQueueEntry, MergeQueueGate, MergeQueueGateKind, MergeQueueMerge } from '../../houston/client'
import type { MergeQueueGateItem } from '../ui/MergeQueue'
import type { StatusLabelValue } from '../ui/StatusLabel'

const GATE_LABEL: Record<MergeQueueGateKind, string> = {
  mergeable: 'Mergeable',
  review_threads: 'No unresolved review threads',
  reviewer: 'Reviewer passed'
}

export function entryStatus(entry: MergeQueueEntry): StatusLabelValue {
  return entry.status === 'ready' ? 'Ready' : 'Blocked'
}

export function gateItems(gates: readonly MergeQueueGate[]): MergeQueueGateItem[] {
  return gates.map((gate) => ({
    label: GATE_LABEL[gate.kind],
    state: gate.state,
    reason: gate.state === 'not_applicable' ? 'Not a task Slice' : gate.reason ?? null
  }))
}

export function ordinal(n: number): string {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${suffix}`
}

/** The one line under a row: what blocks it, or where it stands when nothing does. */
export function entryLine(entry: MergeQueueEntry, previous: MergeQueueEntry | undefined): string {
  if (entry.reason) return entry.reason
  if (entry.position === 1) return 'First in line, ready to merge'
  if (entry.depends_on != null) return `Merges after #${entry.depends_on}, which it depends on`
  return previous ? `Merges after #${previous.number}` : 'Ready to merge'
}

export function queueEntryFor(entries: readonly MergeQueueEntry[], repository: string, number: number): MergeQueueEntry | null {
  return entries.find((entry) => entry.number === number && entry.repository.toLowerCase() === repository.toLowerCase()) ?? null
}

export function mergedToday(merged: readonly MergeQueueMerge[], now: number): MergeQueueMerge[] {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return merged.filter((merge) => merge.merged_at_ms >= start.getTime())
}

export function clockTime(ms: number): string {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}
