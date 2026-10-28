// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StatusGlyph, statusGlyphState, type StatusGlyphSource, type StatusGlyphState } from './StatusGlyph'

afterEach(cleanup)

const MAPPING: [StatusGlyphSource, StatusGlyphState][] = [
  ['spawning', 'working'],
  ['starting', 'working'],
  ['working', 'working'],
  ['Working', 'working'],
  ['needs-input', 'needs'],
  ['Needs input', 'needs'],
  ['Stalled', 'needs'],
  ['done', 'finished'],
  ['Done', 'finished'],
  ['Ended', 'finished'],
  ['Result staged', 'finished'],
  ['failed', 'error'],
  ['Failed', 'error'],
  ['exited', 'error'],
  ['idle', 'idle'],
  ['Idle', 'idle'],
  ['unavailable', 'idle'],
  ['stopped', 'idle'],
  ['Asked orchestrator', 'idle'],
  [null, 'idle']
]

describe('statusGlyphState', () => {
  it.each(MAPPING)('maps %j to %s', (source, state) => {
    expect(statusGlyphState(source)).toBe(state)
  })

  it('covers every source value the callers pass', () => {
    expect(new Set(MAPPING.map(([source]) => source)).size).toBe(MAPPING.length)
  })
})

describe('StatusGlyph', () => {
  it.each(['working', 'needs', 'finished', 'error'] as const)('names %s when it has a label', (state) => {
    const { container } = render(<StatusGlyph state={state} label={`${state} label`} />)
    const glyph = container.querySelector<HTMLElement>('[data-status-glyph]')
    expect(glyph?.dataset.state).toBe(state)
    expect(glyph?.getAttribute('role')).toBe('img')
    expect(glyph?.getAttribute('aria-label')).toBe(`${state} label`)
    expect(glyph?.getAttribute('aria-hidden')).toBeNull()
  })

  it('is decorative without a label', () => {
    const { container } = render(<StatusGlyph state="needs" />)
    const glyph = container.querySelector<HTMLElement>('[data-status-glyph]')
    expect(glyph?.getAttribute('aria-hidden')).toBe('true')
    expect(glyph?.getAttribute('role')).toBeNull()
  })

  it('renders nothing for idle', () => {
    const { container } = render(<StatusGlyph state="idle" label="Idle" />)
    expect(container.querySelector('[data-status-glyph]')).toBeNull()
  })

  it('animates the working arc only when motion is allowed', () => {
    const { container } = render(<StatusGlyph state="working" />)
    const glyph = container.querySelector<HTMLElement>('[data-status-glyph]')
    expect(glyph?.innerHTML).toContain('motion-safe:animate-[spin_0.9s_linear_infinite]')
    expect(glyph?.innerHTML).not.toContain(' animate-[spin')
  })

  it('draws the error state as a stop circle carrying the mark', () => {
    const { container } = render(<StatusGlyph state="error" />)
    const glyph = container.querySelector<HTMLElement>('[data-status-glyph]')
    expect(glyph?.textContent).toBe('!')
    expect(glyph?.innerHTML).toContain('bg-[var(--stop)]')
  })
})
