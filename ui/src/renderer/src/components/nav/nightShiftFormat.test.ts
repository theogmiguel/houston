import { describe, expect, it } from 'vitest'
import { suggestFocus } from './nightShiftFormat'
import { nightDefaults } from '../../test/nightShiftFixtures'

describe('nightShiftFormat', () => {
  const base = nightDefaults().focus

  it('direction suggests matching focus areas in English and Portuguese', () => {
    const en = suggestFocus('Make it feel faster and stop it crashing in long sessions', base, base, new Set())
    expect(en.suggested).toBe(true)
    expect(en.focus).toMatchObject({ reliability: 'high', performance: 'high', ui_polish: 'off', docs_accuracy: 'off', test_gaps: 'off' })
    const pt = suggestFocus('Deixar a documentação certa e aumentar a cobertura de testes', base, base, new Set())
    expect(pt.focus).toMatchObject({ docs_accuracy: 'high', test_gaps: 'high', reliability: 'off', performance: 'off' })
  })

  it('never overwrites an area changed by hand, and falls back without a match', () => {
    const current = { ...base, reliability: 'low' as const }
    const out = suggestFocus('faster startup', base, current, new Set(['reliability']))
    expect(out.focus.reliability).toBe('low')
    expect(out.focus.performance).toBe('high')
    const none = suggestFocus('something unrelated', base, out.focus, new Set(['reliability']))
    expect(none.suggested).toBe(false)
    expect(none.focus).toEqual({ ...base, reliability: 'low' })
    expect(suggestFocus('', base, out.focus, new Set()).focus).toEqual(base)
  })
})
