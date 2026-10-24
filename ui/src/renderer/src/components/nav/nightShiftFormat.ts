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

/** Each area with the one-line definition the brief gives the orchestrator (`brief.rs::focus_areas`). */
export const FOCUS_AREAS: { key: keyof NightFocus; label: string; definition: string }[] = [
  { key: 'reliability', label: 'Reliability', definition: 'Crashes, hangs, lost state, error handling and recovery paths.' },
  { key: 'performance', label: 'Performance', definition: 'Startup, memory, CPU and latency, measured before and after.' },
  { key: 'ui_polish', label: 'UI and UX polish', definition: 'Rough edges you can see: layout, wording, states, keyboard and focus.' },
  { key: 'competitor_gaps', label: 'Competitor gaps', definition: 'Things the competitors listed below do that this project does not.' },
  { key: 'docs_accuracy', label: 'Docs accuracy', definition: 'Docs that say something the code does not do.' },
  { key: 'test_gaps', label: 'Test gaps', definition: 'Important paths no test covers.' }
]

/** Direction words that suggest a focus area, in English and Portuguese. */
const DIRECTION_HINTS: Record<keyof NightFocus, RegExp> = {
  reliability: /crash|stab|reliab|hang|freez|lost|lose|break|bug|error|trav|est[aá]v|confi[aá]v|perd/i,
  performance: /fast|slow|speed|perf|lag|memory|cpu|startup|r[aá]pid|lent|desempenho|mem[oó]ria/i,
  ui_polish: /look|ui|ux|design|polish|screen|visual|layout|beaut|bonit|tela|interface/i,
  competitor_gaps: /compet|rival|catch up|alcan|concorr/i,
  docs_accuracy: /doc|guide|readme|manual/i,
  test_gaps: /test|coverage|cobertura/i
}

/** Focus areas the Direction suggests: a matching area goes High, the others Off while any
 * matches; with no match or no text, an area keeps `base`. Areas in `touched` (changed by
 * hand) are never overwritten. */
export function suggestFocus(direction: string, base: NightFocus, current: NightFocus, touched: ReadonlySet<keyof NightFocus>): { focus: NightFocus; suggested: boolean } {
  const text = direction.trim()
  const keys = Object.keys(DIRECTION_HINTS) as (keyof NightFocus)[]
  const hits = new Set(text ? keys.filter((k) => DIRECTION_HINTS[k].test(text)) : [])
  const focus = { ...current }
  for (const k of keys) {
    if (touched.has(k)) continue
    focus[k] = hits.size === 0 ? base[k] : hits.has(k) ? 'high' : 'off'
  }
  return { focus, suggested: [...hits].some((k) => !touched.has(k)) }
}

export const NIGHTS: { day: number; label: string }[] = [
  { day: 2, label: 'Mon' }, { day: 3, label: 'Tue' }, { day: 4, label: 'Wed' }, { day: 5, label: 'Thu' },
  { day: 6, label: 'Fri' }, { day: 7, label: 'Sat' }, { day: 1, label: 'Sun' }
]

/** Providers that never report a usage limit cannot be workers. */
export const NO_LIMIT_SIGNAL: AgentKind[] = ['cursor', 'antigravity', 'grok']
export const WORKER_PROVIDERS: AgentKind[] = ['claude', 'codex', 'opencode', 'zcode']
/** The orchestrator watches its pull requests' CI; a pull request watch cannot wake ZCode. */
export const ORCHESTRATOR_PROVIDERS: AgentKind[] = ['claude', 'codex', 'opencode']
export const ZCODE_ORCHESTRATOR_REFUSAL = 'ZCode cannot orchestrate: a pull request watch cannot wake it, so the CI stage would be off.'

/** The run's own pane limit, shown only when it is above the global child panes per agent. */
export function ownLimitNote(liveWorkers: number, childCap: number): string | null {
  const own = liveWorkers + 2
  return own > childCap ? `Own limit: ${own} panes · other agents keep ${childCap}` : null
}

/** The source of a check the user typed (`settings.rs::ADDED_BY_YOU`). */
export const ADDED_BY_YOU = 'added by you'

export const UI_POLISH_SCREENSHOTS = 'UI and UX polish needs screenshots: its changes are visible.'

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

/** App QA runs: it is on and knows how to start the app (`settings.rs::app_qa_on`). */
export function appQaOn(s: NightShiftSettings): boolean {
  return s.app_qa.enabled && s.app_qa.start_command.trim() !== ''
}

/** What blocks merge queue output, by setting name; empty when it may be chosen. */
export function mergeRefusal(s: NightShiftSettings, verifyCommand: boolean | null): string | null {
  if (s.output !== 'merge_queue') return null
  const missing: string[] = []
  if (verifyCommand === false) missing.push('a merge queue verification command for this workspace')
  if (!appQaOn(s)) missing.push('App QA on with a start command')
  return missing.length ? `Merge queue output needs ${missing.join(' and ')}. Set them first, or keep pull requests only.` : null
}

/** The setup's own refusals, before the daemon is asked. */
export function settingsProblems(s: NightShiftSettings): string[] {
  const out: string[] = []
  const total = minutesBetween(s.window.start, s.window.hard_stop)
  if (total > 16 * 60) out.push(`The window lasts ${durationLabel(total)}; the limit is 16 h.`)
  if (minutesBetween(s.window.start, s.window.wrap_up) >= total) out.push(`Wrap-up ${clockLabel(s.window.wrap_up)} is not before the hard stop ${clockLabel(s.window.hard_stop)}.`)
  if (s.enabled && s.window.nights.length === 0) out.push('Choose at least one night to turn Night shift on.')
  if (s.orchestrator.provider === 'zcode') out.push(ZCODE_ORCHESTRATOR_REFUSAL)
  for (const w of s.workers) {
    if (NO_LIMIT_SIGNAL.includes(w.provider)) out.push(`${engineLabel(w.provider)} cannot be a worker: it reports no usage limit.`)
  }
  if (s.focus.ui_polish !== 'off' && !s.screenshots) out.push(UI_POLISH_SCREENSHOTS)
  if (s.focus.competitor_gaps !== 'off' && s.competitor_sources.length === 0) out.push('Competitor gaps needs at least one competitor source.')
  return out
}

/** What spawns of a limited provider become, as the daemon picks it: the next
 * unlimited worker after it in the chain, or null when every one is limited. */
export function substituteFor(provider: AgentKind, workers: AgentKind[], limited: AgentKind[]): AgentKind | null {
  const start = Math.max(0, workers.indexOf(provider))
  for (let i = 0; i < workers.length; i++) {
    const next = workers[(start + i) % workers.length]
    if (!limited.includes(next)) return next
  }
  return null
}

/** One limited provider's consequence, in the present (live) or past (report). */
export function limitNote(provider: AgentKind, workers: AgentKind[], limited: AgentKind[], past = false): string {
  const name = engineLabel(provider)
  const next = substituteFor(provider, workers, limited)
  if (next) return past ? `Later ${name} spawns used ${engineLabel(next)}.` : `${name} spawns use ${engineLabel(next)}.`
  return past
    ? `Later ${name} spawns were refused: no other worker provider was available.`
    : `${name} spawns are refused: no other worker provider is available.`
}

/** The options a parked decision listed, from its body's last line. */
export function decisionOptions(entry: NightEntry): string[] {
  const line = entry.body.split('\n').reverse().find((l) => l.startsWith('Options: '))
  return line ? line.slice('Options: '.length).split(' | ').map((o) => o.trim()).filter(Boolean) : []
}

export function decisionText(entry: NightEntry): string {
  return entry.body.split('\n').filter((l) => !l.startsWith('Options: ')).join('\n').trim()
}

export function countLabel(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Answered decisions stay listed, so the count says it is of open ones. */
export function headline(run: NightRun): string {
  if (run.phase === 'refused') return `Night shift did not start: ${run.stop_detail ?? 'it was refused'}`
  const prs = run.entries.filter((e) => e.kind === 'pr').length
  const open = run.entries.filter((e) => e.kind === 'decision' && !e.choice).length
  return `${countLabel(prs, 'PR', 'PRs')}, ${open === 0 ? 'no open decisions' : countLabel(open, 'open decision', 'open decisions')}`
}

export const STOP_REASON: Record<NightStopReason, string> = {
  report: 'Report published',
  hard_stop: 'Hard stop',
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

/** The runs a view splits off one workspace's state, and the run a report shows. */
export function nightRunSections(
  runs: NightRun[] | undefined,
  reportRun: number | null
): { live: NightRun | null; finished: NightRun[]; shown: NightRun | null } {
  const list = runs ?? []
  const live = list.find((r) => r.phase === 'running' || r.phase === 'wrapping_up') ?? null
  const finished = list.filter((r) => r.phase === 'settled' || r.phase === 'refused')
  const shown = finished.find((r) => r.run_id === reportRun) ?? finished[0] ?? null
  return { live, finished, shown }
}

export type NightTab = 'setup' | 'live' | 'report'

/** A run that ended while its live view was open lands on its report; otherwise the
 * tab stands, or falls back to the run in flight, a requested report, setup. */
export function resolveNightTab(
  tab: NightTab | null,
  live: NightRun | null,
  shown: NightRun | null,
  initialRunId: number | null
): NightTab {
  const fallback: NightTab = live ? 'live' : initialRunId !== null && shown ? 'report' : 'setup'
  return tab === 'live' && !live ? (shown ? 'report' : 'setup') : tab ?? fallback
}
