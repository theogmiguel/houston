// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppHarness, deliverClientMsg, makeSession, renderReadyApp, resetHarness } from './test/appTestHarness'

let harness: AppHarness | null = null
beforeEach(() => { resetHarness(); localStorage.clear() })
afterEach(() => { harness?.unmount(); harness = null })

describe('session_updated on the wire', () => {
  it('replaces the pane info, so an export marks its pane Transferred without a reconnect', async () => {
    harness = await renderReadyApp()
    expect(harness.container.querySelector('[data-testid="pane-transferred"]')).toBeNull()
    act(() => deliverClientMsg('session_updated', { type: 'session_updated', info: makeSession({ state: 'exited', transferred_at_ms: Date.UTC(2026, 9, 22, 2, 8) }) }))
    expect(harness.container.querySelector('[data-testid="pane-transferred"]')?.textContent).toMatch(/^Transferred /)
  })

  it('ignores an update for a pane this client does not list', async () => {
    harness = await renderReadyApp()
    act(() => deliverClientMsg('session_updated', { type: 'session_updated', info: makeSession({ id: 99, title: 'elsewhere' }) }))
    expect(harness.container.textContent).not.toContain('elsewhere')
  })
})
