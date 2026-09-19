// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_GRID_ID } from './layout/tree'
import {
  type AppHarness,
  deliverHelloOk,
  deliverControl,
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

describe('grid auto-naming (tab-naming rule)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  const q = <T extends Element>(sel: string): T | null =>
    harness!.container.querySelector<T>(sel)
  const gridRows = (): HTMLElement[] =>
    [...harness!.container.querySelectorAll('[data-testid="grid-row"]')] as HTMLElement[]
  const addBtn = (): HTMLButtonElement | null => q<HTMLButtonElement>('[data-testid="add-pane-new-tab"]')
  async function openWorkspaceMenu(): Promise<void> {
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true, bubbles: true })
      )
      await Promise.resolve()
    })
  }

  it('a fresh workspace\'s default grid picks up its first session\'s name, not "Grid 1"', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [makeSession({ id: 1, project_dir: WS, cwd: WS, agent: 'shell' })],
      workspaces: [makeWorkspace({ path: WS })]
    })
    await act(async () => {
      await Promise.resolve()
    })
    const rows = gridRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Terminal')
    expect(rows[0].textContent).not.toContain('Grid 1')
  })

  it('a grid created empty stays "Untitled" until its first session lands', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({ sessions: [], workspaces: [makeWorkspace({ path: WS })] })
    await act(async () => {
      await Promise.resolve()
    })
    await openWorkspaceMenu()
    await act(async () => {
      addBtn()!.click()
      await Promise.resolve()
    })
    let rows = gridRows()
    expect(rows).toHaveLength(2)
    expect(rows[1].textContent).toContain('Untitled')

    deliverControl({
      type: 'session_created',
      info: makeSession({ id: 2, project_dir: WS, cwd: WS, agent: 'claude' })
    })
    await act(async () => {
      await Promise.resolve()
    })
    rows = gridRows()
    expect(rows[1].textContent).toContain('Claude Code')
    expect(rows[1].textContent).not.toContain('Untitled')
  })

  it('a user rename sticks even after a session later lands in that grid', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({ sessions: [], workspaces: [makeWorkspace({ path: WS })] })
    await act(async () => {
      await Promise.resolve()
    })
    await openWorkspaceMenu()
    await act(async () => {
      addBtn()!.click()
      await Promise.resolve()
    })
    const rows = gridRows()
    await act(async () => {
      rows[1].dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 })
      )
      await Promise.resolve()
    })
    const rename = [
      ...document.querySelectorAll('.ctxmenu .ctx-item')
    ].find((b) => b.textContent?.includes('Rename')) as HTMLElement
    await act(async () => {
      rename.click()
      await Promise.resolve()
    })
    const input = q<HTMLInputElement>('[data-testid="grid-row-renaming"] input')!
    await act(async () => {
      input.value = 'my review'
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await Promise.resolve()
    })

    deliverControl({
      type: 'session_created',
      info: makeSession({ id: 5, project_dir: WS, cwd: WS, agent: 'codex' })
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(gridRows()[1].textContent).toContain('my review')
  })

  it('persisted "Grid N" names still count as auto-generated (rule 4)', async () => {
    const legacyWs = '/tmp/legacy-project'
    localStorage.setItem(
      `tr-grids:${legacyWs}`,
      JSON.stringify([{ id: DEFAULT_GRID_ID, name: 'Grid 1' }])
    )
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [makeSession({ id: 9, project_dir: legacyWs, cwd: legacyWs, agent: 'antigravity' })],
      workspaces: [makeWorkspace({ path: legacyWs, name: 'legacy' })]
    })
    await act(async () => {
      await Promise.resolve()
    })
    const legacyRow = gridRows().find((r) => r.textContent?.includes('Antigravity') || r.textContent?.includes('Grid 1'))
    expect(legacyRow?.textContent).toContain('Antigravity')
  })
})
