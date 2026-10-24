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

  it('night shift setup questions badge their state and dash an optional step', () => {
    act(() => root.render(<NightShiftSpecimen />))
    const badges = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="night-question-badge"]'))
    expect(badges.map((b) => [b.textContent, b.dataset.tone])).toEqual([['Required', 'required'], ['Answered from the repository', 'answered']])
    const heading = host.querySelector('section[aria-labelledby] h2')
    expect(heading?.textContent).toBe('What should it work on?')
    const numbers = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="night-step-number"]'))
    expect(numbers.map((n) => n.dataset.optional)).toEqual(['false', 'true'])
    expect(numbers[1].className).toContain('border-dashed')
    expect(host.querySelector('button[aria-label="About App QA"]')).not.toBeNull()
    expect(host.querySelector('h1')?.textContent).toBe('Set up Night shift')
    const output = host.querySelector('[role="radiogroup"][aria-label="Output"]')!
    expect(output.querySelector('[aria-checked="true"]')?.textContent).toContain('Draft pull requests')
    expect(host.querySelector('button[aria-label="About Reviewer"]')).not.toBeNull()
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

  it('night shift window strip keeps a late wrap-up label off the hard stop label', () => {
    act(() => root.render(<NightWindowStrip label="w" marks={[
      { at: 0, label: '23:30', kind: 'start' },
      { at: 0.906, label: 'Wrap-up 06:45', kind: 'wrap-up' },
      { at: 1, label: '07:30', kind: 'hard-stop' }
    ]} />))
    const row = (name: string): string => host.querySelector(`[data-testid="window-labels-${name}"]`)?.textContent ?? ''
    expect(row('edges')).toBe('23:3007:30')
    expect(row('inner')).toBe('Wrap-up 06:45')
    const wrap = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === 'Wrap-up 06:45')!
    expect(wrap.className, 'a label near the end grows leftwards, inside the strip').toContain('-translate-x-full')
  })
})
