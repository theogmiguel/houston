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

/** A crew picker's row: the select and any model hint beside it. */
const pickerRow = (label: string): string | null | undefined =>
  host.querySelector(`[aria-label="${label}"]`)?.parentElement?.closest('[class~="gap-[var(--space-2)]"]')?.textContent

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
    expect(pickerRow('Orchestrator')).toBe('Claude Codeopus')
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
    expect(refusal?.textContent).toContain('App QA on with a start command')
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
    const render = (revision: string, direction = ''): void =>
      act(() => root.render(<NightShiftSetup settings={{ ...nightDefaults(), direction }} revision={revision} verifyCommand onSave={onSave} />))
    render('r')
    const input = (label: string): HTMLInputElement | HTMLTextAreaElement =>
      host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement
    const type = (label: string, value: string): void => {
      const el = input(label)
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!
      act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    type('Direction', 'CI is green')
    type('Wrap-up', '05:00')
    render('r')
    expect(input('Direction').value).toBe('CI is green')
    render('r2', 'from another window')
    expect(input('Direction').value).toBe('CI is green')
    click(button('Save'))
    expect(onSave.mock.calls[0][1]).toBe('r')

    click(button('Discard changes'))
    expect(input('Direction').value).toBe('from another window')
    expect(input('Wrap-up').value).toBe('06:45')
    render('r3', 'saved elsewhere')
    expect(input('Direction').value).toBe('saved elsewhere')
  })

  it('confirms a save once the daemon answers with the saved settings', () => {
    const onSave = vi.fn()
    const render = (settings: ReturnType<typeof nightDefaults>, revision: string, error: string | null = null): void =>
      act(() => root.render(<NightShiftSetup settings={settings} revision={revision} verifyCommand onSave={onSave} error={error} />))
    render(nightDefaults(), 'r')
    const field = host.querySelector('[aria-label="Direction"]') as HTMLTextAreaElement
    const type = (value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
      act(() => { setter.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    const status = (): string => host.querySelector('[role="status"]')?.textContent ?? ''
    type('CI is green')
    expect(status()).toBe('')
    click(button('Save'))
    expect(status()).toContain('Saving')
    expect(button('Save')?.disabled).toBe(true)
    render({ ...nightDefaults(), direction: 'CI is green' }, 'r2')
    expect(status()).toContain('Saved')
    expect(host.querySelector('[aria-label="Saved"]')).not.toBeNull()
    type('CI is green, docs too')
    expect(status()).toBe('')

    click(button('Save'))
    render({ ...nightDefaults(), direction: 'CI is green' }, 'r2', 'stale revision')
    expect(status(), 'a refused save is not confirmed').toBe('')
    expect(button('Save')?.disabled).toBe(false)
  })

  it('offers no ZCode orchestrator and refuses a stored one by its reason', () => {
    act(() => root.render(<NightShiftSetup settings={nightDefaults()} revision="r" verifyCommand onSave={vi.fn()} />))
    const trigger = host.querySelector('[role="combobox"][aria-label="Orchestrator"]')!
    act(() => { trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })) })
    const menu = document.getElementById(trigger.getAttribute('aria-controls')!)!
    const offered = Array.from(menu.querySelectorAll<HTMLElement>('[role="option"]')).map((o) => o.dataset.value)
    expect(offered).toEqual(['claude', 'codex', 'opencode'])

    const stored = { ...nightDefaults(), orchestrator: { provider: 'zcode' as const, model: null } }
    act(() => root.render(<NightShiftSetup settings={stored} revision="r2" verifyCommand onSave={vi.fn()} />))
    expect(host.textContent).toContain('ZCode cannot orchestrate: a pull request watch cannot wake it')
  })

  it('names OpenCode properly and adds no model hint that repeats the provider', () => {
    const settings = { ...nightDefaults(), orchestrator: { provider: 'opencode' as const, model: null }, workers: [{ provider: 'zcode' as const, model: null }] }
    act(() => root.render(<NightShiftSetup settings={settings} revision="r" verifyCommand onSave={vi.fn()} />))
    expect(pickerRow('Orchestrator')).toBe('OpenCode')
    expect(pickerRow('Worker 1')).toBe('ZCode')
  })

  it('edits the orchestrator, reviewer and smoke flows', () => {
    const onSave = vi.fn()
    act(() => root.render(<NightShiftSetup settings={nightDefaults()} revision="r" verifyCommand onSave={onSave} />))
    for (const label of ['Orchestrator', 'Reviewer', 'Smoke flows']) {
      expect(host.querySelector(`[aria-label="${label}"]`), label).not.toBeNull()
    }
  })
})
