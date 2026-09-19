// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextBar } from './ContextBar'
import type { SessionContext } from '../houston/generated/SessionContext'

afterEach(cleanup)

function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    used_tokens: 150_000,
    window_tokens: 200_000,
    used_percent: 75,
    state: 'idle',
    source: 'derived',
    as_of_ms: Date.now(),
    ...overrides
  }
}

const NON_CLAUDE = ['codex', 'cursor', 'grok', 'opencode', 'antigravity'] as const

describe('context downbar', () => {
  it('renders the context strings without motion', () => {
    render(<ContextBar context={ctx()} />)
    expect(screen.getByTestId('context-readout').textContent).toBe('150.0k / 200.0k (75%)')
    const meter = screen.getByTestId('context-meter')
    expect(meter.className).not.toMatch(/transition|anim/)
    expect(screen.getByTestId('context-state').textContent).toContain('as of')
  })

  it('accessible meter names both counts', () => {
    render(<ContextBar context={ctx()} />)
    const meter = screen.getByRole('meter')
    expect(meter.getAttribute('aria-valuetext')).toBe('150.0k of 200.0k tokens')
    expect(meter.getAttribute('aria-valuenow')).toBe('75')
  })

  it('renders absolute used with no meter when the window is unknown', () => {
    render(<ContextBar context={ctx({ window_tokens: null, used_percent: null })} />)
    expect(screen.getByTestId('context-readout').textContent).toBe('150.0k used')
    expect(screen.queryByTestId('context-meter')).toBeNull()
  })

  it('not tracked for every non-Claude agent', () => {
    for (const _agent of NON_CLAUDE) {
      const { unmount } = render(<ContextBar context={null} />)
      expect(screen.getByTestId('context-not-tracked').textContent).toBe('not tracked')
      unmount()
    }
    render(<ContextBar context={ctx({ state: 'unknown' })} />)
    expect(screen.getByTestId('context-not-tracked').textContent).toBe('not tracked')
  })
})
