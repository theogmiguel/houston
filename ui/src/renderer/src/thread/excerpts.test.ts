import { describe, expect, it } from 'vitest'
import { THREAD_EXCERPTS_MAX, THREAD_EXCERPT_MAX_BYTES, THREAD_USER_MESSAGE_MAX_BYTES } from '../houston/generated/DEFAULTS'
import { composedRefusal, composeMessage, excerptLabel, quoteRefusal } from './excerpts'

describe('excerpts', () => {
  it('composes the same text the daemon writes to Claude', () => {
    const excerpts = [
      { source: 'build "main"', session: 4, text: 'error\n```\nnot the end\n' },
      { source: 'tests', session: null, text: 'ok' }
    ]
    // The daemon's `excerpts_go_first_in_fences_they_cannot_close` test pins the same string.
    expect(composeMessage('Why does it fail?', excerpts)).toBe(
      'Terminal selection from pane "build  main":\n````\nerror\n```\nnot the end\n````\n\n' +
      'Terminal selection from pane "tests":\n```\nok\n```\n\nWhy does it fail?'
    )
  })

  it('labels a chip with the pane and its line count', () => {
    expect(excerptLabel({ source: 'build', text: 'a\nb\n' })).toBe('build · 2 lines')
    expect(excerptLabel({ source: 'build', text: 'one' })).toBe('build · 1 line')
  })

  it('refuses a fifth selection and one over the size limit, naming the limit', () => {
    const four = Array.from({ length: THREAD_EXCERPTS_MAX }, () => ({ source: 'p', text: 'x' }))
    expect(quoteRefusal(four, 'more')).toContain(`at most ${THREAD_EXCERPTS_MAX}`)
    expect(quoteRefusal([], 'y'.repeat(THREAD_EXCERPT_MAX_BYTES + 1))).toContain(`${(THREAD_EXCERPT_MAX_BYTES + 1).toLocaleString()} bytes`)
    expect(quoteRefusal([], 'fine')).toBeNull()
  })

  it('counts the quoted selections against the message limit', () => {
    const text = 'z'.repeat(THREAD_USER_MESSAGE_MAX_BYTES - 100)
    expect(composedRefusal(text, [])).toBeNull()
    expect(composedRefusal(text, [{ source: 'log', text: 'w'.repeat(200) }])).toContain('with its quoted selections')
  })
})
