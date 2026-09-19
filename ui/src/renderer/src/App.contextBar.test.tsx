// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setContextBarForTests, setContextBarVisible } from './contextBarPref'
import {
  type AppHarness,
  deliverHelloOk,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

const WS = '/tmp/project'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
  setContextBarForTests(true)
})

describe('context downbar visibility', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  async function boot(): Promise<void> {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [makeSession({ id: 1, project_dir: WS, cwd: WS, state: 'running' })],
      workspaces: [makeWorkspace({ path: WS })]
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  it('hidden toggle removes the downbar row', async () => {
    await boot()
    expect(harness!.container.querySelector('[data-testid="context-downbar"]')).not.toBeNull()
    act(() => setContextBarVisible(false))
    expect(harness!.container.querySelector('[data-testid="context-downbar"]')).toBeNull()
  })
})
