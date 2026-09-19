// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_GRID_ID, gridStorageKey, loadLayout, type LayoutNode } from './layout/tree'
import { setScmWidth } from './scmPanel'
import {
  type AppHarness,
  deliverClientMsg,
  deliverHelloOk,
  engineCounts,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

const WS = '/tmp/project'
const WS_B = '/tmp/other'
const GRID_KEY = gridStorageKey(WS, DEFAULT_GRID_ID)

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

function press(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function pressCtrlK(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })
    )
  })
}

function storedTree(key = GRID_KEY): LayoutNode | null {
  const raw = localStorage.getItem(`tr-layout:${key}`)
  return raw ? (JSON.parse(raw).tree as LayoutNode | null) : null
}

function hasKind(node: LayoutNode | null, kind: string): boolean {
  if (!node) return false
  if (node.kind === kind) return true
  if (node.kind === 'split' || node.kind === 'stack')
    return (node.children as LayoutNode[]).some((c) => hasKind(c, kind))
  return false
}

function sessionsIn(node: LayoutNode | null): number[] {
  if (!node) return []
  if (node.kind === 'leaf') return [node.session]
  if (node.kind === 'split' || node.kind === 'stack')
    return (node.children as LayoutNode[]).flatMap(sessionsIn)
  return []
}

describe('source control panel — shell integration', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  async function boot(
    sessions: number[],
    workspaces: string[] = [WS]
  ): Promise<void> {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: sessions.map((id) =>
        makeSession({
          id,
          project_dir: workspaces[0] ?? WS,
          cwd: workspaces[0] ?? WS
        })
      ),
      workspaces: workspaces.map((path) => makeWorkspace({ path, name: path.split('/').pop() }))
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  const panel = (): HTMLElement | null =>
    harness!.container.querySelector('[data-testid="source-control-panel"]')

  const slotFor = (key: number | string): HTMLElement => {
    const inner = harness!.container.querySelector<HTMLElement>(`[data-panekey="${key}"]`)
    const el = inner?.closest<HTMLElement>('.pane-slot')
    if (!el) throw new Error(`no pane-slot for pane key ${String(key)}`)
    return el
  }

  async function settlePanel(): Promise<void> {
    // The pane's lazy chunk loads on first open; a cold import under a
    // full-suite run measured ~70 of these 5 ms ticks, so 240 is the margin,
    // not a budget anyone should have to tune again.
    for (let i = 0; i < 240; i++) {
      if (harness!.container.querySelector('[data-testid="changes-pane"]')) return
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
    throw new Error('ChangesPane never left its Suspense fallback after 240 ticks')
  }

  // The palette runs the HIGHLIGHTED row, and a click only moves the
  // highlight — hover the row first, then click it, as a pointer would.
  function runPaletteRow(match: string): void {
    pressCtrlK()
    const row = Array.from(
      harness!.container.querySelectorAll<HTMLElement>('[data-testid="command-palette-row"]')
    ).find((r) => r.textContent?.includes(match))
    if (!row) throw new Error(`"${match}" row not found in the palette`)
    act(() => {
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }))
    })
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }

  function switchToAll(): void {
    runPaletteRow('All workspaces')
  }

  it('`g` opens the panel without writing a git leaf into the saved grid', async () => {
    await boot([1, 2])
    expect(storedTree()).not.toBeNull()
    const before = JSON.stringify(storedTree())

    press('g')
    await settlePanel()

    expect(panel()).not.toBeNull()
    expect(panel()!.getAttribute('data-dir')).toBe(WS)
    expect(hasKind(storedTree(), 'git')).toBe(false)
    expect(JSON.stringify(storedTree())).toBe(before)
  })

  it('a second `g` closes it, keeps the terminals mounted, and keeps the open state', async () => {
    await boot([1, 2])
    const terminalBefore = slotFor(1)
    press('g')
    await settlePanel()
    const enginesBefore = engineCounts().constructed

    press('g')
    expect(panel()).toBeNull()
    expect(slotFor(1)).toBe(terminalBefore)
    expect(engineCounts().constructed).toBe(enginesBefore)
    expect(localStorage.getItem('tr-scm-open')).toBe('0')
  })

  it('remembers the panel open across a remount, and the width with it', async () => {
    await boot([1])
    press('g')
    await settlePanel()
    act(() => {
      setScmWidth(612)
    })
    harness!.unmount()
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [1].map((id) => makeSession({ id, project_dir: WS, cwd: WS })),
      workspaces: [makeWorkspace({ path: WS })]
    })
    await act(async () => {
      await Promise.resolve()
    })
    await settlePanel()
    expect(panel()).not.toBeNull()
    expect(panel()!.style.width).toBe('612px')
  })

  it('migrates a saved git leaf before layouts load: the panel opens and no leaf is lost', async () => {
    const saved: LayoutNode = {
      kind: 'split',
      dir: 'col',
      weights: [40, 30, 20, 10],
      children: [
        { kind: 'leaf', session: 1, id: 'p1' },
        { kind: 'leaf', session: 2, id: 'p2' },
        { kind: 'browser', id: 'b1', url: 'https://example.test' },
        { kind: 'git', id: 'g1' },
      ]
    }
    localStorage.setItem(`tr-layout:${GRID_KEY}`, JSON.stringify({ cols: 4, tree: saved }))

    await boot([1, 2])

    expect(panel()).not.toBeNull()
    await settlePanel()
    const tree = storedTree()
    expect(hasKind(tree, 'git')).toBe(false)
    expect(hasKind(tree, 'browser')).toBe(true)
    expect(sessionsIn(loadLayout(GRID_KEY).tree).sort()).toEqual([1, 2])
  })

  it('scopes to the selected workspace even when a stale pane in another workspace was focused', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [
        makeSession({ id: 1, project_dir: WS, cwd: WS }),
        makeSession({ id: 2, project_dir: WS_B, cwd: WS_B })
      ],
      workspaces: [makeWorkspace({ path: WS }), makeWorkspace({ path: WS_B })]
    })
    await act(async () => {
      await Promise.resolve()
    })
    press('g')
    await settlePanel()
    expect(panel()!.getAttribute('data-dir')).toBe(WS)

    act(() => {
      harness!.container
        .querySelector<HTMLElement>('[data-panekey="2"]')!
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    expect(panel()!.getAttribute('data-dir')).toBe(WS)
  })

  it('in All view the panel follows the focused pane\'s workspace', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [
        makeSession({ id: 1, project_dir: WS, cwd: WS }),
        makeSession({ id: 2, project_dir: WS_B, cwd: WS_B })
      ],
      workspaces: [makeWorkspace({ path: WS }), makeWorkspace({ path: WS_B })]
    })
    await act(async () => {
      await Promise.resolve()
    })
    switchToAll()
    press('g')
    await settlePanel()
    expect(panel()).not.toBeNull()

    act(() => {
      const pane = harness!.container.querySelector<HTMLElement>('[data-panekey="2"]')
      if (!pane) throw new Error('session 2 pane not rendered in All view')
      pane.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    await settlePanel()
    expect(panel()!.getAttribute('data-dir')).toBe(WS_B)
  })

  it('`g` and the top-bar toggle both work in All view', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [makeSession({ id: 1, project_dir: WS, cwd: WS })],
      workspaces: [makeWorkspace({ path: WS }), makeWorkspace({ path: WS_B })]
    })
    await act(async () => {
      await Promise.resolve()
    })
    switchToAll()

    const toggle = (): HTMLButtonElement =>
      harness!.container.querySelector<HTMLButtonElement>('[data-testid="scm-toggle"]')!
    expect(toggle().disabled).toBe(false)

    press('g')
    await settlePanel()
    expect(panel()).not.toBeNull()
    act(() => {
      toggle().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(panel()).toBeNull()
    act(() => {
      toggle().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settlePanel()
    expect(panel()).not.toBeNull()
  })

  it('Open in editor from All view reveals the focused repo and inserts there, never hidden', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [
        makeSession({ id: 1, project_dir: WS, cwd: WS }),
        makeSession({ id: 2, project_dir: WS_B, cwd: WS_B })
      ],
      workspaces: [makeWorkspace({ path: WS }), makeWorkspace({ path: WS_B })]
    })
    await act(async () => {
      await Promise.resolve()
    })
    switchToAll()
    press('g')
    await settlePanel()
    act(() => {
      const pane = harness!.container.querySelector<HTMLElement>('[data-panekey="2"]')
      if (!pane) throw new Error('session 2 pane not rendered in All view')
      pane.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    deliverClientMsg('git_status', {
      type: 'git_status',
      dir: WS_B,
      files: [
        {
          path: 'src/app.ts',
          status: 'modified',
          staged: false,
          added: 1,
          deleted: 0,
          is_sensitive: false
        }
      ],
      branch: 'main',
      upstream: null,
      ahead: 0,
      behind: 0,
      base: null,
      default_base: 'main'
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })

    act(() => {
      harness!.container
        .querySelector<HTMLButtonElement>('[data-testid="changes-row-menu"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const openItem = Array.from(
      harness!.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((b) => b.textContent === 'Open in editor')!
    act(() => {
      openItem.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const grid = harness!.container.querySelector<HTMLElement>(
      `[data-workspace="${WS_B}"]`
    )
    expect(grid?.className).toContain('contents')
    expect(JSON.stringify(storedTree(gridStorageKey(WS_B, DEFAULT_GRID_ID)))).toContain(
      '"editor"'
    )
    expect(JSON.stringify(storedTree('all'))).not.toContain('"editor"')
  })

  it('the palette row still toggles the panel through the old command id', async () => {
    await boot([1])
    runPaletteRow('source control')
    await settlePanel()
    expect(panel()).not.toBeNull()
  })
})
