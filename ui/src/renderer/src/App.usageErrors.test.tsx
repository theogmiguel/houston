// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { deliverControl, renderReadyApp, resetHarness, settleLazySurface, type AppHarness } from './test/appTestHarness'

let harness: AppHarness | null = null
beforeEach(() => { resetHarness(); localStorage.clear() })
afterEach(() => { harness?.unmount(); harness = null })

it('a correlated scan failure clears loading and lets Usage retry from the notice', async () => {
  harness = await renderReadyApp()
  const { container } = harness
  await act(async () => {
    ;(container.querySelector('[data-testid="rail-nav-row"][data-view="usage"]') as HTMLButtonElement).click()
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
  expect(container.querySelector('[data-testid="usage-error-empty"]')).not.toBeNull()
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Try again')
  expect(retry).toBeDefined()
  act(() => (retry as HTMLButtonElement).click())
  expect(refresh().disabled).toBe(true)
  expect(container.querySelector('[data-testid="usage-error"]')).toBeNull()
})
