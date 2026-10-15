// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppHarness, deliverControl, renderReadyApp, resetHarness } from './test/appTestHarness'

let harness: AppHarness | null = null
beforeEach(() => { resetHarness(); localStorage.clear() })
afterEach(() => { harness?.unmount(); harness = null })

describe('hook activity on the wire', () => {
  it('applies activity without renaming the pane or repeating it under the header', async () => {
    harness = await renderReadyApp()
    const title = harness.container.querySelector('.pane-head')?.textContent
    act(() => deliverControl({ type: 'session_activity', id: 1, activity: { prompt: 'Fix parser', last_message: 'Parser fixed' } }))
    expect(harness.container.querySelector('.pane-head')?.textContent).toBe(title)
    expect(harness.container.querySelector('[data-testid="pane-doing-now"]')).toBeNull()
    expect(harness.container.querySelector('section.pane')?.textContent).not.toContain('Parser fixed')
  })
})
