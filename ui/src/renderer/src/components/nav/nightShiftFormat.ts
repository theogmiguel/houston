import type { AgentKind } from '../../houston/generated/AgentKind'
import type { NightClock } from '../../houston/generated/NightClock'
import type { NightEntry } from '../../houston/generated/NightEntry'
import type { NightFocus } from '../../houston/generated/NightFocus'
import type { NightRun } from '../../houston/generated/NightRun'
import type { NightShiftSettings } from '../../houston/generated/NightShiftSettings'
import type { NightStopReason } from '../../houston/generated/NightStopReason'
import type { NightWindow } from '../../houston/generated/NightWindow'
import type { WindowMark } from '../ui'
import { engineLabel } from '../engineLabel'

export const FOCUS_AREAS: { key: keyof NightFocus; label: string }[] = [
  { key: 'reliability', label: 'Reliability' },
  { key: 'performance', label: 'Performance' },
  { key: 'ui_polish', label: 'UI and UX polish' },
  { key: 'competitor_gaps', label: 'Competitor gaps' },
  { key: 'platform_parity', label: 'Platform parity' },
  { key: 'docs_accuracy', label: 'Docs accuracy' },
  { key: 'test_gaps', label: 'Test gaps' }
]

export const NIGHTS: { day: number; label: string }[] = [
  { day: 2, label: 'Mon' }, { day: 3, label: 'Tue' }, { day: 4, label: 'Wed' }, { day: 5, label: 'Thu' },
  { day: 6, label: 'Fri' }, { day: 7, label: 'Sat' }, { day: 1, label: 'Sun' }
]

/** Providers that never report a usage limit cannot be workers. */
export const NO_LIMIT_SIGNAL: AgentKind[] = ['cursor', 'antigravity', 'grok']
export const WORKER_PROVIDERS: AgentKind[] = ['claude', 'codex', 'opencode', 'zcode']

export function clockLabel(c: NightClock): string {
  return `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`
}

export function parseClock(text: string): NightClock | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  return hour < 24 && minute < 60 ? { hour, minute } : null
}

function minuteOf(c: NightClock): number {
  return c.hour * 60 + c.minute
}

/** Minutes from `from` forward to `to`; a full day when equal. */
export function minutesBetween(from: NightClock, to: NightClock): number {
  const d = (minuteOf(to) - minuteOf(from) + 1440) % 1440
  return d === 0 ? 1440 : d
}

export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** The settings' window as strip marks. */
export function windowMarks(w: NightWindow): WindowMark[] {
  const total = minutesBetween(w.start, w.hard_stop)
  return [
    { at: 0, label: clockLabel(w.start), kind: 'start' },
    { at: minutesBetween(w.start, w.wrap_up) / total, label: `Wrap-up ${clockLabel(w.wrap_up)}`, kind: 'wrap-up' },
    { at: 1, label: clockLabel(w.hard_stop), kind: 'hard-stop' }
  ]
}

export function timeOfDay(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A run's own window as strip marks, interruptions included. */
export function runMarks(run: NightRun): WindowMark[] {
  const span = Math.max(1, run.hard_stop_at_ms - run.started_at_ms)
  const at = (ms: number): number => (ms - run.started_at_ms) / span
  return [
    { at: 0, label: timeOfDay(run.started_at_ms), kind: 'start' },
    ...run.interruptions.map((i) => ({ at: at(i.at_ms), label: `Interrupted at ${timeOfDay(i.at_ms)}`, kind: 'interruption' as const })),
    { at: at(run.wrap_up_at_ms), label: `Wrap-up ${timeOfDay(run.wrap_up_at_ms)}`, kind: 'wrap-up' },
    { at: 1, label: timeOfDay(run.hard_stop_at_ms), kind: 'hard-stop' }
  ]
}

export function countdownLabel(untilMs: number, now: number): string {
  const left = Math.max(0, untilMs - now)
  const minutes = Math.floor(left / 60_000)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`
}

export function agentLabel(provider: AgentKind, model?: string | null): string {
  return model ? `${engineLabel(provider)} ${model}` : engineLabel(provider)
}

/** What blocks merge queue output, by setting name; empty when it may be chosen. */
export function mergeRefusal(s: NightShiftSettings, verifyCommand: boolean | null): string | null {
  if (s.output !== 'merge_queue') return null
  const missing: string[] = []
  if (verifyCommand === false) missing.push('a merge queue verification command for this workspace')
  if (!s.app_check || !s.app_check.start_command.trim()) missing.push('an App check')
  return missing.length ? `Merge queue output needs ${missing.join(' and ')}. Set them first, or keep pull requests only.` : null
}

/** The setup's own refusals, before the daemon is asked. */
export function settingsProblems(s: NightShiftSettings): string[] {
  const out: string[] = []
  const total = minutesBetween(s.window.start, s.window.hard_stop)
  if (total > 16 * 60) out.push(`The window lasts ${durationLabel(total)}; the limit is 16 h.`)
  if (minutesBetween(s.window.start, s.window.wrap_up) >= total) out.push(`Wrap-up ${clockLabel(s.window.wrap_up)} is not before the hard stop ${clockLabel(s.window.hard_stop)}.`)
  if (s.enabled && s.window.nights.length === 0) out.push('Choose at least one night to turn Night shift on.')
  for (const w of s.workers) {
    if (NO_LIMIT_SIGNAL.includes(w.provider)) out.push(`${engineLabel(w.provider)} cannot be a worker: it reports no usage limit.`)
  }
  if (s.focus.competitor_gaps !== 'off' && s.competitor_sources.length === 0) out.push('Competitor gaps needs at least one competitor source.')
  return out
}

/** The options a parked decision listed, from its body's last line. */
export function decisionOptions(entry: NightEntry): string[] {
  const line = entry.body.split('\n').reverse().find((l) => l.startsWith('Options: '))
  return line ? line.slice('Options: '.length).split(' | ').map((o) => o.trim()).filter(Boolean) : []
}

export function decisionText(entry: NightEntry): string {
  return entry.body.split('\n').filter((l) => !l.startsWith('Options: ')).join('\n').trim()
}

export function headline(run: NightRun): string {
  const prs = run.entries.filter((e) => e.kind === 'pr').length
  const open = run.entries.filter((e) => e.kind === 'decision' && !e.choice).length
  const n = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`
  return `${n(prs, 'PR', 'PRs')}, ${n(open, 'decision', 'decisions')}`
}

export const STOP_REASON: Record<NightStopReason, string> = {
  report: 'Report published',
  hard_stop: 'Hard stop',
  safety_cap: 'Safety cap reached',
  stopped: 'Stopped by you',
  pane_exited: 'Orchestrator exited',
  restart: 'Settled after a restart'
}

/** PR entries grouped by theme, in first-seen order. */
export function prShelves(run: NightRun): { theme: string; prs: NightEntry[] }[] {
  const shelves = new Map<string, NightEntry[]>()
  for (const e of run.entries) {
    if (e.kind !== 'pr') continue
    const theme = e.theme?.trim() || 'Other'
    shelves.set(theme, [...(shelves.get(theme) ?? []), e])
  }
  return [...shelves.entries()].map(([theme, prs]) => ({ theme, prs }))
}
