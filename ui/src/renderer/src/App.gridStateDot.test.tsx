// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    // The rail row is lazy; its Suspense fallback carries no status to assert on.
    await vi.waitFor(() => {
      const state = harness!.container.querySelector<HTMLElement>(
        '[data-testid="grid-row"] [data-testid="grid-state-dot"]'
      )?.dataset.state
      if (state === undefined || state === 'loading') throw new Error(`grid row still loading: ${state}`)
    })
  }

  const dot = (): HTMLElement => {
    const el = harness!.container.querySelector<HTMLElement>(
      '[data-testid="grid-row"] [data-testid="grid-state-dot"]'
    )
    if (!el) throw new Error('grid-row state dot not rendered')
    return el
  }

  it('a ready session paints a neutral idle dot', async () => {
    await boot([makeSession({ id: 1, project_dir: WS, cwd: WS, state: 'running', status: 'idle' })])
    expect(dot().dataset.state).toBe('idle')
  })

  it('a running session waiting on the user paints it needs-input', async () => {
    await boot([
      makeSession({ id: 1, project_dir: WS, cwd: WS, state: 'running', status: 'needs-input' })
    ])
    expect(dot().dataset.state).toBe('needs-input')
  })

  it('a grid whose only session has exited paints it stopped', async () => {
    await boot([makeSession({ id: 1, project_dir: WS, cwd: WS, state: 'exited' })])
    expect(dot().dataset.state).toBe('stopped')
  })

  it('working and spawning remain distinct lifecycle states', async () => {
    await boot([makeSession({ id: 1, project_dir: WS, cwd: WS, status: 'working' })])
    expect(dot().dataset.state).toBe('working')

    deliverControl({ type: 'agent_status', session: 1, status: 'spawning' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(dot().dataset.state).toBe('starting')
  })

  it('an unavailable status is explicit and accessible', async () => {
    await boot([makeSession({ id: 1, project_dir: WS, cwd: WS, status: 'unavailable' })])
    expect(dot().dataset.state).toBe('unavailable')
    expect(dot().getAttribute('aria-label')).toContain('status unavailable')
  })

  it('the dot moves with the hooks-driven status stream, not only the boot snapshot', async () => {
    await boot([makeSession({ id: 1, project_dir: WS, cwd: WS, state: 'running', status: 'idle' })])
    expect(dot().dataset.state).toBe('idle')

    deliverControl({ type: 'agent_status', session: 1, status: 'needs-input' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(dot().dataset.state).toBe('needs-input')
  })
})
