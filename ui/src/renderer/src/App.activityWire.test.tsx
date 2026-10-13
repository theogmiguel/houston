// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppHarness, deliverControl, renderReadyApp, resetHarness } from './test/appTestHarness'

let harness: AppHarness | null = null
beforeEach(() => { resetHarness(); localStorage.clear() })
afterEach(() => { harness?.unmount(); harness = null })

describe('hook activity on the wire', () => {
  it('updates the doing-now line immediately and clears it without renaming the pane', async () => {
    harness = await renderReadyApp()
    const title = harness.container.querySelector('.pane-head')?.textContent
    act(() => deliverControl({ type: 'session_activity', id: 1, activity: { prompt: 'Fix parser' } }))
    expect(harness.container.querySelector('[data-testid="pane-doing-now"]')?.textContent).toBe('Fix parser')
    expect(harness.container.querySelector('.pane-head')?.textContent).toBe(title)
    act(() => deliverControl({ type: 'session_activity', id: 1, activity: null }))
    expect(harness.container.querySelector('[data-testid="pane-doing-now"]')).toBeNull()
  })
})
