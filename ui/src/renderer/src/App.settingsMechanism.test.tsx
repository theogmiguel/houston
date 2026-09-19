// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderReadyApp, resetHarness, toggleSettings, type AppHarness } from './test/appTestHarness'

let harness: AppHarness | null = null

beforeEach(() => {
  resetHarness()
})

afterEach(() => {
  harness?.unmount()
  harness = null
})

function gridSlot(container: HTMLElement): HTMLElement {
  const slot = container.querySelector('.grid-slot')
  if (!(slot instanceof HTMLElement)) throw new Error('grid slot did not render')
  return slot
}

describe('Settings covers the main pane, and only the main pane', () => {
  it('leaves the covered grid mounted but inert and hidden from the a11y tree', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')

    expect(gridSlot(container).getAttribute('inert')).toBeNull()
    expect(gridSlot(container).getAttribute('aria-hidden')).toBeNull()

    act(() => toggleSettings())

    expect(container.querySelector('.grid-slot')).not.toBeNull()
    expect(gridSlot(container).className).toContain('grid-hidden')
    expect(gridSlot(container).getAttribute('inert')).not.toBeNull()
    expect(gridSlot(container).getAttribute('aria-hidden')).toBe('true')

    act(() => toggleSettings())
    expect(gridSlot(container).getAttribute('inert')).toBeNull()
    expect(gridSlot(container).getAttribute('aria-hidden')).toBeNull()
  })

  it('keeps the rail rendered and interactive — the section rows are not covered', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')

    act(() => toggleSettings())

    const rail = container.querySelector('aside')
    expect(rail).not.toBeNull()
    expect(rail?.getAttribute('inert')).toBeNull()
    const rows = [...container.querySelectorAll('[data-testid="settings-section-row"]')]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((b) => !(b as HTMLButtonElement).disabled)).toBe(true)
  })

  it('a library view REPLACES Settings — the two are peers, and the rail shows the tree again', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')

    act(() => toggleSettings())
    expect(container.querySelector('[aria-label="Settings sections"]')).not.toBeNull()

    const skills = container.querySelector('[data-testid="rail-nav-row"][data-view="skills"]')
    if (!(skills instanceof HTMLButtonElement)) throw new Error('no Skills nav row')
    act(() => skills.click())

    expect(container.querySelector('[aria-label="Settings sections"]')).toBeNull()
    expect(container.querySelector('[data-testid="nav-surface"]')).not.toBeNull()
  })
})
