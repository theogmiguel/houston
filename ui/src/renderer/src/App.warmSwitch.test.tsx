// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  deliverHelloOk,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness,
  engineCounts
} from './test/appTestHarness'

const A = '/tmp/ws-a'
const B = '/tmp/ws-b'

function workspaceRow(harness: AppHarness, label: string): HTMLButtonElement {
  const row = Array.from(harness.container.querySelectorAll('.witem[role="button"]')).find((b) =>
    (b.textContent ?? '').includes(label)
  ) as HTMLButtonElement | undefined
  if (!row) throw new Error(`workspace row "${label}" not found`)
  return row
}

function select(harness: AppHarness, label: string): void {
  act(() => {
    workspaceRow(harness, label).click()
  })
}

beforeEach(() => {
  localStorage.clear()
  resetHarness()
})

describe('row 17: workspace switching is a props flip, not a teardown', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  async function twoWorkspaces(): Promise<AppHarness> {
    const h = await renderReadyApp()
    deliverHelloOk({
      sessions: [
        makeSession({ id: 1, project_dir: A, title: 'a-1' }),
        makeSession({ id: 2, project_dir: B, title: 'b-2' })
      ],
      workspaces: [makeWorkspace({ path: A, name: 'ws-a' }), makeWorkspace({ path: B, name: 'ws-b' })]
    })
    return h
  }

  it('switching back and forth disposes no xterm and constructs no new one', async () => {
    harness = await twoWorkspaces()
    select(harness, 'ws-a')
    const before = engineCounts()
    expect(before.constructed).toBeGreaterThan(0)

    select(harness, 'ws-b')
    select(harness, 'ws-a')
    select(harness, 'ws-b')

    const after = engineCounts()
    expect(after.disposed).toBe(before.disposed)
    expect(after.constructed).toBe(before.constructed)
  })

  it('the non-selected grid is display:none — it cannot paint or be hit', async () => {
    harness = await twoWorkspaces()
    select(harness, 'ws-a')

    const warm = harness.container.querySelector<HTMLElement>(
      '[data-testid="warm-workspace-grid"]'
    )
    if (!warm) throw new Error('no warm grid mounted for the background workspace')
    expect(warm.className).toContain('hidden')
    expect(warm.className).not.toContain('invisible')
  })

  it('the selected grid never carries the warm testid', async () => {
    harness = await twoWorkspaces()
    select(harness, 'ws-a')
    const warmGrids = harness.container.querySelectorAll('[data-testid="warm-workspace-grid"]')
    expect(warmGrids.length).toBe(1)
    expect((warmGrids[0] as HTMLElement).dataset.workspace).toBe(B)
  })
})
