import type { AgentKind } from '../../houston/generated/AgentKind'
import type { Cadence } from '../../houston/generated/Cadence'
import type { HarnessFinding } from '../../houston/generated/HarnessFinding'
import type { HarnessFindingState } from '../../houston/generated/HarnessFindingState'
import type { HarnessReviewStatus } from '../../houston/generated/HarnessReviewStatus'
import type { Routine } from '../../houston/generated/Routine'
import { formatCadence } from './routineFormat'

/** The providers Houston can launch a review run with. */
export const HARNESS_ENGINES: AgentKind[] = ['claude', 'codex', 'antigravity', 'opencode', 'cursor', 'grok', 'zcode']

export type HarnessSchedule = 'off' | 'weekly' | 'daily' | 'custom'

/** Mondays 09:00; `Cadence` counts weekdays from 1 = Sunday. */
const WEEKLY: Cadence = { type: 'clock', hour: 9, minute: 0, weekdays: [2] }
const DAILY: Cadence = { type: 'clock', hour: 9, minute: 0, weekdays: null }

export const SCHEDULE_OPTIONS: {
  value: Exclude<HarnessSchedule, 'custom'>
  label: string
}[] = [
  { value: 'off', label: 'Only when I run it' },
  { value: 'weekly', label: 'Mondays 09:00' },
  { value: 'daily', label: 'Daily 09:00' }
]

function sameCadence(a: Cadence, b: Cadence): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function scheduleOf(routine: Routine): HarnessSchedule {
  if (!routine.enabled) return 'off'
  if (sameCadence(routine.cadence, WEEKLY)) return 'weekly'
  if (sameCadence(routine.cadence, DAILY)) return 'daily'
  return 'custom'
}

export function scheduleLabel(routine: Routine): string {
  const schedule = scheduleOf(routine)
  if (schedule === 'custom') return `Runs ${formatCadence(routine.cadence)}`
  return SCHEDULE_OPTIONS.find((o) => o.value === schedule)?.label ?? ''
}

/** The cadence and switch a schedule choice writes; `off` keeps the cadence it had. */
export function scheduleFields(
  schedule: Exclude<HarnessSchedule, 'custom'>,
  current: Cadence | null
): { cadence: Cadence; enabled: boolean } {
  if (schedule === 'weekly') return { cadence: WEEKLY, enabled: true }
  if (schedule === 'daily') return { cadence: DAILY, enabled: true }
  return { cadence: current ?? WEEKLY, enabled: false }
}

export const REVIEW_STATUS_LABEL: Record<HarnessReviewStatus, string> = {
  running: 'Running',
  published: 'Published',
  failed: 'Failed'
}

export const FINDING_STATE_LABEL: Record<HarnessFindingState, string> = {
  open: 'Open',
  dismissed: 'Dismissed',
  resolved: 'Resolved'
}

export function countByState(findings: HarnessFinding[]): Record<HarnessFindingState, number> {
  const counts: Record<HarnessFindingState, number> = {
    open: 0,
    dismissed: 0,
    resolved: 0
  }
  for (const f of findings) counts[f.state] += 1
  return counts
}

export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

export function formatHarnessDate(ms: number, includeTime = false, now = Date.now()): string {
  const date = new Date(ms)
  if (includeTime) {
    return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
  }
  const today = new Date(now)
  const dateDay = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const todayDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  const daysAgo = (todayDay - dateDay) / 86_400_000
  return daysAgo >= 0 && daysAgo < 6
    ? date.toLocaleDateString('en-US', { weekday: 'short' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function formatWindow(window: [string, string] | null | undefined): string {
  return window ? `${window[0]} to ${window[1]}` : 'Window not reported'
}

/** Joins a workspace-relative target onto the workspace; an absolute one stays. */
export function targetPath(workspace: string, target: string): string {
  if (/^([/\\]|[A-Za-z]:[/\\])/.test(target)) return target
  return `${workspace.replace(/[/\\]+$/, '')}/${target.replace(/^\.[/\\]/, '')}`
}
