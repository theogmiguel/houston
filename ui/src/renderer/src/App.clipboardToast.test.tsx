// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AppHarness, deliverControl, renderReadyApp, resetHarness } from './test/appTestHarness'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('App clipboard_set (OSC 52) toast', () => {
  let harness: AppHarness | null = null
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
  })

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('a successful OSC 52 write raises the "Copied" toast on the originating pane', async () => {
    harness = await renderReadyApp()
    const { container } = harness

    deliverControl({ type: 'clipboard_set', session: 1, text: 'yanked text' })
    expect(writeText).toHaveBeenCalledWith('yanked text')

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const toast = container.querySelector('[data-notice]')
    expect(toast).not.toBeNull()
    expect(toast!.textContent).toContain('Copied')
  })

  it('a rejected OSC 52 write does not raise the success toast (silent no-op, reference-style)', async () => {
    writeText.mockRejectedValue(new Error('permission denied'))
    harness = await renderReadyApp()
    const { container } = harness

    deliverControl({ type: 'clipboard_set', session: 1, text: 'yanked text' })
    expect(writeText).toHaveBeenCalledWith('yanked text')

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-notice]')).toBeNull()
  })
})
