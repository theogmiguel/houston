// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  type AppHarness,
  currentClient,
  deliverControl,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

// Each check proof runs as a single `-t` test in a fresh vitest process, which
// pays App's lazy import cost before the test body starts.
vi.setConfig({ testTimeout: 20000 })

const MAIN = '/repo/nexus'
const WORKTREE = '/repo/nexus-pdi-flags'
const COMMON = '/repo/nexus/.git'

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

function paneChip(harness: AppHarness, id: number): HTMLElement | null {
  return harness.container.querySelector<HTMLElement>(
    `section.pane[data-panekey="${id}"] [data-testid="branch-chip"]`
  )
}

function showTooltip(chip: HTMLElement): HTMLElement {
  act(() => {
    chip.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
  const tip = document.body.querySelector<HTMLElement>('[role="tooltip"]')
  if (!tip) throw new Error('the chip tooltip did not open on keyboard focus')
  return tip
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('checkout notes on the branch chip', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('one checkout keeps one branch across its directories', async () => {
    harness = await renderReadyApp({
      sessions: [
        makeSession({ id: 1, title: 'oak', cwd: MAIN, project_dir: MAIN }),
        makeSession({ id: 2, title: 'cedar', cwd: `${MAIN}/src`, project_dir: MAIN })
      ],
      workspaces: [makeWorkspace({ path: MAIN, name: 'nexus' })]
    })
    reply(MAIN, 'feat/first', MAIN, COMMON)
    reply(`${MAIN}/src`, 'feat/first', MAIN, COMMON)
    await flush()
    expect(paneChip(harness, 1)?.textContent).toContain('feat/first')
    expect(paneChip(harness, 2)?.textContent).toContain('feat/first')

    // A branch move seen through one directory of the checkout updates the
    // other known directory too: one checkout has one branch.
    reply(MAIN, 'feat/second', MAIN, COMMON)
    await flush()
    expect(paneChip(harness, 1)?.textContent).toContain('feat/second')
    expect(
      paneChip(harness, 2)?.textContent,
      'a pane in a subdirectory of the same checkout must not keep the old branch'
    ).toContain('feat/second')
  })

  it('the tooltip names the panes sharing the checkout', async () => {
    harness = await renderReadyApp({
      sessions: [
        makeSession({ id: 1, title: 'oak', cwd: MAIN, project_dir: MAIN }),
        makeSession({ id: 2, title: 'shell-1', cwd: MAIN, project_dir: MAIN })
      ],
      workspaces: [makeWorkspace({ path: MAIN, name: 'nexus' })]
    })
    reply(MAIN, 'feat/rebalancing', MAIN, COMMON)
    await flush()

    const tip = showTooltip(paneChip(harness, 1)!)
    expect(tip.textContent).toContain('feat/rebalancing')
    expect(tip.textContent).toContain('Also in this checkout')
    expect(tip.textContent).toContain('shell-1')

    // Consultation, not an alert: no top-bar warning chip exists.
    expect(harness.container.querySelector('[data-testid="shared-checkout-chip"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="same-repository-chip"]')).toBeNull()
  })

  it('the tooltip names the other checkout of the same repository', async () => {
    harness = await renderReadyApp({
      sessions: [
        makeSession({ id: 1, title: 'oak', cwd: MAIN, project_dir: MAIN }),
        makeSession({ id: 2, title: 'cedar', cwd: WORKTREE, project_dir: WORKTREE })
      ],
      workspaces: [
        makeWorkspace({ path: MAIN, name: 'nexus' }),
        makeWorkspace({ path: WORKTREE, name: 'nexus-pdi-flags' })
      ]
    })
    reply(MAIN, 'feat/rebalancing', MAIN, COMMON)
    reply(WORKTREE, 'feat/pdi', WORKTREE, COMMON)
    await flush()

    const tip = showTooltip(paneChip(harness, 1)!)
    expect(tip.textContent).toContain('Same repository')
    expect(tip.textContent).toContain('nexus-pdi-flags')
    expect(harness.container.querySelector('[data-testid="same-repository-chip"]')).toBeNull()
  })

  it('no request is armed on a timer', async () => {
    // The fake clock is installed before the first mount, so anything the app
    // arms on mount is captured; two minutes of it would fire a polling loop.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      harness = await renderReadyApp({
        sessions: [makeSession({ id: 1, title: 'oak', cwd: MAIN, project_dir: MAIN })],
        workspaces: [makeWorkspace({ path: MAIN, name: 'nexus' })]
      })
      const calls = (): number => (currentClient().gitBranch as unknown as Mock).mock.calls.length
      const afterBoot = calls()
      expect(afterBoot).toBeGreaterThan(0)

      act(() => {
        vi.advanceTimersByTime(120_000)
      })
      await flush()
      expect(calls()).toBe(afterBoot)
    } finally {
      vi.useRealTimers()
    }
  })
})
