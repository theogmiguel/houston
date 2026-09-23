// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { setContextIndicatorForTests } from './contextIndicatorPref'
import {
  type AppHarness,
  deliverControl,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

let harness: AppHarness | null = null

beforeEach(async () => {
  resetHarness()
  localStorage.clear()
  setContextIndicatorForTests(true)
  harness = await renderReadyApp()
})

afterEach(() => {
  harness?.unmount()
  harness = null
})

it('shows context received after Claude is detected in a shell pane', async () => {
  expect(harness!.container.querySelector('[data-testid="context-indicator"]')).toBeNull()

  deliverControl({ type: 'agent_detected', session: 1, agent: 'claude' })
  deliverControl({
    type: 'session_context',
    session: 1,
    context: {
      used_tokens: 69_193,
      window_tokens: 1_000_000,
      used_percent: 6,
      state: 'idle',
      source: 'derived',
      as_of_ms: Date.now()
    }
  })

  const indicator = harness!.container.querySelector('[data-testid="context-indicator"]')
  expect(indicator).not.toBeNull()
  expect(indicator?.getAttribute('aria-label')).toContain('6% used')
  expect(indicator?.closest('.head-actions')).not.toBeNull()
})
