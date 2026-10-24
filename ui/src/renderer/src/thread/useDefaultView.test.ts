import { describe, expect, it } from 'vitest'
import { newSessionView } from './useDefaultView'

describe('newSessionView', () => {
  it('applies the default view to Claude only, and an explicit choice always wins', () => {
    expect(newSessionView('claude', undefined, 'thread')).toBe('thread')
    expect(newSessionView('claude', undefined, 'terminal')).toBe('terminal')
    expect(newSessionView('codex', undefined, 'thread')).toBe('terminal')
    expect(newSessionView('claude', 'terminal', 'thread')).toBe('terminal')
    expect(newSessionView('claude', 'thread', 'terminal')).toBe('thread')
  })
})
