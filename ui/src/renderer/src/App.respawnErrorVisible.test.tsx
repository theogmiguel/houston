// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deliverControl, renderReadyApp, resetHarness, type AppHarness } from './test/appTestHarness'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('respawn failures are visible via the shared control-error banner (finding 1b)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('a session_respawn rejection (ssh bail, e.g.) renders in the dismissible error banner', async () => {
    harness = await renderReadyApp()
    const { container } = harness

    deliverControl({
      type: 'error',
      message: 'ssh sessions open via ssh_connect, not session_create/respawn',
      context: null
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain(
      'ssh sessions open via ssh_connect, not session_create/respawn'
    )
  })

  it('the banner is dismissible and does not resurrect on its own', async () => {
    harness = await renderReadyApp()
    const { container } = harness

    deliverControl({ type: 'error', message: 'respawn failed: no such file or directory', context: null })
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent).toContain('respawn failed: no such file or directory')

    const row = Array.from(container.querySelectorAll('[data-notice]')).find((n) =>
      n.textContent?.includes('respawn failed: no such file or directory')
    )
    expect(row).toBeDefined()
    const dismiss = row!.querySelector('button[aria-label^="Dismiss"]')
    expect(dismiss).not.toBeNull()
    act(() => dismiss!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect(container.textContent).not.toContain('respawn failed: no such file or directory')
  })
})
