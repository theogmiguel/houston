// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AppHarness,
  currentClient,
  deliverControl,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

function click(el: Element | null | undefined, what: string): void {
  if (!el) throw new Error(`${what} not found`)
  act(() => {
    ;(el as HTMLElement).click()
  })
}

let harness: AppHarness | null = null

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})
afterEach(() => {
  harness?.unmount()
  harness = null
  vi.clearAllMocks()
})

describe('New session opens an empty grid', () => {
  const WS = '/tmp/project'
  it('creates a blank grid without spawning, then launches Terminal directly', async () => {
    harness = await renderReadyApp({ sessions: [makeSession({ id: 1 })], workspaces: [makeWorkspace({ path: WS })] })
    const { container } = harness
    const createSession = currentClient().createSession as ReturnType<typeof vi.fn>
    createSession.mockClear()
    click(container.querySelector('[data-testid="ws-new-session"]'), 'New session')
    expect(JSON.parse(localStorage.getItem(`tr-grids:${WS}`) ?? '[]')).toHaveLength(2)
    expect(createSession).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="new-session-composer"]')).toBeNull()
    click(container.querySelector('[data-testid="workspace-empty-terminal"]'), 'Terminal')
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ agent: 'shell', project_dir: WS }))
  })

  it('a cross-workspace session_created joins its destination without switching the current workspace', async () => {
    const destination = '/tmp/other'
    harness = await renderReadyApp({
      sessions: [makeSession({ id: 1, project_dir: WS, cwd: WS })],
      workspaces: [
        makeWorkspace({ path: WS, name: 'project' }),
        makeWorkspace({ path: destination, name: 'other' })
      ]
    })

    deliverControl({
      type: 'session_created',
      info: makeSession({ id: 2, project_dir: destination, cwd: destination, agent: 'claude' })
    })
    await act(async () => {
      await Promise.resolve()
    })

    const selected = Array.from(
      harness.container.querySelectorAll<HTMLElement>('.witem[aria-current="true"]')
    )
    expect(selected.some((item) => item.textContent?.includes('project'))).toBe(true)
    expect(selected.some((item) => item.textContent?.includes('other'))).toBe(false)
    expect(
      harness.container.querySelector(`[data-workspace="${destination}"] [data-panekey="2"]`)
    ).not.toBeNull()
  })
})
