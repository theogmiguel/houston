// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  currentClient,
  deliverControl,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness,
  type AppHarness
} from './test/appTestHarness'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

afterEach(() => {
  harness?.unmount()
  harness = undefined
})

let harness: AppHarness | undefined

describe('an exited pane', () => {
  it('says its exit code and offers Restart under the retained output', async () => {
    harness = await renderReadyApp({
      sessions: [makeSession({ id: 1, state: 'exited' })],
      workspaces: [makeWorkspace()]
    })
    const state = (): HTMLElement | null => harness!.container.querySelector('[data-testid="pane-state"]')
    const footer = (): HTMLElement | null => harness!.container.querySelector('[data-testid="exit-footer"]')
    expect(state()?.textContent).toContain('Exited')
    expect(state()?.textContent).not.toContain('code')
    expect(footer()?.textContent).toContain('The shell exited.')
    expect(harness.container.querySelector('[aria-label="Restart"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="terminal-skeleton"]')).not.toBeNull()
    expect(harness.container.querySelector('[data-testid="terminal-skeleton-cursor"]')).toBeNull()

    deliverControl({ type: 'session_state', session: 1, state: 'exited', exit_code: 3 })
    await act(async () => {
      await Promise.resolve()
    })
    expect(state()?.textContent).toContain('Exited with code 3')
    expect(footer()?.textContent).toContain('The shell exited with code 3.')

    const restart = [...footer()!.querySelectorAll('button')].find((button) => button.textContent === 'Restart')
    expect(restart).toBeDefined()
    await act(async () => {
      restart!.click()
      await Promise.resolve()
    })
    expect(currentClient().respawnSession).toHaveBeenCalledWith(1, expect.any(Boolean))
  })

  it('keeps a clean exit quiet on the danger axis', async () => {
    harness = await renderReadyApp({
      sessions: [makeSession({ id: 1, state: 'exited' })],
      workspaces: [makeWorkspace()]
    })
    deliverControl({ type: 'session_state', session: 1, state: 'exited', exit_code: 0 })
    await act(async () => {
      await Promise.resolve()
    })
    const footer = harness.container.querySelector<HTMLElement>('[data-testid="exit-footer"]')!
    expect(footer.dataset.tone).toBe('default')
    expect(harness.container.querySelector('[data-testid="pane-state"]')?.textContent).toContain('Exited with code 0')
  })
})
