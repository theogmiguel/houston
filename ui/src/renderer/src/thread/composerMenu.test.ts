import { describe, expect, it } from 'vitest'
import { atMention, commandRefusal, insertAtToken, menuToken, slashRows, SLASH_ROWS_MAX } from './composerMenu'

const commands = { commands: ['compact', 'clear', 'context'], skills: ['code-review'], terminal_only: ['model', 'doctor', 'config'] }

describe('menuToken', () => {
  it('opens / only at the start of the message and @ at any word start', () => {
    expect(menuToken('/com', 4)).toEqual({ trigger: '/', query: 'com', start: 0, end: 4 })
    expect(menuToken('see /com', 8)).toBeNull()
    expect(menuToken('read @src/ma', 12)).toEqual({ trigger: '@', query: 'src/ma', start: 5, end: 12 })
    expect(menuToken('mail a@b', 8)).toBeNull()
    expect(menuToken('/compact now', 12)).toBeNull()
    expect(menuToken('', 0)).toBeNull()
  })
})

describe('insertAtToken', () => {
  it('replaces the word under the caret and leaves one space after it', () => {
    const token = menuToken('read @src please', 9)
    expect(token).not.toBeNull()
    expect(insertAtToken('read @src please', token!, '@src/main.ts')).toEqual({ text: 'read @src/main.ts please', caret: 18 })
    const start = menuToken('/co', 3)!
    expect(insertAtToken('/co', start, '/compact')).toEqual({ text: '/compact ', caret: 9 })
  })

  it('quotes a path with spaces so the mention ends with it', () => {
    expect(atMention('docs/user guide.md')).toBe('@"docs/user guide.md"')
    expect(atMention('src/a.ts')).toBe('@src/a.ts')
  })
})

describe('slashRows', () => {
  it('lists Houston, skills, Claude commands, then terminal-only ones, prefix matches first', () => {
    expect(slashRows(commands, '').map((row) => `${row.group}:${row.name}`)).toEqual([
      'houston:terminal', 'skill:code-review', 'claude:compact', 'claude:clear', 'claude:context', 'terminal:model', 'terminal:doctor', 'terminal:config'
    ])
    expect(slashRows(commands, 'co').map((row) => row.name)).toEqual(['code-review', 'compact', 'context', 'config'])
    expect(slashRows(commands, 'MOD').map((row) => row.group)).toEqual(['terminal'])
  })

  it('offers Open in terminal before Claude has listed anything, and bounds the rows', () => {
    expect(slashRows(null, '')).toEqual([{ group: 'houston', name: 'terminal' }])
    const many = { commands: [], skills: Array.from({ length: 100 }, (_, n) => `skill-${n}`), terminal_only: [] }
    expect(slashRows(many, '')).toHaveLength(SLASH_ROWS_MAX)
  })
})

describe('commandRefusal', () => {
  it('refuses a listed terminal-only command and a command carrying quoted selections', () => {
    expect(commandRefusal('/model claude-opus-5-5', false, commands)).toContain('/model runs only in a terminal pane')
    expect(commandRefusal('  /doctor', false, commands)).toContain('/doctor runs only')
    expect(commandRefusal('/compact', true, commands)).toContain('cannot carry quoted selections')
    expect(commandRefusal('/code-review', true, commands)).toContain('cannot carry quoted selections')
    for (const text of ['/compact', '/code-review src', 'see /model', '/etc/hosts', '/unknown with', '']) expect(commandRefusal(text, false, commands)).toBeNull()
    expect(commandRefusal('/unknown', true, commands)).toBeNull()
    expect(commandRefusal('/model', false, null)).toBeNull()
  })
})
