// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_GRID_ID, gridStorageKey, preorderSessions } from './layout/tree'
import {
  type AppHarness,
  deliverHelloOk,
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

describe('grids (step 05, driven from the rail)', () => {
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
  const menuItems = (): HTMLElement[] =>
    [...document.querySelectorAll('.ctxmenu .ctx-item')] as HTMLElement[]

  async function boot(sessions: number[]): Promise<void> {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: sessions.map((id) => makeSession({ id, project_dir: WS, cwd: WS })),
      workspaces: [makeWorkspace({ path: WS })]
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  async function rightClick(el: HTMLElement): Promise<void> {
    await act(async () => {
      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 })
      )
      await Promise.resolve()
    })
  }

  it('a single-grid workspace shows one rail row, and no tab strip anywhere', async () => {
    await boot([1])
    expect(q('[data-testid="grid-rail"]')).toBeNull()
    const rows = gridRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Terminal')
    expect(rows[0].getAttribute('data-selected')).toBe('true')
  })

  it('adding a grid, then switching, never duplicates a session across grids', async () => {
    await boot([1, 2])

    const before = JSON.parse(
      localStorage.getItem(`tr-layout:${gridStorageKey(WS, DEFAULT_GRID_ID)}`) ?? 'null'
    )
    expect(preorderSessions(before.tree).sort()).toEqual([1, 2])

    await openWorkspaceMenu()
    const add = addBtn()
    expect(add).not.toBeNull()
    await act(async () => {
      add!.click()
      await Promise.resolve()
    })
    let rows = gridRows()
    expect(rows).toHaveLength(2)
    expect(rows[1].getAttribute('data-selected')).toBe('true')

    await act(async () => {
      rows[0].click()
      await Promise.resolve()
    })
    rows = gridRows()
    expect(rows[0].getAttribute('data-selected')).toBe('true')

    const grids = JSON.parse(localStorage.getItem(`tr-grids:${WS}`) ?? '[]') as {
      id: string
      name: string
    }[]
    expect(grids).toHaveLength(2)
    const allSessions: number[] = []
    for (const g of grids) {
      const raw = localStorage.getItem(`tr-layout:${gridStorageKey(WS, g.id)}`)
      const st = raw ? JSON.parse(raw) : { tree: null }
      allSessions.push(...preorderSessions(st.tree))
    }
    expect(allSessions.sort()).toEqual([1, 2])
  })

  it('a single-grid workspace is offered NO way to remove its only grid', async () => {
    await boot([1])
    await rightClick(gridRows()[0])
    const labels = menuItems().map((b) => b.textContent)
    expect(labels.some((l) => l?.includes('Rename'))).toBe(true)
    expect(labels.some((l) => l?.includes('Close Tab'))).toBe(false)
  })

  it('a second tab unlocks Close Tab, and closing it drops back to one row', async () => {
    await boot([1])
    await openWorkspaceMenu()
    await act(async () => {
      addBtn()!.click()
      await Promise.resolve()
    })
    expect(gridRows()).toHaveLength(2)

    await rightClick(gridRows()[1])
    const remove = menuItems().find((b) => b.textContent?.includes('Close Tab'))
    expect(remove).toBeDefined()
    await act(async () => {
      remove!.click()
      await Promise.resolve()
    })

    const rows = gridRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].getAttribute('data-selected')).toBe('true')
    expect(JSON.parse(localStorage.getItem(`tr-grids:${WS}`) ?? '[]')).toHaveLength(1)
  })

  it('Rename edits the row inline and persists the new name', async () => {
    await boot([1])
    await rightClick(gridRows()[0])
    const rename = menuItems().find((b) => b.textContent?.includes('Rename'))
    expect(rename).toBeDefined()
    await act(async () => {
      rename!.click()
      await Promise.resolve()
    })

    const input = q<HTMLInputElement>('[data-testid="grid-row-renaming"] input')
    expect(input).not.toBeNull()
    await act(async () => {
      input!.value = 'review'
      input!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await Promise.resolve()
    })

    expect(gridRows()[0].textContent).toContain('review')
    const grids = JSON.parse(localStorage.getItem(`tr-grids:${WS}`) ?? '[]') as { name: string }[]
    expect(grids[0].name).toBe('review')
  })

  it('an emptied name is refused rather than committed — a grid cannot lose its label', async () => {
    await boot([1])
    await rightClick(gridRows()[0])
    await act(async () => {
      menuItems()
        .find((b) => b.textContent?.includes('Rename'))!
        .click()
      await Promise.resolve()
    })
    const input = q<HTMLInputElement>('[data-testid="grid-row-renaming"] input')!
    await act(async () => {
      input.value = '   '
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await Promise.resolve()
    })
    expect(gridRows()[0].textContent).toContain('Terminal')
  })
})
