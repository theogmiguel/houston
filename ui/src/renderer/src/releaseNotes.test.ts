// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  RELEASE_NOTES_LINE_MAX_CHARS,
  RELEASE_NOTES_MAX_CHARS,
  RELEASE_NOTES_MAX_LINES,
  summarizeReleaseNotes
} from './releaseNotes'

describe('summarizeReleaseNotes', () => {
  it('returns no summary for notes that carry nothing', () => {
    expect(summarizeReleaseNotes('')).toBeNull()
    expect(summarizeReleaseNotes('   \n\n  \n')).toBeNull()
  })

  it('keeps a short body verbatim, line breaks included', () => {
    expect(summarizeReleaseNotes('## What changed\n\n- a fix\n- a feature')).toBe(
      '## What changed\n\n- a fix\n- a feature'
    )
  })

  it('normalizes CRLF so Windows-written notes keep their line structure', () => {
    expect(summarizeReleaseNotes('one\r\ntwo\r\n')).toBe('one\ntwo')
  })

  it('trims blank leading and trailing lines', () => {
    expect(summarizeReleaseNotes('\n\nbody\n\n')).toBe('body')
  })

  it('bounds the line count and says it was cut', () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const summary = summarizeReleaseNotes(body)!
    expect(summary.endsWith('\n…')).toBe(true)
    expect(summary.split('\n')).toHaveLength(RELEASE_NOTES_MAX_LINES + 1)
    expect(summary).toContain('line 1')
    expect(summary).not.toContain('line 9')
  })

  it('bounds the character count even when the lines are few', () => {
    const body = Array.from({ length: 7 }, () => 'x'.repeat(100)).join('\n')
    const summary = summarizeReleaseNotes(body)!
    expect(summary.length).toBeLessThanOrEqual(RELEASE_NOTES_MAX_CHARS + 2)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('cuts an over-long line at a word boundary and marks the cut', () => {
    const line = `${'word '.repeat(30)}end`
    const summary = summarizeReleaseNotes(line)!
    expect(summary.endsWith('…')).toBe(true)
    expect(summary).not.toContain('end')
    expect(summary.length).toBeLessThanOrEqual(RELEASE_NOTES_LINE_MAX_CHARS + 2)
    expect(summary).not.toContain('  ')
  })

  it('treats a body of only over-long lines as a summary, not as empty', () => {
    const summary = summarizeReleaseNotes('y'.repeat(500))
    expect(summary).not.toBeNull()
    expect(summary!.startsWith('y')).toBe(true)
    expect(summary!.endsWith('…')).toBe(true)
  })
})
