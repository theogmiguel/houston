// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { waitFor } from '@testing-library/react'
import { renderReadyApp, resetHarness, type AppHarness } from './test/appTestHarness'
import { setSettingsNavForTests } from './settingsNav'
import { RAIL_VIEWS } from './railView'

let harness: AppHarness | null = null

beforeEach(() => {
  resetHarness()
  setSettingsNavForTests({ open: false, section: 'appearance' })
})

afterEach(() => {
  harness?.unmount()
  harness = null
})

function navRow(container: HTMLElement, view: string): HTMLButtonElement {
  const el = container.querySelector(`[data-testid="rail-nav-row"][data-view="${view}"]`)
  if (!(el instanceof HTMLButtonElement)) throw new Error(`no rail nav row ${view}`)
  return el
}

const surface = (c: HTMLElement): Element | null => c.querySelector('[data-testid="nav-surface"]')

describe('the rail nav rows drive the content area', () => {
  it.each(RAIL_VIEWS)('the %s page fills the content region, so its column centres', async (view) => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')
    act(() => navRow(container, view).click())
    await waitFor(() => expect(surface(container)).not.toBeNull())
    expect(surface(container)!.className).toMatch(/(^|\s)(flex-1|w-full)(\s|$)/)
  })

  it('Ctrl+, closes Settings even while its search input is focused', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')
    const gear = container.querySelector('.railfoot button[aria-label="Settings"]') as HTMLButtonElement
    act(() => gear.click())
    const search = container.querySelector('[aria-label="Search settings"]') as HTMLInputElement
    search.focus()
    act(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true, cancelable: true })))
    expect(gear.getAttribute('aria-pressed')).toBe('false')
  })

  it('Escape clears and leaves search first, then closes Settings on the next press', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')
    const gear = container.querySelector('.railfoot button[aria-label="Settings"]') as HTMLButtonElement
    act(() => gear.click())
    const search = container.querySelector('[aria-label="Search settings"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(search, 'font size')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    search.focus()
    act(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(gear.getAttribute('aria-pressed')).toBe('true')
    expect(search.value).toBe('')
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(gear.getAttribute('aria-pressed')).toBe('false')
  })

  it('each destination opens a surface — none of them opens onto nothing', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')

    expect(surface(container)).toBeNull()

    for (const view of RAIL_VIEWS) {
      act(() => navRow(container, view).click())
      await waitFor(() => {
        const el = surface(container)
        expect(el, `${view} opened no surface`).not.toBeNull()
        expect(el?.textContent?.trim().length ?? 0, `${view} surface is blank`).toBeGreaterThan(0)
      })
      expect(navRow(container, view).getAttribute('aria-current')).toBe('page')
    }
  })

  it('the same row closes it again — the way out is the way in', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')

    act(() => navRow(container, 'skills').click())
    expect(surface(container)).not.toBeNull()
    act(() => navRow(container, 'skills').click())
    expect(surface(container)).toBeNull()
    expect(navRow(container, 'skills').getAttribute('aria-current')).toBeNull()
  })

  it('the rows leave the rail while Settings is open and drive the content area once it closes', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')

    const settingsBtn = container.querySelector('.railfoot button[aria-label="Settings"]')
    act(() => (settingsBtn as HTMLButtonElement).click())
    expect(container.querySelector('[aria-label="Settings sections"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="rail-nav-row"]').length).toBe(0)

    act(() => (container.querySelector('.railfoot button[aria-label="Settings"]') as HTMLButtonElement).click())
    expect(container.querySelectorAll('[data-testid="rail-nav-row"]').length).toBe(
      RAIL_VIEWS.length
    )
    act(() => navRow(container, 'mcp').click())
    expect(container.querySelector('[aria-label="Settings sections"]')).toBeNull()
    expect(surface(container)).not.toBeNull()
  })

  it('the grid is hidden underneath, not unmounted (B6b)', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')

    act(() => navRow(container, 'mcp').click())
    const slot = container.querySelector('.grid-slot')
    expect(slot).not.toBeNull()
    expect(slot?.className).toContain('grid-hidden')
  })

  it('Escape closes the surface and lands back on the grid', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')

    act(() => navRow(container, 'mcp').click())
    expect(surface(container)).not.toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(surface(container)).toBeNull()
  })

  it('a hidden row is gone from the rail, and Settings holds the switch that returns it', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')
    const { setRailViewHidden } = await import('./railView')

    expect(container.querySelectorAll('[data-testid="rail-nav-row"]').length).toBe(
      RAIL_VIEWS.length
    )
    act(() => setRailViewHidden('routines', true))
    expect(container.querySelector('[data-testid="rail-nav-row"][data-view="routines"]')).toBeNull()

    act(() => setRailViewHidden('routines', false))
    expect(
      container.querySelector('[data-testid="rail-nav-row"][data-view="routines"]')
    ).not.toBeNull()
  })

  it('hiding the row you are looking at closes its surface — no orphan view', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const { act } = await import('react')
    const { setRailViewHidden } = await import('./railView')

    act(() => navRow(container, 'skills').click())
    expect(surface(container)).not.toBeNull()
    act(() => setRailViewHidden('skills', true))
    expect(surface(container)).toBeNull()
  })
})
