// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GateChip, NightShiftSpecimen, NightWindowStrip } from '.'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('ui-primitives', () => {
  it('night shift specimen shows facts solid and verdicts outlined', () => {
    act(() => root.render(<NightShiftSpecimen />))
    const chips = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="gate-chip"]'))
    expect(chips).toHaveLength(8)
    for (const c of chips) {
      const outlined = c.className.includes('bg-transparent')
      expect(outlined).toBe(c.dataset.gateKind === 'verdict')
    }
    expect(host.querySelectorAll('[data-testid="window-mark-interruption"]')).toHaveLength(1)
    expect(host.querySelectorAll('section[aria-label]')).toHaveLength(3)
  })

  it('night shift window strip places marks along the window', () => {
    act(() => root.render(<>
      <NightWindowStrip label="w" progress={0.5} marks={[{ at: 0, label: 'a', kind: 'start' }, { at: 2, label: 'b', kind: 'hard-stop' }]} />
      <GateChip label="QA" state="failed" kind="verdict" />
    </>))
    expect((host.querySelector('[data-testid="window-progress"]') as HTMLElement).style.width).toBe('50%')
    expect((host.querySelector('[data-testid="window-mark-hard-stop"]') as HTMLElement).style.left).toBe('calc(100% - var(--space-pixel))')
    const chip = host.querySelector('[data-testid="gate-chip"]')
    expect(chip?.getAttribute('aria-label')).toBe('QA failed (agent verdict)')
    expect(chip?.getAttribute('role'), 'a labelled span is announced only with a role').toBe('img')
    expect(host.querySelector('[data-testid="window-mark-hard-stop"]')?.getAttribute('role')).toBe('img')
  })
})
