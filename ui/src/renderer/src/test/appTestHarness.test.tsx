// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness } from './appTestHarness'

let harness: AppHarness | null = null

afterEach(() => {
  harness?.unmount()
  harness = null
})

it('a ready app has no grid rail row still in its loading fallback', async () => {
  resetHarness()
  harness = await renderReadyApp()
  expect(harness.container.querySelector('[data-testid="grid-row"]')).not.toBeNull()
  expect(harness.container.querySelector('[data-testid="grid-state-dot"][data-state="loading"]')).toBeNull()
})
