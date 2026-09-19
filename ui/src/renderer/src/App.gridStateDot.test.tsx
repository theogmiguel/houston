// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from './houston/client'
import {
  type AppHarness,
  deliverControl,
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
})

describe("grid-row state dot follows the grid's live sessions", () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  async function boot(sessions: SessionInfo[]): Promise<void> {
    harness = await renderReadyApp()
    deliverHelloOk({ sessions, workspaces: [makeWorkspace({ path: WS })] })
    await act(async () => {
      await Promise.resolve()
    })
  }

  const dot = (): HTMLElement => {
    const el = harness!.container.querySelector<HTMLElement>(
      '[data-testid="grid-row"] [data-testid="grid-state-dot"]'
    )
    if (!el) throw new Error('grid-row state dot not rendered')
    return el
  }

  it('a running session in the grid paints the dot online', async () => {
    await boot([makeSession({ id: 1, project_dir: WS, cwd: WS, state: 'running', status: 'idle' })])
    expect(dot().dataset.state).toBe('online')
  })

  it('a running session waiting on the user paints it warning', async () => {
    await boot([
      makeSession({ id: 1, project_dir: WS, cwd: WS, state: 'running', status: 'needs-input' })
    ])
    expect(dot().dataset.state).toBe('warning')
  })

  it('a grid whose only session has exited paints it idle', async () => {
    await boot([makeSession({ id: 1, project_dir: WS, cwd: WS, state: 'exited' })])
    expect(dot().dataset.state).toBe('idle')
  })

  it('the dot moves with the hooks-driven status stream, not only the boot snapshot', async () => {
    await boot([makeSession({ id: 1, project_dir: WS, cwd: WS, state: 'running', status: 'idle' })])
    expect(dot().dataset.state).toBe('online')

    deliverControl({ type: 'agent_status', session: 1, status: 'needs-input' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(dot().dataset.state).toBe('warning')
  })
})
