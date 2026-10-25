import type { MergeQueueEntry, MergeQueueGate, MergeQueueGateKind, MergeQueueHandOffInfo, MergeQueueLogEntry, MergeQueueLogKind, MergeQueueSettings, MergeQueueStatus } from '../../houston/client'
import type { MergeQueueGateItem } from '../ui/MergeQueue'
import type { StatusLabelValue } from '../ui/StatusLabel'

const GATE_LABEL: Record<MergeQueueGateKind, string> = {
  mergeable: 'Mergeable',
  review_threads: 'No unresolved review threads',
  reviewer: 'Reviewer passed',
  verification: 'Verification'
}

const STATUS_WORD: Record<MergeQueueStatus, StatusLabelValue> = {
  ready: 'Ready',
  blocked: 'Blocked',
  verifying: 'Verifying',
  waiting_for_slot: 'Waiting for a slot',
  fixing: 'Fixing',
  parked: 'Parked',
  paused: 'Paused',
  watching: 'Watching'
}

const LOG_WORD: Record<MergeQueueLogKind, StatusLabelValue> = {
  push: 'Done',
  merge: 'Merged',
  park: 'Parked',
  restack: 'Done',
  retarget: 'Done',
  hand_off: 'Watching'
}

export function logStatus(row: MergeQueueLogEntry): StatusLabelValue {
  return LOG_WORD[row.kind]
}

export function entryStatus(entry: MergeQueueEntry): StatusLabelValue {
  return STATUS_WORD[entry.status]
}

export function gateItems(gates: readonly MergeQueueGate[]): MergeQueueGateItem[] {
  return gates.map((gate) => ({
    label: GATE_LABEL[gate.kind],
    state: gate.state,
    reason: gate.state === 'not_applicable' && gate.kind === 'reviewer' ? 'Not a task Slice' : gate.reason ?? null
  }))
}

export function ordinal(n: number): string {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${suffix}`
}

/** `4m 12s`: minutes and seconds, the way the head row counts a run. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
}

/** The entry that goes next, as the daemon picks it: the first ranked entry that is not blocked. */
export function nextUp(entries: readonly MergeQueueEntry[]): MergeQueueEntry | null {
  return entries.find((e) => e.position > 0 && e.status !== 'blocked') ?? null
}

/** The nearest ranked entry ahead of `entry` that goes before it; blocked ones are passed over. */
export function goesAfter(entries: readonly MergeQueueEntry[], entry: MergeQueueEntry): MergeQueueEntry | null {
  return entries.filter((e) => e.position > 0 && e.position < entry.position && e.status !== 'blocked').at(-1) ?? null
}

/** The one line under a row: what blocks it, or where it stands when nothing does. */
export function entryLine(entry: MergeQueueEntry, previous: MergeQueueEntry | null, next: boolean, settings: MergeQueueSettings | null = null, now = Date.now()): string {
  if (entry.status === 'verifying') {
    const base = entry.base_ref ?? 'its base'
    const running = entry.verifying_since_ms != null ? elapsed(now - entry.verifying_since_ms) : '0s'
    const limit = settings ? ` of ${settings.time_limit_minutes}m` : ''
    return `${running}${limit} · rebased on ${base}`
  }
  if (entry.status === 'waiting_for_slot') return 'Verifies once the slot on this machine is free'
  if (entry.status === 'fixing') return `Handed to its pane: ${entry.reason ?? 'verification failed'}`
  if (entry.reason) return entry.reason
  if (next) {
    const v = entry.verification
    if (v?.fork_sha) return `Restacked after #${v.stacked_on ?? '?'} · verified on ${v.base_ref}@${shortSha(v.base_sha)}`
    if (v) return `Verified on ${v.base_ref}@${shortSha(v.base_sha)}`
    return 'Next in line, ready to merge'
  }
  if (entry.depends_on != null) return `Merges after #${entry.depends_on}, which it depends on`
  return previous ? `Merges after #${previous.number}` : 'Ready to merge'
}

export function queueEntryFor(entries: readonly MergeQueueEntry[], repository: string, number: number): MergeQueueEntry | null {
  return entries.find((entry) => entry.number === number && entry.repository.toLowerCase() === repository.toLowerCase()) ?? null
}

/** Entries in line, ranked, then the unranked ones held behind a parked entry or being fixed. */
export function inLine(entries: readonly MergeQueueEntry[]): MergeQueueEntry[] {
  return [...entries.filter((e) => e.position > 0), ...entries.filter((e) => e.position === 0 && e.status !== 'parked')]
}

export function parked(entries: readonly MergeQueueEntry[]): MergeQueueEntry[] {
  return entries.filter((e) => e.status === 'parked')
}

export function loggedToday(log: readonly MergeQueueLogEntry[], now: number): MergeQueueLogEntry[] {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return log.filter((row) => row.at_ms >= start.getTime() && row.kind !== 'push')
}

/** One history line: what happened to the base or the branch, or why the entry parked. */
export function logLine(row: MergeQueueLogEntry): string {
  if (row.kind === 'park') return `Parked. ${row.detail ?? 'Verification failed'}`
  if (row.kind === 'push') return `Pushed ${shortSha(row.new_sha ?? '')} to ${row.ref_name ?? 'its branch'} over ${shortSha(row.old_sha ?? '')}`
  if (row.kind === 'restack') return `Restacked ${row.ref_name ?? 'its branch'} onto the base after ${shortSha(row.fork_sha ?? '')}: ${shortSha(row.old_sha ?? '')} → ${shortSha(row.new_sha ?? '')}`
  if (row.kind === 'retarget') return `${row.detail ?? 'Retargeted'} to ${row.ref_name ?? 'the base'}`
  if (row.kind === 'hand_off') return `${row.detail ?? 'Handed to GitHub'} at ${shortSha(row.head_sha ?? '')}`
  const into = row.ref_name ?? 'its base'
  const merged = row.new_sha ? `Merged into ${into}@${shortSha(row.new_sha)}` : `Merged into ${into}`
  return row.detail?.startsWith('Merged by ') ? `${merged} ${row.detail.slice('Merged '.length)}` : merged
}

const HAND_OFF_LINE: Record<MergeQueueHandOffInfo['mode'], string | null> = {
  houston: null,
  merge_queue: "Hands off to GitHub's merge queue",
  auto_merge: "Hands off to GitHub's auto-merge"
}

/** The policy line above the queue: what the queue does on its own, with which
 *  command, and whether GitHub's merge queue or auto-merge merges in the end. */
export function policyLine(settings: MergeQueueSettings | null, handOff: MergeQueueHandOffInfo | null = null): string {
  const command = settings?.verification_command.trim() ?? ''
  const github = handOff ? HAND_OFF_LINE[handOff.mode] : null
  const tail = github ? ` · ${github}${handOff?.base_ref ? ` on ${handOff.base_ref}` : ''}` : ''
  if (!settings || command === '') return `You merge the head · no verification command is set${tail}`
  const mode = settings.merge_when_verified ? 'Merges when verified' : 'Verifies; you merge the head'
  return `${mode} · ${command} · one at a time on this machine${tail}`
}

export function clockTime(ms: number): string {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** The prompt of a pane the user hands a failure to: the failure, then what to do. */
export function handOffPrompt(entry: MergeQueueEntry): string {
  const failure = entry.failure
  const lines = [`The merge queue took PR #${entry.number} (${entry.head_ref}) out of line: ${failure?.message ?? entry.reason ?? 'verification failed'}.`]
  if (failure && failure.files.length > 0) lines.push('', 'Conflicting files:', ...failure.files.map((file) => `- ${file}`))
  if (failure?.output_tail) lines.push('', 'Last lines of the output:', '```', failure.output_tail, '```')
  lines.push('', `Rebase ${entry.head_ref} onto ${entry.base_ref ?? 'its base'}, fix this, and push. The queue takes the new head back in line on its own.`)
  return lines.join('\n')
}
