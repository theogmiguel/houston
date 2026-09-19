import { describe, expect, it } from 'vitest'
import {
  buildHandoffPacket,
  handoffCharCount,
  HANDOFF_ASK_DEFAULT,
  HANDOFF_PACKET_MAX_CHARS,
  HANDOFF_TRIMMED_NOTE
} from './handoffPacket'

describe('buildHandoffPacket', () => {
  it('names the source CLI and the pane, then the ask, then the thread', () => {
    const { text, trimmed } = buildHandoffPacket({
      sourceLabel: 'Claude Code',
      title: 'atlas',
      ask: 'Finish the migration.',
      conversation: '$ cargo test\nall green\n'
    })
    expect(text).toBe(
      'You are picking up a conversation from Claude Code ("atlas").\n' +
        '\n' +
        'Finish the migration.\n' +
        'Do not recap unless asked. The prior conversation is below.\n' +
        '\n' +
        '---\n' +
        '# Prior conversation\n' +
        '$ cargo test\nall green\n'
    )
    expect(trimmed).toBe(false)
  })

  it('falls back to the default ask when the box is left empty', () => {
    const { text } = buildHandoffPacket({
      sourceLabel: 'Codex',
      title: 'atlas',
      ask: '   ',
      conversation: 'x'
    })
    expect(text).toContain(`\n${HANDOFF_ASK_DEFAULT}\n`)
  })

  it('keeps the newest output when the cap trips, and says so', () => {
    const line = 'line of scrollback that is long enough to matter\n'
    const conversation = line.repeat(2000)
    const { text, trimmed, chars } = buildHandoffPacket({
      sourceLabel: 'Claude Code',
      title: 'atlas',
      ask: 'Continue.',
      conversation
    })
    expect(trimmed).toBe(true)
    expect(chars).toBeLessThanOrEqual(HANDOFF_PACKET_MAX_CHARS)
    expect(text).toContain(HANDOFF_TRIMMED_NOTE)
    expect(text.endsWith(line)).toBe(true)
    expect(text.split(line).length - 1).toBeLessThan(2000)
  })

  it('opens the trimmed tail on a line boundary, never mid-line', () => {
    const conversation = Array.from({ length: 9000 }, (_, i) => `step ${i}`).join('\n')
    const { text } = buildHandoffPacket({
      sourceLabel: 'Claude Code',
      title: 'atlas',
      ask: 'Continue.',
      conversation
    })
    const body = text.slice(text.indexOf(HANDOFF_TRIMMED_NOTE) + HANDOFF_TRIMMED_NOTE.length + 1)
    expect(body.startsWith('step ')).toBe(true)
  })
})

describe('handoffCharCount', () => {
  it('reads in thousands, one decimal', () => {
    expect(handoffCharCount(12_340)).toBe('12.3k characters')
    expect(handoffCharCount(0)).toBe('0.0k characters')
  })
})
