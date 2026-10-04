import { describe, expect, it } from 'vitest'
import { phaseActions, phaseStatus } from './HarnessFindings'
import { formatHarnessDate } from './harnessFormat'

describe('Harness finding presentation', () => {
  it('maps every derived phase to its visible status and next actions', () => {
    expect(phaseStatus('open')).toBe('Open')
    expect(phaseActions('open')).toEqual(['create_task', 'dismiss'])
    expect(phaseStatus('fixing')).toBe('Fixing')
    expect(phaseActions('fixing')).toEqual(['open_task'])
    expect(phaseStatus('awaiting_verification')).toBe('Fixing')
    expect(phaseActions('awaiting_verification')).toEqual(['verify_now'])
    expect(phaseStatus('not_seen')).toBe('Not seen')
    expect(phaseActions('not_seen')).toEqual(['resolve', 'keep_open'])
    expect(phaseActions('resolved')).toEqual(['reopen'])
    expect(phaseActions('dismissed')).toEqual(['reopen'])
  })
})

describe('formatHarnessDate', () => {
  const now = new Date(2026, 8, 28, 12).getTime()

  it('formats review times with a weekday and 24-hour clock', () => {
    expect(formatHarnessDate(new Date(2026, 8, 28, 9).getTime(), true, now)).toBe('Mon 09:00')
  })

  it('uses a weekday for dates in the last week and month/day for older dates', () => {
    expect(formatHarnessDate(new Date(2026, 8, 24).getTime(), false, now)).toBe('Thu')
    expect(formatHarnessDate(new Date(2026, 8, 22).getTime(), false, now)).toBe('Sep 22')
  })
})
