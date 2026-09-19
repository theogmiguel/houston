// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  currentClient,
  deliverHelloOk,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
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

function slots(harness: AppHarness, ws: string): HTMLElement[] {
  return Array.from(
    harness.container.querySelectorAll<HTMLElement>(`div[data-workspace="${ws}"] .pane-slot`)
  )
}

function hiddenCount(harness: AppHarness, ws: string): number {
  return slots(harness, ws).filter((el) => el.style.visibility === 'hidden').length
}

function pressKey(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  localStorage.clear()
  resetHarness()
})

describe('expand is scoped to the workspace that owns the pane', () => {
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
        makeSession({ id: 2, project_dir: A, title: 'a-2' }),
        makeSession({ id: 3, project_dir: B, title: 'b-3' })
      ],
      workspaces: [
        makeWorkspace({ path: A, name: 'ws-a' }),
        makeWorkspace({ path: B, name: 'ws-b' })
      ]
    })
    return h
  }

  it('switching workspaces while a pane is expanded does not blank the other grid', async () => {
    harness = await twoWorkspaces()
    select(harness, 'ws-a')
    pressKey('z')
    expect(hiddenCount(harness, A)).toBe(1)

    select(harness, 'ws-b')
    expect(slots(harness, B).length).toBe(1)
    expect(hiddenCount(harness, B)).toBe(0)

    select(harness, 'ws-a')
    expect(hiddenCount(harness, A)).toBe(1)
  })

  it('creating a terminal from the chrome leaves the expanded view', async () => {
    harness = await twoWorkspaces()
    select(harness, 'ws-a')
    pressKey('z')
    expect(hiddenCount(harness, A)).toBe(1)

    pressKey('t')
    expect(currentClient().createSession).toHaveBeenCalled()
    expect(hiddenCount(harness, A)).toBe(0)
  })
})
