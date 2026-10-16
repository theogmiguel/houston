// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GRID_ID, gridStorageKey, preorderSessions } from './layout/tree'
import { gridRecency, gridRecencyKey, touchGrid } from './gridRecency'
import type { SessionInfo } from './houston/client'
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

  async function boot(sessions: number[], extra: SessionInfo[] = []): Promise<void> {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [...sessions.map((id) => makeSession({ id, project_dir: WS, cwd: WS })), ...extra],
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
    currentClient().confirmCloseSession = close
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

  it('closing a populated non-last grid ends its agents after confirmation', async () => {
    await boot([1, 2])
    const close = vi.fn()
    currentClient().confirmCloseSession = close
    await openWorkspaceMenu()
    await act(async () => { addBtn()!.click(); await Promise.resolve() })
    await rightClick(gridRows()[0])
    const remove = menuItems().find((item) => item.textContent?.includes('Close grid'))!
    await act(async () => { remove.click(); await Promise.resolve() })
    const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Close grid')
    expect(close).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('ends its 2 agents')
    expect(document.body.textContent).toContain('Close Terminal?')
    expect(confirm).toBeDefined()
    await act(async () => { confirm!.click(); await Promise.resolve() })
    expect(close.mock.calls.map(([id]) => id).sort()).toEqual([1, 2])
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

  async function addGridViaMenu(): Promise<void> {
    await openWorkspaceMenu()
    await act(async () => { addBtn()!.click(); await Promise.resolve() })
  }
  async function closeGridRow(index: number): Promise<void> {
    await rightClick(gridRows()[index])
    const remove = menuItems().find((b) => b.textContent?.includes('Close grid'))!
    await act(async () => { remove.click(); await Promise.resolve() })
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Close grid')
    if (confirm) await act(async () => { confirm.click(); await Promise.resolve() })
  }
  const selectedIndex = (): number => gridRows().findIndex((r) => r.getAttribute('data-selected') === 'true')
  const pushedNotices = (): string => harness!.container.querySelector('[data-notice]')?.textContent ?? ''

  it('closing a grid confirms the close for each pane and marks spawned children closing', async () => {
    await boot([1, 2], [makeSession({ id: 3, project_dir: WS, cwd: WS, spawned_by: 1 }), makeSession({ id: 4, project_dir: WS, cwd: WS, spawned_by: 3 })])
    const client = currentClient()
    await addGridViaMenu()
    await closeGridRow(0)
    expect(vi.mocked(client.confirmCloseSession).mock.calls.map(([id]) => id).sort()).toEqual([1, 2])
    expect(client.closeSession).not.toHaveBeenCalled()
    expect(client.paneOps.closingIds()).toEqual(new Set([1, 2, 3, 4]))
  })

  it('refuses to close a grid while the daemon connection is not ready, and says why', async () => {
    await boot([1])
    const client = currentClient()
    await addGridViaMenu()
    await act(async () => { (client as unknown as { onClose: () => void }).onClose(); await Promise.resolve() })
    await closeGridRow(0)
    expect(JSON.parse(localStorage.getItem(`tr-grids:${WS}`) ?? '[]')).toHaveLength(2)
    expect(client.confirmCloseSession).not.toHaveBeenCalled()
    expect(pushedNotices()).toContain('reconnecting')
  })

  it('removing the selected middle grid selects the grid after it', async () => {
    await boot([1])
    await addGridViaMenu()
    await addGridViaMenu()
    await act(async () => { gridRows()[1].click(); await Promise.resolve() })
    const ids = JSON.parse(localStorage.getItem(`tr-grids:${WS}`) ?? '[]').map((g: { id: string }) => g.id) as string[]
    await closeGridRow(1)
    expect(gridRows()).toHaveLength(2)
    expect(selectedIndex()).toBe(1)
    expect(JSON.parse(localStorage.getItem(`tr-grids:${WS}`) ?? '[]').map((g: { id: string }) => g.id)).toEqual([ids[0], ids[2]])
  })

  it('removing the selected last grid selects the one before it and records the visit', async () => {
    await boot([1])
    await addGridViaMenu()
    await addGridViaMenu()
    const ids = JSON.parse(localStorage.getItem(`tr-grids:${WS}`) ?? '[]').map((g: { id: string }) => g.id) as string[]
    await closeGridRow(2)
    expect(selectedIndex()).toBe(1)
    expect(gridRecency().has(gridRecencyKey(WS, ids[1]))).toBe(true)
  })

  it('removing a grid drops its recency entry', async () => {
    const first = { id: DEFAULT_GRID_ID, name: 'Terminal', nameSource: 'auto', tags: [] }
    const second = { id: 'g-second', name: 'Web', nameSource: 'user', tags: [] }
    localStorage.setItem(`tr-grids:${WS}`, JSON.stringify([first, second]))
    touchGrid(WS, second.id)
    await boot([1])
    await closeGridRow(1)
    expect(gridRecency().has(gridRecencyKey(WS, second.id))).toBe(false)
  })

  it('a workspace context-menu New grid on another workspace switches to the new grid', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [makeSession({ id: 1, project_dir: '/a', cwd: '/a' }), makeSession({ id: 2, project_dir: '/b', cwd: '/b' })],
      workspaces: [makeWorkspace({ path: '/a' }), makeWorkspace({ path: '/b', name: 'bee' })]
    })
    await act(async () => { await Promise.resolve() })
    const rows = [...harness.container.querySelectorAll('[data-testid="ws-disclosure"]')] as HTMLElement[]
    const other = rows[1]
    await rightClick(other)
    await act(async () => { document.querySelector<HTMLElement>('[data-testid="ws-new-grid"]')!.click(); await Promise.resolve() })
    expect(localStorage.getItem('tr-selected-workspace')).toBe('/b')
    expect(JSON.parse(localStorage.getItem('tr-grids:/b') ?? '[]')).toHaveLength(2)
  })

  it('removing a workspace prunes its pin, order and collapsed entries', async () => {
    localStorage.setItem('tr-ws-pinned', JSON.stringify([WS, '/other']))
    localStorage.setItem('tr-ws-order', JSON.stringify([WS, '/other']))
    localStorage.setItem('tr-ws-collapsed', JSON.stringify([WS, '/other']))
    await boot([1, 2])
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', ctrlKey: true, shiftKey: true, bubbles: true }))
      await Promise.resolve()
    })
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Close workspace')!
    await act(async () => { confirm.click(); await Promise.resolve() })
    for (const key of ['tr-ws-pinned', 'tr-ws-order', 'tr-ws-collapsed']) {
      expect(JSON.parse(localStorage.getItem(key) ?? '[]'), key).toEqual(['/other'])
    }
  })
})
