import { describe, expect, it } from 'vitest'
import type { PrCheck } from '../../houston/client'
import { checkSummary } from './ChecksList'

const check = (state: PrCheck['state'], duration_ms: number | null = null): PrCheck =>
  ({ name: 'core-checks', state, duration_ms, url: null, run_id: null } as unknown as PrCheck)

describe('check summary', () => {
  it('names an unfinished state once and capitalised', () => {
    expect(checkSummary(check('running'))).toBe('Running')
    expect(checkSummary(check('queued'))).toBe('Queued')
    expect(checkSummary(check('skipped'))).toBe('Skipped')
  })

  it('adds the duration only when one is reported', () => {
    expect(checkSummary(check('passing', 72_000))).toBe('Passed · 1m 12s')
    expect(checkSummary(check('failing'))).toBe('Failed')
    expect(checkSummary(check('running', 30_000))).toBe('Running · 0m 30s')
  })
})
