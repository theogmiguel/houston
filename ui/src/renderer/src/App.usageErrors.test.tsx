// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { deliverControl, renderReadyApp, resetHarness, settleLazySurface, type AppHarness } from './test/appTestHarness'

let harness: AppHarness | null = null
beforeEach(() => { resetHarness(); localStorage.clear() })
afterEach(() => { harness?.unmount(); harness = null })

it('a correlated scan failure clears loading and lets Usage refresh again', async () => {
  harness = await renderReadyApp()
  const { container } = harness
  await act(async () => {
    ;(container.querySelector('.railfoot button[aria-label="Usage"]') as HTMLButtonElement).click()
    await import('./components/UsageSection')
  })
  await settleLazySurface(() => container.querySelector('[data-testid="usage-refresh"]') !== null, 'usage')
  const refresh = (): HTMLButtonElement => container.querySelector('[data-testid="usage-refresh"]') as HTMLButtonElement
  expect(refresh().disabled).toBe(true)
  deliverControl({ type: 'error', message: 'git target missing', context: 'git_status' })
  expect(refresh().disabled).toBe(true)
  deliverControl({ type: 'error', message: 'usage scan panicked: task failed', context: 'usage_summary' })
  expect(refresh().disabled).toBe(false)
  expect(container.querySelector('[data-testid="usage-error"]')?.textContent).toContain('usage scan panicked: task failed')
  act(() => refresh().click())
  expect(refresh().disabled).toBe(true)
  expect(container.querySelector('[data-testid="usage-error"]')).toBeNull()
})
