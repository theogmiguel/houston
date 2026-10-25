import { describe, expect, it } from 'vitest'
import { checksSummary, ownLimitNote, suggestFocus } from './nightShiftFormat'
import { nightDefaults } from '../../test/nightShiftFixtures'

describe('nightShiftFormat', () => {
  const base = nightDefaults().focus

  it('an empty checks summary says how many the repository offers', () => {
    const check = { command: 'cargo test', source: 'ci.yml · core-checks' }
    expect(checksSummary([], 4)).toBe('None chosen, 4 found in the repository')
    expect(checksSummary([], 0)).toBe('No checks found: add one')
    expect(checksSummary([check], 4)).toBe('1 check from ci.yml')
  })

  it('direction suggests matching focus areas in English and Portuguese', () => {
    const en = suggestFocus('Make it feel faster and stop it crashing in long sessions', base, base, new Set())
    expect(en.suggested).toBe(true)
    expect(en.focus).toMatchObject({ reliability: 'high', performance: 'high', ui_polish: 'off', docs_accuracy: 'off', test_gaps: 'off' })
    const pt = suggestFocus('Deixar a documentação certa e aumentar a cobertura de testes', base, base, new Set())
    expect(pt.focus).toMatchObject({ docs_accuracy: 'high', test_gaps: 'high', reliability: 'off', performance: 'off' })
  })

  it('matches direction words only as whole words', () => {
    const build = suggestFocus('make the build faster', base, base, new Set())
    expect(build.focus).toMatchObject({ performance: 'high', ui_polish: 'off', docs_accuracy: 'off', test_gaps: 'off' })
    const docker = suggestFocus('update the docker image', base, base, new Set())
    expect(docker.focus.docs_accuracy).toBe(base.docs_accuracy)
    const latest = suggestFocus('latest release', base, base, new Set())
    expect(latest.focus.test_gaps).toBe(base.test_gaps)
    expect(suggestFocus('fix the docs', base, base, new Set()).focus.docs_accuracy).toBe('high')
    expect(suggestFocus('add tests', base, base, new Set()).focus.test_gaps).toBe('high')
  })

  it('names the own pane limit only above the global child panes per agent', () => {
    expect(ownLimitNote(4, 6)).toBeNull()
    expect(ownLimitNote(5, 6)).toBe('Own limit: 7 panes · other agents keep 6')
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
