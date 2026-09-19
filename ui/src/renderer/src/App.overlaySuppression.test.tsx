// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('./houston/host', () => ({ isTauri: () => isTauriMock() }))

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import type { AppHarness } from './test/appTestHarness'

const { renderReadyApp, resetHarness, engineCounts } = await import('./test/appTestHarness')
const { __resetNativeSuppressionForTests, setSuppressionSink, suppressedReasons } = await import(
  './layout/nativeSuppression'
)

type SinkCall = [reason: string, visible: boolean]

let calls: SinkCall[] = []

beforeEach(() => {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async () => []
  }
  localStorage.clear()
  resetHarness()
  __resetNativeSuppressionForTests()
  calls = []
  setSuppressionSink((reason, visible) => {
    calls.push([reason, visible])
  })
})

afterEach(() => {
  setSuppressionSink(null)
  __resetNativeSuppressionForTests()
})

const hides = (): number => calls.filter(([r, v]) => r === 'grid-hidden' && !v).length
const shows = (): number => calls.filter(([r, v]) => r === 'grid-hidden' && v).length

function click(el: Element | null | undefined, what: string): void {
  if (!el) throw new Error(`${what} not found`)
  act(() => {
    ;(el as HTMLElement).click()
  })
}

function byTitle(container: Element, title: string): Element | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === title || b.getAttribute('title') === title
  )
}

function openComposer(container: Element): void {
  click(byTitle(container, 'New pane'), 'a pane header’s "+" button')
  click(
    container.querySelector('[data-testid="add-pane-new-session"]'),
    'the Add-pane popover’s "New session…" row'
  )
}

describe('B6b — full-surface overlays hide the grid, never destroy it', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  const openers: Array<{ name: string; open: (container: Element) => void }> = [
    { name: 'NewSessionComposer', open: openComposer }
  ]

  for (const { name, open } of openers) {
    it(`suppresses rather than destroys when ${name} opens`, async () => {
      harness = await renderReadyApp()
      const { container } = harness

      const before = engineCounts()
      expect(before.constructed).toBeGreaterThan(0)
      expect(before.disposed).toBe(0)
      expect(hides()).toBe(0)

      open(container)

      expect(hides()).toBeGreaterThan(0)
      expect(suppressedReasons()).toContain('grid-hidden')
      expect(engineCounts().disposed).toBe(0)
      expect(engineCounts().constructed).toBe(before.constructed)
      expect(container.querySelector('.grid-slot')).not.toBeNull()
      expect(container.querySelector('.grid-slot')?.className).toContain('grid-hidden')
    })
  }

  it('shows the grid again once the last overlay closes', async () => {
    harness = await renderReadyApp()

    const toggleSettings = (): void =>
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true, cancelable: true })
        )
      })

    toggleSettings()
    expect(hides()).toBe(1)
    expect(shows()).toBe(0)

    toggleSettings()
    expect(shows()).toBe(1)
    expect(suppressedReasons()).not.toContain('grid-hidden')
    expect(engineCounts().disposed).toBe(0)
  })
})
