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

function renderDot(status: AgentStatus): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<StatusDot status={status} live={true} />)
  })
  const dot = container.querySelector('.agent-dot')
  if (!(dot instanceof HTMLElement)) throw new Error('StatusDot did not render .agent-dot')
  return dot
}

const PULSE = 'motion-safe:animate-[dot-pulse_1.4s_ease-in-out_infinite]'

describe('per-pane status dot colour', () => {
  it('working paints informational blue, not completion green', () => {
    const dot = renderDot('working')
    expect(dot.className).toContain('bg-[var(--info)]')
    expect(dot.className).not.toContain('--ok')
  })

  it('idle paints neutral, not active blue or completion green', () => {
    const dot = renderDot('idle')
    expect(dot.className).toContain('bg-[var(--text-muted)]')
    expect(dot.className).not.toContain('--info')
    expect(dot.className).not.toContain('--ok')
  })

  it('needs-input paints --warn', () => {
    const dot = renderDot('needs-input')
    expect(dot.className).toContain('bg-[var(--warn)]')
  })

  it("spawning paints --accent, the mock's own d-spawn rule", () => {
    const dot = renderDot('spawning')
    expect(dot.className).toContain('bg-[var(--accent)]')
  })

  it('unavailable is a neutral outline and is named accessibly', () => {
    const dot = renderDot('unavailable')
    expect(dot.className).toContain('bg-transparent')
    expect(dot.className).toContain('ring-[var(--text-faint)]')
    expect(dot.getAttribute('aria-label')).toBe('status unavailable')
    expect(dot.getAttribute('role')).toBe('img')
  })
})

describe('per-pane status dot motion (§11 rule 4, motion-r4/motion-k11)', () => {
  it('working and spawning keep looping — genuine indeterminates', () => {
    expect(renderDot('working').className).toContain(PULSE)
    expect(renderDot('spawning').className).toContain(PULSE)
  })

  it('needs-input no longer loops — settled-until-addressed, not indeterminate', () => {
    expect(renderDot('needs-input').className).not.toContain(PULSE)
  })

  it('idle never looped either way', () => {
    expect(renderDot('idle').className).not.toContain(PULSE)
  })

  it('unavailable stays static', () => {
    expect(renderDot('unavailable').className).not.toContain(PULSE)
  })
})
