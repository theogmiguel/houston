// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, type Mock } from 'vitest'
import {
  type AppHarness,
  currentClient,
  deliverControl,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'
import type { SessionInfo, Workspace } from './houston/client'

const MAIN = '/repo/nexus'
const WORKTREE = '/repo/nexus-pdi-flags'
const OTHER_REPO = '/repo/other'
const COMMON = '/repo/nexus/.git'

function gitBranchCalls(): string[] {
  return (currentClient().gitBranch as unknown as Mock).mock.calls.map((c) => c[0] as string)
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function reply(
  dir: string,
  branch: string | null,
  toplevel: string | null,
  commonDir: string | null
): void {
  deliverControl({ type: 'git_branch', dir, branch, toplevel, common_dir: commonDir })
}

function chip(harness: AppHarness, testid: string): HTMLElement | null {
  return harness.container.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
}

function focusPane(harness: AppHarness, id: number): void {
  const pane = harness.container.querySelector(`section.pane[data-panekey="${id}"]`)
  if (!pane) throw new Error(`pane ${id} was not rendered, so this file would test nothing`)
  act(() => {
    pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
  })
}

async function boot(sessions: SessionInfo[], workspaces: Workspace[]): Promise<AppHarness> {
  const h = await renderReadyApp({ sessions, workspaces })
  await flush()
  return h
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('checkout ownership warning', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('shared checkout chip names the count', async () => {
    harness = await boot(
      [
        makeSession({ id: 1, title: 'oak', cwd: MAIN, project_dir: MAIN }),
        makeSession({ id: 2, title: 'shell-1', cwd: MAIN, project_dir: MAIN })
      ],
      [makeWorkspace({ path: MAIN, name: 'nexus' })]
    )
    reply(MAIN, 'feat/rebalancing', MAIN, COMMON)
    await flush()

    const shared = chip(harness, 'shared-checkout-chip')
    expect(shared).not.toBeNull()
    expect(shared!.textContent).toContain('2 panes')
    expect(chip(harness, 'same-repository-chip')).toBeNull()
    // The first boot in a file pays the lazy-surface import cost; under a
    // parallel suite that can outlast vitest's default 5s.
  }, 20000)

  it('same repository chip names the other workspace', async () => {
    harness = await boot(
      [
        makeSession({ id: 1, title: 'oak', cwd: MAIN, project_dir: MAIN }),
        makeSession({ id: 2, title: 'cedar', cwd: WORKTREE, project_dir: WORKTREE })
      ],
      [
        makeWorkspace({ path: MAIN, name: 'nexus' }),
        makeWorkspace({ path: WORKTREE, name: 'nexus-pdi-flags' })
      ]
    )
    reply(MAIN, 'feat/rebalancing', MAIN, COMMON)
    reply(WORKTREE, 'feat/pdi', WORKTREE, COMMON)
    await flush()

    const repository = chip(harness, 'same-repository-chip')
    expect(repository).not.toBeNull()
    expect(repository!.textContent).toContain('nexus-pdi-flags')
    expect(chip(harness, 'shared-checkout-chip')).toBeNull()
  })

  it('different repositories show no chip', async () => {
    harness = await boot(
      [
        makeSession({ id: 1, title: 'oak', cwd: MAIN, project_dir: MAIN }),
        makeSession({ id: 2, title: 'cedar', cwd: OTHER_REPO, project_dir: OTHER_REPO })
      ],
      [
        makeWorkspace({ path: MAIN, name: 'nexus' }),
        makeWorkspace({ path: OTHER_REPO, name: 'other' })
      ]
    )
    reply(MAIN, 'feat/rebalancing', MAIN, COMMON)
    reply(OTHER_REPO, 'main', OTHER_REPO, `${OTHER_REPO}/.git`)
    await flush()

    expect(chip(harness, 'shared-checkout-chip')).toBeNull()
    expect(chip(harness, 'same-repository-chip')).toBeNull()
  })

  it('unknown identity is excluded', async () => {
    harness = await boot(
      [
        makeSession({ id: 1, title: 'oak', cwd: MAIN, project_dir: MAIN }),
        makeSession({ id: 2, title: 'shell-1', cwd: MAIN, project_dir: MAIN }),
        makeSession({ id: 3, title: 'plain', cwd: '/tmp/plain', project_dir: MAIN })
      ],
      [makeWorkspace({ path: MAIN, name: 'nexus' })]
    )
    reply(MAIN, 'feat/rebalancing', MAIN, COMMON)
    reply('/tmp/plain', null, null, null)
    await flush()

    const shared = chip(harness, 'shared-checkout-chip')
    expect(shared).not.toBeNull()
    expect(shared!.textContent).toContain('2 panes')
    expect(chip(harness, 'same-repository-chip')).toBeNull()
  })

  it('session exit removes the chip', async () => {
    harness = await boot(
      [
        makeSession({ id: 1, title: 'oak', cwd: MAIN, project_dir: MAIN }),
        makeSession({ id: 2, title: 'shell-1', cwd: MAIN, project_dir: MAIN })
      ],
      [makeWorkspace({ path: MAIN, name: 'nexus' })]
    )
    reply(MAIN, 'feat/rebalancing', MAIN, COMMON)
    await flush()
    expect(chip(harness, 'shared-checkout-chip')).not.toBeNull()

    deliverControl({ type: 'session_state', session: 2, state: 'exited', exit_code: 0 })
    await flush()
    expect(chip(harness, 'shared-checkout-chip')).toBeNull()
  })

  it('chip lists pane titles and cwds', async () => {
    harness = await boot(
      [
        makeSession({ id: 1, title: 'oak', cwd: MAIN, project_dir: MAIN }),
        makeSession({ id: 2, title: 'shell-1', cwd: MAIN, project_dir: MAIN })
      ],
      [makeWorkspace({ path: MAIN, name: 'nexus' })]
    )
    reply(MAIN, 'feat/rebalancing', MAIN, COMMON)
    await flush()

    const shared = chip(harness, 'shared-checkout-chip')!
    act(() => {
      shared.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    const tip = document.body.querySelector('[role="tooltip"]')
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toContain('oak')
    expect(tip!.textContent).toContain('shell-1')
    expect(tip!.textContent).toContain(MAIN)
  })

  it('no requests without a focus or session change', async () => {
    harness = await boot(
      [
        makeSession({ id: 1, title: 'oak', cwd: MAIN, project_dir: MAIN }),
        makeSession({ id: 2, title: 'cedar', cwd: OTHER_REPO, project_dir: OTHER_REPO })
      ],
      [
        makeWorkspace({ path: MAIN, name: 'nexus' }),
        makeWorkspace({ path: OTHER_REPO, name: 'other' })
      ]
    )
    const calls = (): number => (currentClient().gitBranch as unknown as Mock).mock.calls.length
    const afterBoot = calls()
    expect(afterBoot, 'a boot roster is a session change and asks for identities').toBeGreaterThan(0)

    // A status stream is not a session change: nothing may be re-asked.
    deliverControl({ type: 'agent_status', session: 1, status: 'working' })
    deliverControl({ type: 'session_context', session: 1, context: null })
    await flush()
    expect(calls()).toBe(afterBoot)

    const NEW_DIR = '/repo/new'
    deliverControl({
      type: 'session_created',
      info: makeSession({ id: 3, title: 'new', cwd: NEW_DIR, project_dir: MAIN })
    })
    await flush()
    expect(gitBranchCalls()).toContain(NEW_DIR)

    reply(MAIN, 'feat/rebalancing', MAIN, COMMON)
    await flush()
    const beforeFocus = calls()
    focusPane(harness, 1)
    await flush()
    expect(calls()).toBeGreaterThan(beforeFocus)
  })
})
