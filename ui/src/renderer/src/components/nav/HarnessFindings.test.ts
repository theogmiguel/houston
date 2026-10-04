import { describe, expect, it } from 'vitest'
import { phaseActions, phaseStatus } from './HarnessFindings'

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
