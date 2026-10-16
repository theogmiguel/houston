// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rememberRailPr } from './components/git/railPrCache'
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

  async function renameFirstGrid(name: string): Promise<void> {
    await act(async () => { gridRows()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 })); await Promise.resolve() })
    const rename = [...document.querySelectorAll<HTMLElement>('.ctxmenu .ctx-item')].find((item) => item.textContent?.includes('Rename'))!
    await act(async () => { rename.click(); await Promise.resolve() })
    const input = q<HTMLInputElement>('[data-testid="grid-row-renaming"] input')!
    await act(async () => { input.value = name; input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); await Promise.resolve() })
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

  it('"Reset to automatic name" hands a user-named grid back to its session\'s name', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [makeSession({ id: 1, project_dir: WS, cwd: WS, agent: 'shell' })],
      workspaces: [makeWorkspace({ path: WS })]
    })
    await act(async () => { await Promise.resolve() })
    await renameFirstGrid('my review')
    expect(gridRows()[0].textContent).toContain('my review')

    await act(async () => { gridRows()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 })); await Promise.resolve() })
    const reset = [...document.querySelectorAll<HTMLElement>('.ctxmenu .ctx-item')].find((item) => item.textContent === 'Reset to automatic name')!
    await act(async () => { reset.click(); await Promise.resolve() })
    expect(gridRows()[0].textContent).toContain('Terminal')
    expect(gridRows()[0].textContent).not.toContain('my review')

    await act(async () => { gridRows()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 })); await Promise.resolve() })
    expect([...document.querySelectorAll('.ctxmenu .ctx-item')].some((item) => item.textContent === 'Reset to automatic name')).toBe(false)
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

  it('follows pane title changes, preserves a user grid name, including through a blank rename', async () => {
    harness = await renderReadyApp({ sessions: [makeSession({ id: 1, title: 'Initial task', title_source: 'prompt' })] })
    await act(async () => { await Promise.resolve() })
    expect(gridRows()[0].textContent).toContain('Initial task')
    deliverControl({ type: 'session_renamed', session: 1, title: 'Native task', title_source: 'cli' })
    await act(async () => { await Promise.resolve() })
    expect(gridRows()[0].textContent).toContain('Native task')
    await renameFirstGrid('My grid')
    deliverControl({ type: 'session_renamed', session: 1, title: 'Updated task', title_source: 'cli' })
    await act(async () => { await Promise.resolve() })
    expect(gridRows()[0].textContent).toContain('My grid')
    await renameFirstGrid('')
    deliverControl({ type: 'session_renamed', session: 1, title: 'Later task', title_source: 'cli' })
    await act(async () => { await Promise.resolve() })
    expect(gridRows()[0].textContent).toContain('My grid')
    expect(JSON.parse(localStorage.getItem(`tr-grids:${WS}`)!)[0].nameSource).toBe('user')
  })

  it('claims an unchanged automatic grid name and keeps it through later pane title changes', async () => {
    harness = await renderReadyApp({ sessions: [makeSession({ id: 1, title: 'Initial task', title_source: 'prompt' })] })
    await act(async () => { await Promise.resolve() })
    expect(gridRows()[0].textContent).toContain('Initial task')
    await renameFirstGrid('Initial task')
    expect(JSON.parse(localStorage.getItem(`tr-grids:${WS}`)!)[0].nameSource).toBe('user')
    deliverControl({ type: 'session_renamed', session: 1, title: 'Native task', title_source: 'cli' })
    await act(async () => { await Promise.resolve() })
    expect(gridRows()[0].querySelector('[data-testid="grid-name"]')?.textContent).toBe('Initial task')
  })

  it('uses task and worktree identity before a placeholder engine name', async () => {
    harness = await renderReadyApp({ sessions: [makeSession({ id: 1, title_source: 'codename', title: 'Max', worktree: { path: '/work/tree', branch: 'fix/parser', repo_common_dir: '/work/.git' } })] })
    await act(async () => { await Promise.resolve() })
    expect(gridRows()[0].textContent).toContain('fix/parser')
  })


  it('uses an already loaded PR title for an unnamed pane and follows cache changes', async () => {
    const dir = '/tmp/grid-title-pr-fixture'
    const pr = { number: 33, url: 'https://example.test/pr/33', state: 'open', title: 'Fix authentication', head_ref: 'fix/auth', additions: 1, deletions: 0, is_draft: false, review_decision: null, checks: 'passing' as const }
    rememberRailPr(dir, { gh: 'ready', pr })
    harness = await renderReadyApp({ sessions: [makeSession({ id: 1, cwd: dir, title_source: 'codename', title: 'Max' })] })
    await act(async () => { await Promise.resolve() })
    expect(gridRows()[0].textContent).toContain('Fix authentication')
    await act(async () => { rememberRailPr(dir, { gh: 'ready', pr: { ...pr, title: 'Fix authentication and restore' } }); await Promise.resolve() })
    expect(gridRows()[0].textContent).toContain('Fix authentication and restore')
  })

})
