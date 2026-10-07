// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from './houston/client'
import {
  type AppHarness,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

const WS = '/tmp/project'

function sessionWithCheckout(
  overrides: Parameters<typeof makeSession>[0],
  checkout?: unknown
): SessionInfo {
  return { ...makeSession(overrides), checkout } as SessionInfo
}

function paneChip(harness: AppHarness, id: number): HTMLElement | null {
  return harness.container.querySelector<HTMLElement>(
    `section.pane[data-panekey="${id}"] [data-testid="branch-chip"]`
  )
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('checkout identity in pane headers', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('shows each pane checkout from its session even before focus or git replies', async () => {
    harness = await renderReadyApp({
      sessions: [
        sessionWithCheckout({ id: 1, cwd: WS, project_dir: WS }, { root: WS, kind: 'primary', branch: 'main', head: 'abcdef0' }),
        sessionWithCheckout({ id: 2, cwd: `${WS}-wt`, project_dir: WS }, { root: `${WS}-wt`, kind: { worktree: { slug: 'feature' } }, branch: 'feat/x', head: '1234567' })
      ],
      workspaces: [makeWorkspace({ path: WS })]
    })

    expect(paneChip(harness, 1)?.textContent).toContain('primary · main')
    expect(paneChip(harness, 2)?.textContent).toContain('wt/feature · feat/x')
  })

  it('shows remote host identity and hides an unknown local checkout', async () => {
    harness = await renderReadyApp({
      sessions: [
        makeSession({ id: 1, cwd: WS, project_dir: WS }),
        makeSession({ id: 2, agent: 'ssh', ssh_host: 'buildbox', cwd: '/remote', project_dir: '/remote' })
      ],
      workspaces: [makeWorkspace({ path: WS }), makeWorkspace({ path: '/remote', name: 'Remote' })]
    })

    expect(paneChip(harness, 1)).toBeNull()
    expect(paneChip(harness, 2)?.textContent).toContain('remote · buildbox')
  })
})
