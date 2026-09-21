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

const WS = '/tmp/project'
const REPO = '/tmp/repo'
const OTHER = '/tmp/other'
const NON_REPO = '/tmp/plain'
const DETACHED = '/tmp/detached'
const SSH = '/tmp/remote'

function gitBranchCalls(): string[] {
  return (currentClient().gitBranch as unknown as Mock).mock.calls.map((c) => c[0] as string)
}

function callsFor(dir: string): number {
  return gitBranchCalls().filter((d) => d === dir).length
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function focusPane(harness: AppHarness, id: number): void {
  const pane = harness.container.querySelector(`section.pane[data-panekey="${id}"]`)
  if (!pane) throw new Error(`pane ${id} was not rendered, so this file would test nothing`)
  act(() => {
    pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
  })
}

function paneChip(harness: AppHarness, id: number): HTMLElement | null {
  return harness.container.querySelector<HTMLElement>(
    `section.pane[data-panekey="${id}"] [data-testid="branch-chip"]`
  )
}

function reply(
  dir: string,
  branch: string | null,
  toplevel: string | null,
  commonDir: string | null
): void {
  deliverControl({ type: 'git_branch', dir, branch, toplevel, common_dir: commonDir })
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('branch chip in the focused pane', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('shows the branch and hides it when git has no answer', async () => {
    harness = await renderReadyApp({
      sessions: [
        makeSession({ id: 1, cwd: REPO, project_dir: WS }),
        makeSession({ id: 2, cwd: NON_REPO, project_dir: WS }),
        makeSession({ id: 3, cwd: DETACHED, project_dir: WS })
      ],
      workspaces: [makeWorkspace({ path: WS })]
    })

    focusPane(harness, 1)
    reply(REPO, 'feat/repo', REPO, `${REPO}/.git`)
    await flush()
    expect(paneChip(harness, 1)?.textContent).toContain('feat/repo')

    focusPane(harness, 2)
    reply(NON_REPO, null, null, null)
    await flush()
    expect(paneChip(harness, 2)).toBeNull()

    focusPane(harness, 3)
    reply(DETACHED, null, DETACHED, `${DETACHED}/.git`)
    await flush()
    expect(paneChip(harness, 3)).toBeNull()
    // The first boot in a file pays the lazy-surface import cost; under a
    // parallel suite that can outlast vitest's default 5s.
  }, 20000)

  it('an SSH pane sends no branch request', async () => {
    harness = await renderReadyApp({
      sessions: [
        makeSession({ id: 1, agent: 'ssh', ssh_host: 'box', cwd: SSH, project_dir: SSH })
      ],
      workspaces: [makeWorkspace({ path: SSH })]
    })

    focusPane(harness, 1)
    await flush()

    expect(gitBranchCalls()).not.toContain(SSH)
    expect(paneChip(harness, 1)).toBeNull()
  })

  it('no chip while the request is unanswered', async () => {
    harness = await renderReadyApp({
      sessions: [
        makeSession({ id: 1, cwd: REPO, project_dir: WS }),
        makeSession({ id: 2, cwd: OTHER, project_dir: WS })
      ],
      workspaces: [makeWorkspace({ path: WS })]
    })

    focusPane(harness, 1)
    await flush()
    expect(callsFor(REPO)).toBeGreaterThan(0)

    // Another pane's answer must never stand in for this pane's.
    reply(OTHER, 'feat/other', OTHER, `${OTHER}/.git`)
    await flush()
    expect(paneChip(harness, 1)).toBeNull()

    reply(REPO, 'feat/repo', REPO, `${REPO}/.git`)
    await flush()
    expect(paneChip(harness, 1)?.textContent).toContain('feat/repo')
  })

  it('one request per cwd while in flight', async () => {
    harness = await renderReadyApp({
      sessions: [
        makeSession({ id: 1, cwd: REPO, project_dir: WS }),
        makeSession({ id: 2, cwd: REPO, project_dir: WS })
      ],
      workspaces: [makeWorkspace({ path: WS })]
    })

    focusPane(harness, 1)
    await flush()
    expect(callsFor(REPO)).toBe(1)

    focusPane(harness, 2)
    await flush()
    expect(callsFor(REPO)).toBe(1)

    reply(REPO, 'feat/repo', REPO, `${REPO}/.git`)
    await flush()

    // The ask was answered, so a later focus asks again rather than reusing a
    // stale answer.
    focusPane(harness, 1)
    await flush()
    expect(callsFor(REPO)).toBe(2)
  })

  it('refocus reads the branch again', async () => {
    harness = await renderReadyApp({
      sessions: [
        makeSession({ id: 1, cwd: REPO, project_dir: WS }),
        makeSession({ id: 2, cwd: OTHER, project_dir: WS })
      ],
      workspaces: [makeWorkspace({ path: WS })]
    })

    focusPane(harness, 1)
    reply(REPO, 'feat/first', REPO, `${REPO}/.git`)
    await flush()
    expect(paneChip(harness, 1)?.textContent).toContain('feat/first')

    focusPane(harness, 2)
    reply(OTHER, 'feat/other', OTHER, `${OTHER}/.git`)
    await flush()

    focusPane(harness, 1)
    await flush()
    expect(paneChip(harness, 1)).toBeNull()

    reply(REPO, 'feat/second', REPO, `${REPO}/.git`)
    await flush()
    expect(paneChip(harness, 1)?.textContent).toContain('feat/second')
  })

  it('narrow pane hides the chip', async () => {
    harness = await renderReadyApp({
      sessions: [makeSession({ id: 1, cwd: REPO, project_dir: WS })],
      workspaces: [makeWorkspace({ path: WS })]
    })

    focusPane(harness, 1)
    reply(REPO, 'feat/repo', REPO, `${REPO}/.git`)
    await flush()

    const chip = paneChip(harness, 1)
    expect(chip).not.toBeNull()
    expect(chip!.className).toContain('[@container_(max-width:400px)]:hidden')
  })
})
