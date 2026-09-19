import type { Cadence, RoutineRefusal } from '../../houston/routineTypes'

const WEEKDAY_ABBR = ['', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const WEEKDAYS_MON_FRI = [2, 3, 4, 5, 6]

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function clockLabel(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`
}

export function formatCadence(cadence: Cadence): string {
  if (cadence.type === 'interval') {
    const { seconds } = cadence
    if (seconds % 3600 === 0) {
      const hours = seconds / 3600
      return hours === 1 ? 'hourly' : `every ${hours} hours`
    }
    if (seconds % 60 === 0) {
      const minutes = seconds / 60
      return minutes === 1 ? 'every minute' : `every ${minutes} minutes`
    }
    return seconds === 1 ? 'every second' : `every ${seconds} seconds`
  }
  const { hour, minute, weekdays } = cadence
  const time = clockLabel(hour, minute)
  if (weekdays == null) return `daily ${time}`
  if (
    weekdays.length === WEEKDAYS_MON_FRI.length &&
    WEEKDAYS_MON_FRI.every((d) => weekdays.includes(d))
  ) {
    return `weekdays ${time}`
  }
  const days = [...weekdays]
    .sort((a, b) => a - b)
    .map((d) => WEEKDAY_ABBR[d])
    .join(', ')
  return `${days} ${time}`
}

function deltaLabel(deltaMs: number): string {
  const s = Math.max(0, Math.round(Math.abs(deltaMs) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function nextRunLabel(nextRunAtMs: number, nowMs: number): string {
  const delta = nextRunAtMs - nowMs
  return delta > 0 ? `next in ${deltaLabel(delta)}` : 'next run overdue'
}

export function lastRunLabel(lastRunAtMs: number, nowMs: number): string {
  return `${deltaLabel(nowMs - lastRunAtMs)} ago`
}

export function formatRunTime(startedAtMs: number, nowMs: number): string {
  const d = new Date(startedAtMs)
  const time = clockLabel(d.getHours(), d.getMinutes())
  return `${time} · ${deltaLabel(nowMs - startedAtMs)} ago`
}

export function nextUpBucket(nextRunAtMs: number, nowMs: number): 'today' | 'week' | 'later' {
  const a = new Date(nowMs)
  const b = new Date(nextRunAtMs)
  const dayA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const dayB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  const days = Math.round((dayB - dayA) / 86_400_000)
  if (days <= 0) return 'today'
  if (days < 7) return 'week'
  return 'later'
}

const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const

export function nextUpTimeLabel(nextRunAtMs: number, nowMs: number): string {
  const d = new Date(nextRunAtMs)
  const time = clockLabel(d.getHours(), d.getMinutes())
  switch (nextUpBucket(nextRunAtMs, nowMs)) {
    case 'today':
      return time
    case 'week':
      return `${WEEKDAY_ABBR[(d.getDay() + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7]} ${time}`
    case 'later':
      return `${d.getDate()} ${MONTH_ABBR[d.getMonth()]}`
  }
}

function ordinal(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

export function formatRoutineError(error: RoutineRefusal): string {
  switch (error.kind) {
    case 'limit': {
      const limit = error.limit ?? 0
      const suffix =
        error.requested !== null && error.requested !== undefined
          ? ` You tried to add a ${ordinal(error.requested)} routine.`
          : ''
      return `Houston already has ${limit} routines. Pause or remove one first.${suffix}`
    }
    case 'conflict':
      return 'These routines changed. Reload them before saving again.'
    case 'duplicate_name':
      return error.attemptedName
        ? `This agent already has a routine named "${error.attemptedName}". Pick a different name.`
        : 'This agent already has a routine with that name.'
    case 'not_found':
      return error.routineName
        ? `"${error.routineName}" no longer exists — it was likely deleted elsewhere.`
        : 'That routine no longer exists — it was likely deleted elsewhere.'
    case 'already_running':
      return 'This routine is still running its previous run. Stop it or wait for it to finish.'
  }
}
