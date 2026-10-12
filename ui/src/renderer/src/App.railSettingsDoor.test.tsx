// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderReadyApp, resetHarness, type AppHarness } from './test/appTestHarness'

let harness: AppHarness | null = null

beforeEach(() => {
  resetHarness()
})

afterEach(() => {
  harness?.unmount()
  harness = null
})

function footSettingsButton(container: HTMLElement): HTMLButtonElement {
  const foot = container.querySelector('.railfoot')
  if (!(foot instanceof HTMLElement)) throw new Error('rail foot did not render')
  const btn = foot.querySelector('button[aria-label="Settings"]')
  if (!(btn instanceof HTMLButtonElement)) throw new Error('rail foot has no Settings button')
  return btn
}

describe('the rail foot opens Settings (charter §20 decision 5)', () => {
  it('is wired — no "Not wired yet" tooltip', async () => {
    harness = await renderReadyApp()
    expect(footSettingsButton(harness.container).getAttribute('title')).toBeNull()
  })

  it('clicking it opens Settings, and clicking again closes it', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const sectionList = (): Element | null =>
      container.querySelector('[aria-label="Settings sections"]')

    expect(sectionList()).toBeNull()

    const { act } = await import('react')
    act(() => footSettingsButton(container).click())
    expect(sectionList()).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="settings-section-row"]').length)
      .toBeGreaterThan(0)
    expect(container.querySelector('.witem')).toBeNull()

    act(() => footSettingsButton(container).click())
    expect(sectionList()).toBeNull()
    expect(container.querySelector('.witem')).not.toBeNull()
  })

  it('the footer remains unselected while Settings shows the current section', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')
    expect(footSettingsButton(container).getAttribute('aria-current')).toBeNull()
    expect(footSettingsButton(container).className).not.toContain('bg-selected-fill')
    act(() => footSettingsButton(container).click())
    expect(footSettingsButton(container).getAttribute('aria-current')).toBeNull()
    expect(footSettingsButton(container).className).not.toContain('bg-selected-fill')
    expect(container.querySelector('[data-testid="settings-section-row"][aria-current="true"]')).not.toBeNull()
  })
})
