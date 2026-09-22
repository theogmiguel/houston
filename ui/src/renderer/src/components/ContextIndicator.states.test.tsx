// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionContext } from '../houston/generated/SessionContext'
import { ContextIndicator } from './ContextIndicator'
import { HOVER_DELAY_MS } from './Tooltip'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

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

describe('per-pane context indicator', () => {
  it('renders a static accessible ring with the current percentage', () => {
    const { container } = render(<ContextIndicator context={ctx()} />)
    const meter = screen.getByRole('button')
    expect(meter.getAttribute('aria-label')).toBe('Context · 75% used 150k / 200k tokens')
    expect(screen.getByTestId('context-meter-value').getAttribute('stroke-dashoffset')).not.toBe('0')
    expect(container.innerHTML).not.toMatch(/animate|transition/)
  })

  it('keeps the reading to two lines and flags a previous response while working', () => {
    const { container, rerender } = render(<ContextIndicator context={ctx()} />)
    const tooltipAnchor = container.querySelector('[data-tooltip]')
    expect(tooltipAnchor?.getAttribute('data-tooltip')).toBe('Context · 75% used\n150k / 200k tokens')
    rerender(<ContextIndicator context={ctx({ state: 'working' })} />)
    expect(tooltipAnchor?.getAttribute('data-tooltip')).toBe('Context · 75% used\n150k / 200k tokens\nLast response')
  })

  it('uses warning and danger tones without motion', () => {
    const { unmount } = render(
      <ContextIndicator context={ctx({ used_percent: 80, state: 'near_limit' })} />
    )
    expect(screen.getByTestId('context-indicator').className).toContain('text-[var(--warn)]')
    unmount()

    render(<ContextIndicator context={ctx({ used_percent: 95, state: 'near_limit' })} />)
    expect(screen.getByTestId('context-indicator').className).toContain('text-[var(--danger)]')
  })

  it('keeps an absolute reading when the model window is unknown', () => {
    render(
      <ContextIndicator context={ctx({ window_tokens: null, used_percent: null })} />
    )
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain(
      'Context · limit unknown 150k tokens'
    )
    expect(screen.queryByTestId('context-meter-value')).toBeNull()
  })

  it('opens details on hover over the control and closes them on leave', () => {
    vi.useFakeTimers()
    render(<ContextIndicator context={ctx({ used_percent: 7 })} />)
    const button = screen.getByRole('button')
    fireEvent.pointerEnter(button)
    act(() => vi.advanceTimersByTime(HOVER_DELAY_MS))
    expect(screen.getByRole('tooltip').textContent).toContain('7% used')
    fireEvent.pointerLeave(button)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens details on click, including the pointer-focus sequence', () => {
    render(<ContextIndicator context={ctx()} />)
    const button = screen.getByRole('button')
    fireEvent.pointerDown(button)
    fireEvent.focus(button)
    fireEvent.click(button)
    expect(screen.getByRole('tooltip').textContent).toContain('150k / 200k tokens')
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens details on keyboard focus without waiting for hover', () => {
    render(<ContextIndicator context={ctx()} />)
    fireEvent.focus(screen.getByRole('button'))
    expect(screen.getByRole('tooltip').textContent).toContain('75% used')
  })

  it('renders nothing without a useful reading', () => {
    const { container, rerender } = render(<ContextIndicator context={null} />)
    expect(container.firstChild).toBeNull()

    rerender(<ContextIndicator context={ctx({ state: 'unknown' })} />)
    expect(container.firstChild).toBeNull()

    rerender(<ContextIndicator context={ctx({ state: 'working', as_of_ms: 0 })} />)
    expect(container.firstChild).toBeNull()
  })
})
