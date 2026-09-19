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

describe('per-pane status dot colour (charter §05b STATUS DOT list)', () => {
  it('working (running) paints --ok, not --accent', () => {
    const dot = renderDot('working')
    expect(dot.className).toContain('bg-[var(--ok)]')
    expect(dot.className).not.toContain('--accent')
  })

  it('idle (idle-attached) paints --info, not --online/--ok', () => {
    const dot = renderDot('idle')
    expect(dot.className).toContain('bg-[var(--info)]')
    expect(dot.className).not.toContain('--online')
  })

  it('needs-input paints --warn', () => {
    const dot = renderDot('needs-input')
    expect(dot.className).toContain('bg-[var(--warn)]')
  })

  it("spawning paints --accent, the mock's own d-spawn rule", () => {
    const dot = renderDot('spawning')
    expect(dot.className).toContain('bg-[var(--accent)]')
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
})
