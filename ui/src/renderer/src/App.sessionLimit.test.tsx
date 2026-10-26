// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest'
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
  harness = await renderReadyApp()
})

afterEach(() => {
  harness?.unmount()
  harness = null
})

it('shows a reported limit as a neutral detail beside the status and clears it on the next turn', async () => {
  const limit = (): Element | null => harness!.container.querySelector('[data-testid="pane-limit"]')
  expect(limit()).toBeNull()

  deliverControl({ type: 'agent_detected', session: 1, agent: 'claude' })
  deliverControl({
    type: 'session_limit',
    session: 1,
    limit: { error: 'rate_limit', details: 'Usage limit reached', since_ms: Date.now() }
  })

  const detail = limit()
  expect(detail?.textContent).toBe('Limited')
  expect(detail?.getAttribute('aria-label')).toContain('rate_limit (Usage limit reached)')
  expect(detail?.getAttribute('aria-label')).not.toContain('no reset time')
  expect(detail?.closest('.head-actions')).not.toBeNull()
  expect(detail?.querySelector('[class*="--warn"], [class*="--stop"]')).toBeNull()

  deliverControl({ type: 'session_limit', session: 1, limit: null })
  expect(limit()).toBeNull()
})

it('shows a ZCode quota limit with its reset detail, like any provider limit', async () => {
  const limit = (): Element | null => harness!.container.querySelector('[data-testid="pane-limit"]')
  deliverControl({ type: 'agent_detected', session: 1, agent: 'zcode' })
  deliverControl({
    type: 'session_limit',
    session: 1,
    limit: { error: 'quota', details: 'Coding Plan quota exhausted; resets at 10:00', since_ms: Date.now() }
  })

  const detail = limit()
  expect(detail?.textContent).toBe('Limited')
  const label = detail?.getAttribute('aria-label') ?? ''
  expect(label).toContain('quota (Coding Plan quota exhausted; resets at 10:00)')
  expect(label).not.toContain('Claude')
})
