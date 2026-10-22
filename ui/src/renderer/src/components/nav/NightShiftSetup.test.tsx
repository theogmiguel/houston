// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NightShiftSetup } from './NightShiftSetup'
import { nightDefaults } from '../../test/nightShiftFixtures'
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

const checked = (group: string): string | null =>
  host.querySelector(`[role="radiogroup"][aria-label="${group}"] [aria-checked="true"]`)?.textContent ?? null

const click = (el: Element | null | undefined): void => {
  if (!el) throw new Error('missing element')
  act(() => { (el as HTMLElement).click() })
}

const button = (text: string): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)

describe('NightShiftSetup', () => {
  it('renders defaults and merge refusal', () => {
    const onSave = vi.fn()
    act(() => root.render(<NightShiftSetup settings={nightDefaults()} verifyCommand={false} onSave={onSave} />))
    const value = (label: string): string => (host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement).value
    expect([value('Start'), value('Wrap-up'), value('Hard stop')]).toEqual(['23:30', '06:45', '07:30'])
    expect(host.textContent).toContain('8 h')
    expect(host.textContent).toContain('No nights selected')
    expect(checked('Reliability focus')).toBe('Normal')
    expect(checked('Performance focus')).toBe('Normal')
    expect(checked('UI and UX polish focus')).toBe('Off')
    expect(checked('Output')).toBe('Pull requests only')
    expect(host.textContent).toContain('Claude Code opus')
    expect(host.textContent).toContain('Same as orchestrator')
    expect(host.querySelector('[data-testid="window-mark-wrap-up"]')).not.toBeNull()

    click(button('Tue'))
    click(button('Thu'))
    expect(host.textContent).not.toContain('No nights selected')
    expect(button('Tue')?.getAttribute('aria-pressed')).toBe('true')
    click(Array.from(host.querySelectorAll('[role="radiogroup"][aria-label="Test gaps focus"] [role="radio"]')).find((b) => b.textContent === 'High'))
    expect(checked('Test gaps focus')).toBe('High')

    click(Array.from(host.querySelectorAll('[role="radiogroup"][aria-label="Output"] [role="radio"]')).find((b) => b.textContent === 'Merge queue'))
    const refusal = host.querySelector('[data-testid="merge-refusal"]')
    expect(refusal?.textContent).toContain('an App check')
    expect(refusal?.textContent).toContain('verification command')
    expect(button('Save')?.disabled).toBe(true)

    click(Array.from(host.querySelectorAll('[role="radiogroup"][aria-label="Output"] [role="radio"]')).find((b) => b.textContent === 'Pull requests only'))
    expect(host.querySelector('[data-testid="merge-refusal"]')).toBeNull()
    click(button('Save'))
    const saved = onSave.mock.calls[0][0]
    expect(saved.window.nights).toEqual([3, 5])
    expect(saved.focus.test_gaps).toBe('high')
  })
})
