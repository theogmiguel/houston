import { describe, expect, it } from 'vitest'
import { newSessionView, newSessionViewFields } from './useDefaultView'

describe('newSessionView', () => {
  it('applies the default view to Claude only, and an explicit choice always wins', () => {
    expect(newSessionView('claude', undefined, 'thread')).toBe('thread')
    expect(newSessionView('claude', undefined, 'terminal')).toBe('terminal')
    expect(newSessionView('codex', undefined, 'thread')).toBe('terminal')
    expect(newSessionView('claude', 'terminal', 'thread')).toBe('terminal')
    expect(newSessionView('claude', 'thread', 'terminal')).toBe('thread')
  })

  it('adds a view to session_create only for a thread', () => {
    expect(newSessionViewFields('claude', undefined, 'thread')).toEqual({ view: 'thread' })
    expect(newSessionViewFields('claude', undefined, 'terminal')).toEqual({})
    expect(newSessionViewFields('codex', undefined, 'thread')).toEqual({})
  })
})
