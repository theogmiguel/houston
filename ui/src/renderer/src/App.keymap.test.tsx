// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AppHarness,
  deliverControl,
  renderReadyApp,
  resetHarness,
  settleLazySurface
} from './test/appTestHarness'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

function dispatchChord(init: Partial<KeyboardEventInit>): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    )
  })
}

async function openHandoff(harness: AppHarness): Promise<void> {
  const pane = harness.container.querySelector('.pane')
  if (!(pane instanceof HTMLElement)) throw new Error('no .pane rendered')
  act(() => {
    pane.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    )
  })
  const open = Array.from(harness.container.querySelectorAll('.ctx-item')).find((el) =>
    el.textContent?.includes('Handoff…')
  )
  if (!open) throw new Error('no "Handoff…" menu item found')
  act(() => {
    open.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settleLazySurface(
    () => document.querySelector('[data-testid="pane-handoff"]') !== null,
    'the Handoff dialog'
  )
}

describe('App keymap remap seam (P4 #16)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('drives zoom-in through a remapped chord and stops responding to the built-in one', async () => {
    harness = await renderReadyApp()

    const setZoomFactor = window.houston.setZoomFactor as unknown as ReturnType<typeof vi.fn>
    setZoomFactor.mockClear()

    deliverControl({
      type: 'keymap',
      overrides: {
        bindings: {
          'zoom-in': { code: 'KeyJ', ctrl: true, alt: false, shift: true, meta: false }
        },
        shortcuts_enabled: true
      }
    })

    dispatchChord({ code: 'KeyJ', ctrlKey: true, shiftKey: true })
    expect(setZoomFactor).toHaveBeenCalledTimes(1)

    setZoomFactor.mockClear()

    dispatchChord({ code: 'Equal', ctrlKey: true })
    expect(setZoomFactor).not.toHaveBeenCalled()
  })

  it('suppresses a global chord while the kill-switch is off, then fires it the instant it is turned back on', async () => {
    harness = await renderReadyApp()

    const setZoomFactor = window.houston.setZoomFactor as unknown as ReturnType<typeof vi.fn>
    setZoomFactor.mockClear()

    deliverControl({
      type: 'keymap',
      overrides: { bindings: {}, shortcuts_enabled: false }
    })

    dispatchChord({ code: 'Equal', ctrlKey: true })
    expect(setZoomFactor).not.toHaveBeenCalled()

    deliverControl({
      type: 'keymap',
      overrides: { bindings: {}, shortcuts_enabled: true }
    })

    dispatchChord({ code: 'Equal', ctrlKey: true })
    expect(setZoomFactor).toHaveBeenCalledTimes(1)
  })

  describe('Escape is exempt from the kill-switch (handoff dialog)', () => {
    it('closes the handoff dialog via a real Escape keydown while shortcuts_enabled is false', async () => {
      harness = await renderReadyApp()

      deliverControl({
        type: 'keymap',
        overrides: { bindings: {}, shortcuts_enabled: false }
      })

      await openHandoff(harness)
      expect(document.querySelector('[data-testid="pane-handoff"]')).not.toBeNull()

      dispatchChord({ key: 'Escape' })

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250))
      })

      expect(document.querySelector('[data-testid="pane-handoff"]')).toBeNull()
    })

    it('calls preventDefault on that Escape, so the key does not also leak to the focused terminal', async () => {
      harness = await renderReadyApp()

      deliverControl({
        type: 'keymap',
        overrides: { bindings: {}, shortcuts_enabled: false }
      })

      await openHandoff(harness)

      let event: KeyboardEvent | undefined
      act(() => {
        event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        window.dispatchEvent(event)
      })

      expect(event?.defaultPrevented).toBe(true)
    })
  })
})
