// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GRID_ID, gridStorageKey, preorderSessions } from './layout/tree'
import {
  type AppHarness,
  currentClient,
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

  it('keeps the saved All layout until hello and restores its session origins when opened', async () => {
    const tree = {
      kind: 'split',
      dir: 'row',
      weights: [70, 30],
      children: [
        { kind: 'leaf', session: 2, id: 'pane-two' },
        { kind: 'leaf', session: 1, id: 'pane-one' }
      ]
    }
    localStorage.setItem('tr-layout:all', JSON.stringify({ tree, cols: 2 }))
    harness = await renderReadyApp({
      sessions: [
        { ...makeSession({ id: 11 }), session_origin: 1 },
        { ...makeSession({ id: 12 }), session_origin: 2 }
      ],
      workspaces: [makeWorkspace()]
    })
    expect(JSON.parse(localStorage.getItem('tr-layout:all') ?? 'null').tree).toEqual(tree)

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })
      )
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(harness!.container.querySelector('[data-testid="command-palette"]')).not.toBeNull())
    const search = harness!.container.querySelector<HTMLInputElement>('[data-testid="command-palette-search"]')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(search, 'All workspaces')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const all = [...harness.container.querySelectorAll('[data-testid="command-palette-row"]')]
      .find((row) => row.textContent?.includes('All workspaces'))
    expect(all).toBeDefined()
    await act(async () => {
      all!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      all!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(JSON.parse(localStorage.getItem('tr-layout:all') ?? 'null').tree).toEqual({
      ...tree,
      children: [
        { kind: 'leaf', session: 12, id: 'pane-two', session_origin: 2 },
        { kind: 'leaf', session: 11, id: 'pane-one', session_origin: 1 }
      ]
    })
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

  it('closing the only grid asks first, then ends its panes and leaves the workspace empty', async () => {
    await boot([1, 2])
    const close = vi.fn()
    currentClient().closeSession = close
    await rightClick(gridRows()[0])
    const remove = menuItems().find((b) => b.textContent?.includes('Close grid'))
    expect(remove).toBeDefined()
    expect(remove!.hasAttribute('disabled')).toBe(false)
    await act(async () => {
      remove!.click()
      await Promise.resolve()
    })
    expect(close).not.toHaveBeenCalled()

    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Close grid')
    expect(confirm).toBeDefined()
    await act(async () => {
      confirm!.click()
      await Promise.resolve()
    })
    expect(close.mock.calls.map(([id]) => id).sort()).toEqual([1, 2])
    const grids = JSON.parse(localStorage.getItem(`tr-grids:${WS}`) ?? '[]') as { id: string }[]
    expect(grids).toHaveLength(1)
    expect(grids[0].id).not.toBe(DEFAULT_GRID_ID)
  })

  it('a second tab unlocks Close grid, and closing it drops back to one row', async () => {
    await boot([1])
    await openWorkspaceMenu()
    await act(async () => {
      addBtn()!.click()
      await Promise.resolve()
    })
    expect(gridRows()).toHaveLength(2)

    await rightClick(gridRows()[1])
    const remove = menuItems().find((b) => b.textContent?.includes('Close grid'))
    expect(remove).toBeDefined()
    expect(remove!.hasAttribute('disabled')).toBe(false)
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
