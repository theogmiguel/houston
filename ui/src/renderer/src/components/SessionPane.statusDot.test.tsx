// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { StatusDot } from './SessionPane'
import type { AgentStatus } from '../houston/client'

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
})

function renderDot(status: AgentStatus): HTMLElement | null {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<StatusDot status={status} live={true} />)
  })
  return container.querySelector<HTMLElement>('[data-status-glyph]')
}

describe('per-pane status glyph', () => {
  it('working shows the accent-ink arc, not a completion fill', () => {
    const glyph = renderDot('working')!
    expect(glyph.dataset.state).toBe('working')
    expect(glyph.innerHTML).toContain('var(--accent-ink)')
    expect(glyph.innerHTML).not.toContain('var(--ok)')
  })

  it('spawning borrows the working arc while the CLI starts', () => {
    expect(renderDot('spawning')?.dataset.state).toBe('working')
  })

  it('idle renders nothing', () => {
    expect(renderDot('idle')).toBeNull()
  })

  it('needs-input shows the warn dot with its ring', () => {
    const glyph = renderDot('needs-input')!
    expect(glyph.dataset.state).toBe('needs')
    expect(glyph.innerHTML).toContain('var(--warn)')
  })

  it('unavailable has no glyph in this vocabulary', () => {
    expect(renderDot('unavailable')).toBeNull()
  })
})

describe('per-pane status glyph motion', () => {
  it('working keeps its loop only when motion is allowed', () => {
    const glyph = renderDot('working')!
    expect(glyph.innerHTML).toContain('motion-safe:animate-[spin_0.9s_linear_infinite]')
    expect(glyph.innerHTML).not.toContain(' animate-[spin')
  })

  it('needs-input stays still — settled until addressed, not indeterminate', () => {
    expect(renderDot('needs-input')!.innerHTML).not.toContain('animate-')
  })
})
