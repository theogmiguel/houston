import { describe, expect, it } from 'vitest'
import {
  formatCadence,
  formatRoutineError,
  lastRunLabel,
  nextRunLabel,
  nextUpBucket,
  nextUpTimeLabel
} from './routineFormat'

describe('formatCadence — the four presets plus custom', () => {
  it('words the interval presets', () => {
    expect(formatCadence({ type: 'interval', seconds: 900 })).toBe('every 15 minutes')
    expect(formatCadence({ type: 'interval', seconds: 3600 })).toBe('hourly')
  })

  it('words a custom interval that is not whole minutes', () => {
    expect(formatCadence({ type: 'interval', seconds: 90 })).toBe('every 90 seconds')
  })

  it('words the clock presets', () => {
    expect(formatCadence({ type: 'clock', hour: 9, minute: 0, weekdays: null })).toBe(
      'daily 09:00'
    )
    expect(
      formatCadence({ type: 'clock', hour: 9, minute: 0, weekdays: [2, 3, 4, 5, 6] })
    ).toBe('weekdays 09:00')
  })

  it('pads single-digit hour/minute', () => {
    expect(formatCadence({ type: 'clock', hour: 5, minute: 5, weekdays: null })).toBe(
      'daily 05:05'
    )
  })

  it('lists explicit weekdays that are not the Mon-Fri set', () => {
    expect(formatCadence({ type: 'clock', hour: 9, minute: 0, weekdays: [1, 7] })).toBe(
      'Sun, Sat 09:00'
    )
  })
})

describe('next/last run labels', () => {
  it('counts down to a future next run', () => {
    const now = 1_000_000
    expect(nextRunLabel(now + 13 * 3600 * 1000, now)).toBe('next in 13h')
  })

  it('names an overdue next run honestly instead of a negative duration', () => {
    const now = 1_000_000
    expect(nextRunLabel(now - 5000, now)).toBe('next run overdue')
  })

  it('counts back to a past last run', () => {
    const now = 1_000_000
    expect(lastRunLabel(now - 3 * 3600 * 1000, now)).toBe('3h ago')
  })
})

describe('nextUpBucket — Today / This week / Later', () => {
  const NOW = new Date(2026, 8, 9, 10, 0, 0).getTime()

  it('same calendar day is today, whatever the hour', () => {
    const later = new Date(2026, 8, 9, 23, 59).getTime()
    expect(nextUpBucket(later, NOW)).toBe('today')
  })

  it('an overdue fire is still today, not a negative bucket', () => {
    const overdue = new Date(2026, 8, 9, 1, 0).getTime()
    expect(nextUpBucket(overdue, NOW)).toBe('today')
  })

  it('tomorrow through six days out is this week', () => {
    expect(nextUpBucket(new Date(2026, 8, 10, 0, 1).getTime(), NOW)).toBe('week')
    expect(nextUpBucket(new Date(2026, 8, 15, 9, 0).getTime(), NOW)).toBe('week')
  })

  it('seven days out or beyond is later', () => {
    expect(nextUpBucket(new Date(2026, 8, 16, 0, 0).getTime(), NOW)).toBe('later')
  })
})

describe('nextUpTimeLabel — the time word for each bucket', () => {
  const NOW = new Date(2026, 8, 9, 10, 0, 0).getTime()

  it('today: clock time only', () => {
    expect(nextUpTimeLabel(new Date(2026, 8, 9, 8, 30).getTime(), NOW)).toBe('08:30')
  })

  it('this week: weekday plus clock time', () => {
    expect(nextUpTimeLabel(new Date(2026, 8, 14, 9, 0).getTime(), NOW)).toBe('Mon 09:00')
  })

  it('later: day and month, no year', () => {
    expect(nextUpTimeLabel(new Date(2026, 8, 20, 0, 0).getTime(), NOW)).toBe('20 Sep')
  })
})

describe('formatRoutineError — the four typed errors', () => {
  it('words limit from the wire values, never a literal 20', () => {
    const msg = formatRoutineError({ kind: 'limit', id: null, limit: 20, requested: 21 })
    expect(msg).toContain('20 routines')
    expect(msg).toContain('21st routine')
  })

  it('handles ordinal edge case 11-13 correctly (not "11st")', () => {
    const msg = formatRoutineError({ kind: 'limit', id: null, limit: 10, requested: 11 })
    expect(msg).toContain('11th routine')
  })

  it('gives the charter-verbatim conflict sentence', () => {
    const msg = formatRoutineError({ kind: 'conflict', id: 3, limit: null, requested: null })
    expect(msg).toBe('These routines changed. Reload them before saving again.')
  })

  it('names the colliding name for duplicate_name', () => {
    const msg = formatRoutineError({
      kind: 'duplicate_name',
      id: null,
      limit: null,
      requested: null,
      attemptedName: 'Leak watch'
    })
    expect(msg).toContain('"Leak watch"')
  })

  it('names the routine for not_found when known', () => {
    const msg = formatRoutineError({
      kind: 'not_found',
      id: 7,
      limit: null,
      requested: null,
      routineName: 'Cert expiry sweep'
    })
    expect(msg).toContain('"Cert expiry sweep"')
    expect(msg).toContain('no longer exists')
  })
})
