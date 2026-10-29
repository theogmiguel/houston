import { describe, expect, it } from 'vitest'
import { rollupStatus, sessionGlyphState } from './railRows'
import type { SessionInfo } from '../../houston/client'
import type { StatusGlyphState } from './StatusGlyph'

const STATES: readonly StatusGlyphState[] = ['needs', 'error', 'working', 'finished', 'idle']
const RANK: Record<StatusGlyphState, number> = { idle: 0, finished: 1, working: 2, error: 3, needs: 4 }

describe('workspace status roll-up', () => {
  it('returns idle for an empty workspace', () => {
    expect(rollupStatus([])).toBe('idle')
  })

  it('picks the most urgent of every pair', () => {
    for (const left of STATES) {
      for (const right of STATES) {
        expect(rollupStatus([left, right]), `${left} + ${right}`).toBe(RANK[left] >= RANK[right] ? left : right)
      }
    }
  })

  it('ignores idle once any session has a real state', () => {
    expect(rollupStatus(['idle', 'finished', 'idle'])).toBe('finished')
  })

  it('reads a sleeping session as idle and an exit by its code', () => {
    const session = (state: SessionInfo['state']) => ({ state, status: 'idle' }) as SessionInfo
    expect(sessionGlyphState(session('sleeping'))).toBe('idle')
    expect(sessionGlyphState(session('exited'), 0)).toBe('finished')
    expect(sessionGlyphState(session('exited'), 2)).toBe('error')
    expect(sessionGlyphState(session('killed'))).toBe('error')
  })
})
