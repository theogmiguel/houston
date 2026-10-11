// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from './houston/client'
import {
  type AppHarness,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  deliverControl,
  resetHarness
} from './test/appTestHarness'

const ROOT = '/repo/nexus'

function withCheckout(id: number, cwd: string): SessionInfo {
  return {
    ...makeSession({ id, title: `pane-${id}`, cwd, project_dir: ROOT }),
    checkout: { root: ROOT, kind: 'primary', branch: 'feat/rebalancing', head: 'abcdef0' }
  } as SessionInfo
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

describe('checkout header identity', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('shows the same checkout identity across pane directories without tooltip notes', async () => {
    const appHarness = await renderReadyApp({
      sessions: [withCheckout(1, ROOT), withCheckout(2, `${ROOT}/src`)],
      workspaces: [makeWorkspace({ path: ROOT, name: 'nexus' })]
    })
    if (!appHarness) throw new Error('renderReadyApp did not return an app harness')
    harness = appHarness

    expect(paneChip(appHarness, 1)?.textContent).toContain('primary · feat/rebalancing')
    expect(paneChip(appHarness, 2)?.textContent).toContain('primary · feat/rebalancing')
    act(() => paneChip(appHarness, 1)?.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    const tooltip = document.body.querySelector('[role="tooltip"]')
    expect(tooltip?.textContent).toContain('primary · feat/rebalancing')
    expect(tooltip?.textContent).not.toContain('Also in this checkout')
  })

  it('updates a pane header when the daemon reports a branch switch', async () => {
    const appHarness = await renderReadyApp({
      sessions: [withCheckout(1, ROOT)],
      workspaces: [makeWorkspace({ path: ROOT, name: 'nexus' })]
    })
    if (!appHarness) throw new Error('renderReadyApp did not return an app harness')
    harness = appHarness
    deliverControl({ type: 'session_checkout', id: 1, checkout: { root: ROOT, kind: 'primary', branch: 'feat/new-branch', head: null } })
    expect(paneChip(appHarness, 1)?.textContent).toContain('primary · feat/new-branch')
    expect(paneChip(appHarness, 1)?.textContent).not.toContain('feat/rebalancing')
  })
})
