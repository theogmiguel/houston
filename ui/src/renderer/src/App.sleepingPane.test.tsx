// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  deliverControl,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('a pane put to sleep while the app is connected', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('shows how long it has slept from the session_updated cues', async () => {
    const live = makeSession({ id: 7, agent: 'claude', state: 'running', status: 'idle', title: 'worker' })
    harness = await renderReadyApp({ sessions: [live], workspaces: [makeWorkspace()] })

    // The daemon's Sleep sends the state change, then the retained cues.
    const sleptAt = Date.now() - 5 * 60_000
    deliverControl({ type: 'session_state', session: 7, state: 'sleeping', exit_code: null })
    deliverControl({
      type: 'session_updated',
      info: { ...live, state: 'sleeping', status: null, slept_at_ms: sleptAt, latest_prompt: 'Refactor the parser', last_agent_message: 'Done.' }
    })

    const text = harness.container.textContent ?? ''
    expect(text).toContain('Session sleeping')
    expect(text).toContain('Time asleep: 5m')
    expect(text).not.toContain('Time asleep: unavailable')
    expect(text).toContain('Refactor the parser')
  })

  it('shows a refused Wake notice the daemon broadcasts', async () => {
    const sleeping = makeSession({ id: 7, agent: 'claude', state: 'sleeping', title: 'worker', slept_at_ms: Date.now() - 60_000 })
    harness = await renderReadyApp({ sessions: [sleeping], workspaces: [makeWorkspace()] })

    deliverControl({
      type: 'session_updated',
      info: { ...sleeping, sleep_notice: 'Wake refused for session 7: the exact provider conversation handle is unavailable.' }
    })

    expect(harness.container.textContent).toContain('the exact provider conversation handle is unavailable')
  })
})
