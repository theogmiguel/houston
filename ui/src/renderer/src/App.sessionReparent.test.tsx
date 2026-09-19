// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  deliverControl,
  deliverHelloOk,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

const PROJECT = '/tmp/project'
const OTHER = '/tmp/other'

function paneKeys(harness: AppHarness): string[] {
  return Array.from(harness.container.querySelectorAll('[data-panekey]'))
    .filter((el) => !el.closest('[data-testid="warm-workspace-grid"]'))
    .map((el) => (el as HTMLElement).dataset.panekey ?? '')
    .sort()
}

function warmPaneKeys(harness: AppHarness): string[] {
  return Array.from(
    harness.container.querySelectorAll('[data-testid="warm-workspace-grid"] [data-panekey]')
  )
    .map((el) => (el as HTMLElement).dataset.panekey ?? '')
    .sort()
}

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
  resetHarness()
  localStorage.clear()
})

describe('item 21: a reparent moves the pane between workspaces live', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  async function twoWorkspaces(): Promise<AppHarness> {
    const h = await renderReadyApp()
    deliverHelloOk({
      sessions: [makeSession({ id: 1, project_dir: PROJECT })],
      workspaces: [makeWorkspace({ path: PROJECT, name: 'project' }), makeWorkspace({ path: OTHER, name: 'other' })]
    })
    return h
  }

  it('the pane leaves the old workspace and appears in the new one, with no reload', async () => {
    harness = await twoWorkspaces()

    select(harness, 'project')
    expect(paneKeys(harness)).toEqual(['1'])
    select(harness, 'other')
    expect(paneKeys(harness)).toEqual([])
    expect(warmPaneKeys(harness)).toEqual(['1'])

    deliverControl({ type: 'session_reparented', session: 1, project_dir: OTHER })

    expect(paneKeys(harness)).toEqual(['1'])
    select(harness, 'project')
    expect(paneKeys(harness)).toEqual([])
  })

  it('a reparent to an unregistered directory leaves the pane in no workspace at all', async () => {
    harness = await twoWorkspaces()
    select(harness, 'project')
    expect(paneKeys(harness)).toEqual(['1'])

    deliverControl({ type: 'session_reparented', session: 1, project_dir: '/tmp/nowhere' })

    expect(paneKeys(harness)).toEqual([])
    select(harness, 'other')
    expect(paneKeys(harness)).toEqual([])
  })
})
