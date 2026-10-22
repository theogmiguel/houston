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
    act(() => root.render(<NightShiftSetup settings={nightDefaults()} revision="r" verifyCommand={false} onSave={onSave} />))
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
    const [saved, revision] = onSave.mock.calls[0]
    expect(saved.window.nights).toEqual([3, 5])
    expect(saved.focus.test_gaps).toBe('high')
    expect(revision).toBe('r')
  })

  it('keeps an edit across refreshes and saves it against the revision it was read at', () => {
    const onSave = vi.fn()
    const render = (revision: string, goal = ''): void =>
      act(() => root.render(<NightShiftSetup settings={{ ...nightDefaults(), goal }} revision={revision} verifyCommand onSave={onSave} />))
    render('r')
    const input = (label: string): HTMLInputElement | HTMLTextAreaElement =>
      host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement
    const type = (label: string, value: string): void => {
      const el = input(label)
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!
      act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    type('Goal', 'CI is green')
    type('Wrap-up', '05:00')
    render('r')
    expect(input('Goal').value).toBe('CI is green')
    render('r2', 'from another window')
    expect(input('Goal').value).toBe('CI is green')
    click(button('Save'))
    expect(onSave.mock.calls[0][1]).toBe('r')

    click(button('Discard changes'))
    expect(input('Goal').value).toBe('from another window')
    expect(input('Wrap-up').value).toBe('06:45')
    render('r3', 'saved elsewhere')
    expect(input('Goal').value).toBe('saved elsewhere')
  })

  it('edits the orchestrator, reviewer and smoke flows', () => {
    const onSave = vi.fn()
    act(() => root.render(<NightShiftSetup settings={nightDefaults()} revision="r" verifyCommand onSave={onSave} />))
    for (const label of ['Orchestrator', 'Reviewer', 'Smoke flows']) {
      expect(host.querySelector(`[aria-label="${label}"]`), label).not.toBeNull()
    }
  })
})
