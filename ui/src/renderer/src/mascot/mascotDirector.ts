import { occasionOn, ymd } from './occasions'
import { getMascotFirstSeen, type MascotPrefs } from './mascotPrefs'
import type { Accessory } from '../components/ui/mascotAccessories'

// Quiet speech should not compete with active terminal input.
export const QUIET_MS = 5_000
// Space unsolicited remarks far enough apart to remain occasional.
export const SPEECH_GAP_MS = 600_000
// Bound interruptions even during a long quiet session.
export const SPEECH_PER_HOUR = 3
// Idle play begins after a short absence; a longer absence settles into sleep.
export const PLAY_AFTER_MS = 120_000
export const NAP_AFTER_MS = 300_000
// A play loop needs enough time to read before the next one.
export const PLAY_SWITCH_MS = 45_000
// Break suggestions follow sustained activity, never absence.
export const BREAK_MS = 5_400_000
export type Mood = 'idle' | 'wave' | 'party' | 'sleep' | 'hula' | 'read' | 'stars' | 'happy' | 'stretch' | 'scan' | 'call' | 'hurt' | 'work'
export interface Moment { id: string; priority: 0 | 1 | 2 | 3; mood: Mood; line?: string; until: number; expires: number; period?: string; duration?: number; lineDuration?: number }
export interface Ledger { greetedDate?: string; periods: string[]; speech: number[]; lastBreakAt: number; introSeen: boolean; installDate: string }
export interface DirectorInput {
  now: number; prefs: MascotPrefs; focus: boolean; lastInputAt: number; lastTypingAt: number
  theme: string; sleeping: boolean; playing: Mood | null; disco: boolean; gameOpen: boolean
  active: Moment | null; queue: Moment[]; ledger: Ledger; continuousInputAt: number; lastPlayAt: number
}
export interface Outfit { head?: Accessory; face?: Accessory; hand?: Accessory; body?: Accessory; fx?: string }
export function emptyLedger(now: number): Ledger { return { periods: [], speech: [], lastBreakAt: 0, introSeen: false, installDate: ymd(new Date(now)) } }
export function readLedger(now: number): Ledger {
  try {
    const raw = JSON.parse(localStorage.getItem('tr-mascot-ledger') ?? 'null') as Partial<Ledger> | null
    if (raw && typeof raw.installDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.installDate) && Number.isFinite(new Date(raw.installDate).getTime())) return {
      installDate: raw.installDate, introSeen: raw.introSeen === true,
      greetedDate: typeof raw.greetedDate === 'string' ? raw.greetedDate : undefined,
      periods: Array.isArray(raw.periods) ? raw.periods.filter((x): x is string => typeof x === 'string').slice(-4) : [],
      speech: Array.isArray(raw.speech) ? raw.speech.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x <= now).slice(-3) : [],
      lastBreakAt: typeof raw.lastBreakAt === 'number' && Number.isFinite(raw.lastBreakAt) ? raw.lastBreakAt : 0
    }
  } catch { /* Invalid local state falls back to a fresh ledger. */ }
  return { ...emptyLedger(now), installDate: getMascotFirstSeen() }
}
export function persistLedger(ledger: Ledger): void { try { localStorage.setItem('tr-mascot-ledger', JSON.stringify(ledger)) } catch { /* Memory remains authoritative for this renderer. */ } }
export function mascotDirector(i: DirectorInput): { outfit: Outfit; base: Mood; moment: Moment | null; queue: Moment[]; ledger: Ledger; sleeping: boolean; playing: Mood | null; lastPlayAt: number } {
  const date = new Date(i.now), day = ymd(date), hour = date.getHours()
  const install = new Date(`${i.ledger.installDate}T12:00:00`)
  const occasion = i.prefs.holidays ? occasionOn(date, install) : undefined
  const late = hour < 5, morning = hour >= 6 && hour < 11
  const idle = i.now - i.lastInputAt
  const sleeping = i.prefs.nap && idle >= NAP_AFTER_MS && !i.disco && !i.gameOpen
  let playing = i.prefs.nap && !sleeping && idle >= PLAY_AFTER_MS && !i.disco && !i.gameOpen ? i.playing : null
  let lastPlayAt = i.lastPlayAt
  if (i.prefs.nap && !sleeping && idle >= PLAY_AFTER_MS && !i.disco && !i.gameOpen && (!playing || i.now - lastPlayAt >= PLAY_SWITCH_MS)) {
    const plays: Mood[] = ['hula', 'read', 'stars']; playing = plays[(plays.indexOf(playing ?? 'idle') + 1) % plays.length]; lastPlayAt = i.now
  }
  const outfit: Outfit = {
    head: occasion?.hat ?? (late ? 'nightcap' : i.prefs.hat === 'none' ? undefined : i.prefs.hat),
    face: occasion?.face, hand: occasion?.hand ?? (morning ? 'mug' : undefined),
    body: occasion?.body ?? (playing === 'read' ? 'book' : undefined),
    fx: i.disco ? 'confetti' : occasion?.fx ?? (late ? 'stars' : playing === 'stars' ? 'stars' : undefined)
  }
  const base = sleeping ? 'sleep' : playing ?? 'idle'
  const ledger = { ...i.ledger, periods: i.ledger.periods.filter((p) => p.startsWith(day)), speech: i.ledger.speech.filter((t) => i.now - t < 3_600_000) }
  const end = new Date(date); end.setHours(23, 59, 59, 999)
  const scheduled: Moment[] = []
  if (occasion && ledger.greetedDate !== day) scheduled.push({ id: `holiday-${day}`, priority: 2, mood: 'party', line: occasion.line(date), duration: 2200, lineDuration: 3200, until: i.now + 2200, expires: end.getTime() })
  else if ((late || morning) && ledger.greetedDate !== day) {
    const period = `${day}-${late ? 'late' : 'morning'}`
    if (!ledger.periods.includes(period)) scheduled.push({ id: period, period, priority: 2, mood: 'idle', line: late ? 'Still up?' : 'Good morning! Coffee?', duration: 2400, until: i.now + 2400, expires: end.getTime() })
  }
  if (i.prefs.breaks && idle < PLAY_AFTER_MS && i.now - i.continuousInputAt >= BREAK_MS && i.now - ledger.lastBreakAt >= BREAK_MS) scheduled.push({ id: `break-${day}`, priority: 2, mood: 'stretch', line: '90 minutes in. Time to stretch?', duration: 1700, lineDuration: 5000, until: i.now + 1700, expires: end.getTime() })
  let queue = [...i.queue, ...scheduled].filter((m, k, all) => m.expires >= i.now && all.findIndex((a) => a.id === m.id) === k).sort((a, b) => a.priority - b.priority)
  let moment = i.active && i.active.until > i.now ? i.active : null
  if (i.sleeping && !sleeping) {
    const pending = queue.find((m) => m.priority === 2)
    queue = queue.filter((m) => m.priority !== 2)
    queue.push({ id: 'wake', priority: 1, mood: 'stretch', line: pending?.line ?? (late ? 'Still up? Me too.' : "Oh, you're back!"), until: i.now + 1900, expires: end.getTime() })
    if (pending?.id.startsWith('holiday-')) ledger.greetedDate = day
    if (pending?.period) ledger.periods.push(pending.period)
    if (pending?.id.startsWith('break-')) ledger.lastBreakAt = i.now
    queue.sort((a, b) => a.priority - b.priority)
  }
  const busy = !!moment || sleeping || i.disco || i.gameOpen
  queue = queue.filter((m) => m.priority !== 3 || !busy)
  const quiet = i.focus && i.now - i.lastTypingAt >= QUIET_MS
  const budget = ledger.speech.length < SPEECH_PER_HOUR && (!ledger.speech.length || i.now - ledger.speech[ledger.speech.length - 1] >= SPEECH_GAP_MS)
  const candidate = queue.find((m) => (!moment || m.priority < moment.priority || m.priority === 0) && (m.priority < 2 || (!sleeping && !i.disco && !i.gameOpen && quiet && (!m.line || budget))))
  if (candidate) {
    moment = { ...candidate, until: i.now + (candidate.duration ?? Math.max(1, candidate.until - i.now)) }
    queue = queue.filter((m) => m.id !== candidate.id)
    if (candidate.priority >= 2 && candidate.line) ledger.speech.push(i.now)
    if (candidate.id.startsWith('holiday-')) ledger.greetedDate = day
    if (candidate.period) ledger.periods.push(candidate.period)
    if (candidate.id.startsWith('break-')) ledger.lastBreakAt = i.now
  }
  return { outfit, base, moment, queue: queue.slice(0, 12), ledger, sleeping, playing, lastPlayAt }
}
