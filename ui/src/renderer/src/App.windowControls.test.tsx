// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderReadyApp, resetHarness, type AppHarness } from './test/appTestHarness'
import { FALLBACK_WINDOW_BUTTON_LAYOUT } from './windowButtonLayout'

let harness: AppHarness | null = null

beforeEach(() => resetHarness())
afterEach(() => {
  harness?.unmount()
  harness = null
})

describe('titlebar window controls (charter §20)', () => {
  it('renders WindowControls, and none of the macOS hex values survive', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    expect(container.querySelector('[data-testid="window-controls"]')).not.toBeNull()
    const html = container.innerHTML
    for (const hex of ['#ff5f57', '#febc2e', '#28c840']) {
      expect(html).not.toContain(hex)
    }
  })

  it('falls back to the documented layout under a host that reports nothing', async () => {
    harness = await renderReadyApp()
    const controls = harness.container.querySelector('[data-testid="window-controls"]')
    if (!(controls instanceof HTMLElement)) throw new Error('window controls did not render')
    const labels = [...controls.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual(
      FALLBACK_WINDOW_BUTTON_LAYOUT.buttons.map(
        (k) => k.charAt(0).toUpperCase() + k.slice(1)
      )
    )
  })

  it('honours the layout\'s buttons and their order, even though the docking cell is now fixed', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const controls = container.querySelector('[data-testid="window-controls"]')
    if (!(controls instanceof HTMLElement)) throw new Error('window controls did not render')

    const rendered = [...controls.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    const LABEL: Record<string, string> = {
      close: 'Close',
      minimize: 'Minimize',
      maximize: 'Maximize'
    }
    expect(rendered).toEqual(FALLBACK_WINDOW_BUTTON_LAYOUT.buttons.map((b) => LABEL[b]))
    expect(rendered.length).toBe(FALLBACK_WINDOW_BUTTON_LAYOUT.buttons.length)
  })

  it('docks in the TOPBAR, not the rail — the one placement the L still gets wrong if hoisting slips', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const controls = container.querySelector('[data-testid="window-controls"]')
    const rail = container.querySelector('aside')
    if (!(controls instanceof HTMLElement) || !(rail instanceof HTMLElement)) {
      throw new Error('shell did not render both the window controls and the rail')
    }
    expect(rail.contains(controls)).toBe(false)
  })
})
