// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { DetachPayload } from '../layout/paneDetach'
import type { BrowserNode, EditorNode } from '../layout/tree'

vi.mock('../pane/TerminalPane', () => ({
  TerminalPane: () => {
    useEffect(() => {}, [])
    return null
  }
}))
vi.mock('./BrowserPane', () => ({
  BrowserPane: ({
    node,
    onHeaderPointerDown
  }: {
    node: BrowserNode
    onHeaderPointerDown: (e: React.PointerEvent) => void
  }) => (
    <div data-panekey={node.id}>
      <div
        className="pane-head"
        onPointerDown={(e) => onHeaderPointerDown(e as unknown as React.PointerEvent)}
      />
    </div>
  )
}))
vi.mock('./EditorLeaf', () => ({
  EditorLeaf: ({
    node,
    onHeaderPointerDown
  }: {
    node: EditorNode
    onHeaderPointerDown: (e: React.PointerEvent) => void
  }) => (
    <div data-panekey={node.id}>
      <div
        className="pane-head"
        onPointerDown={(e) => onHeaderPointerDown(e as unknown as React.PointerEvent)}
      />
    </div>
  )
}))

const { LayoutView } = await import('./LayoutView')

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let sidebarRow: HTMLDivElement
let elementFromPointResult: Element | null = null

const TERM_AND_EDITOR_TREE = {
  kind: 'split' as const,
  dir: 'row' as const,
  weights: [50, 50],
  children: [
    { kind: 'leaf' as const, session: 1, id: 'p-term-1' },
    { kind: 'editor' as const, id: 'e1', path: 'a.ts' }
  ]
}

const BROWSER_AND_EDITOR_TREE = {
  kind: 'split' as const,
  dir: 'row' as const,
  weights: [50, 50],
  children: [
    { kind: 'browser' as const, id: 'b1', url: 'https://b.test/' },
    { kind: 'editor' as const, id: 'e1', path: 'a.ts' }
  ]
}

function makeSessions(): Map<number, SessionInfo> {
  return new Map<number, SessionInfo>([
    [
      1,
      {
        id: 1,
        agent: 'shell',
        project_dir: '/tmp/project',
        cwd: '/tmp/project',
        state: 'running',
        title: 'Term-1',
        detected_agent: null,
        hidden: false,
        ssh_host: null,
        restore_deferred: null,
        status: null,
        swarm_agent: null
      } as unknown as SessionInfo
    ]
  ])
}

function renderGrid(
  tree: typeof TERM_AND_EDITOR_TREE | typeof BROWSER_AND_EDITOR_TREE,
  sessions: Map<number, SessionInfo>,
  onDetach: (p: DetachPayload) => void,
  onMove: (dragged: unknown, target: unknown, side: unknown) => void = () => {}
): void {
  act(() => {
    root.render(
      <LayoutView
        tree={tree}
        sessions={sessions}
        viewAll={false}
        client={{} as HoustonClient}
        theme="warm-espresso"
        fontSize={13}
        copyOnSelect={false}
        stripBoxGlyphs={false}
        activeId={null}
        connected={true}
        expandedId={null}
        registerOutput={() => () => {}}
        shellIntegration={false}
        workspaceDir="/tmp/project"
        onReconnectSsh={() => {}}
        onActivate={() => {}}
        onExpand={() => {}}
        onZoom={() => {}}
        onShellZoom={() => {}}
        onSplit={() => {}}
        onMove={onMove as never}
        onSwap={() => {}}
        onResize={() => {}}
        onCloseBrowser={() => {}}
        onBrowserNavigate={() => {}}
        onCloseEditor={() => {}}
        onSplitEditor={() => {}}
        onHandoff={() => {}}
        onOpenFile={() => {}}
        onOpenDir={() => {}}
        onDetach={onDetach}
      />
    )
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function drag(head: HTMLElement): void {
  act(() => {
    head.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    )
  })
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 10 }))
  })
  act(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 40, clientY: 10 }))
  })
}

beforeEach(() => {
  ;(window as unknown as { houston: { listShells: () => Promise<unknown[]> } }).houston = {
    listShells: () => Promise.resolve([])
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  sidebarRow = document.createElement('div')
  sidebarRow.setAttribute('data-ws-idx', '0')
  document.body.appendChild(sidebarRow)
  elementFromPointResult = null
  document.elementFromPoint = ((): Element | null => elementFromPointResult) as unknown as (
    x: number,
    y: number
  ) => Element | null
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  sidebarRow.remove()
})

describe('pane detach drop-target recognition (Phase 6 item 2, D18)', () => {
  it('dragging a terminal pane onto a sidebar workspace row calls onDetach with the donor payload shape', async () => {
    const onDetach = vi.fn()
    renderGrid(TERM_AND_EDITOR_TREE, makeSessions(), onDetach)
    await flush()

    const head = container.querySelector('[data-panekey="1"] .pane-head')
    if (!(head instanceof HTMLElement)) throw new Error('no draggable terminal header rendered')

    elementFromPointResult = sidebarRow
    drag(head)
    await flush()

    expect(onDetach).toHaveBeenCalledTimes(1)
    expect(onDetach).toHaveBeenCalledWith({
      paneId: 1,
      sourceWorkspaceId: '/tmp/project',
      paneType: 'terminal',
      sessionId: 1
    })
  })

  it('dragging a browser pane over a sidebar row never offers a drop target (no cwd to detach with)', async () => {
    const onDetach = vi.fn()
    renderGrid(BROWSER_AND_EDITOR_TREE, makeSessions(), onDetach)
    await flush()

    const head = container.querySelector('[data-panekey="b1"] .pane-head')
    if (!(head instanceof HTMLElement)) throw new Error('no draggable browser header rendered')

    elementFromPointResult = sidebarRow
    drag(head)
    await flush()

    expect(onDetach).not.toHaveBeenCalled()
  })

  it('dragging an editor pane over a sidebar row never offers a drop target (no root of its own in this tree — see F2)', async () => {
    const onDetach = vi.fn()
    renderGrid(TERM_AND_EDITOR_TREE, makeSessions(), onDetach)
    await flush()

    const head = container.querySelector('[data-panekey="e1"] .pane-head')
    if (!(head instanceof HTMLElement)) throw new Error('no draggable editor header rendered')

    elementFromPointResult = sidebarRow
    drag(head)
    await flush()

    expect(onDetach).not.toHaveBeenCalled()
  })

  it('session-mismatch guard: a session that died mid-drag is never detached', async () => {
    const onDetach = vi.fn()
    const sessions = makeSessions()
    renderGrid(TERM_AND_EDITOR_TREE, sessions, onDetach)
    await flush()

    const head = container.querySelector('[data-panekey="1"] .pane-head')
    if (!(head instanceof HTMLElement)) throw new Error('no draggable terminal header rendered')

    sessions.delete(1)
    elementFromPointResult = sidebarRow
    drag(head)
    await flush()

    expect(onDetach).not.toHaveBeenCalled()
  })

  it('a plain pane-to-pane drag (not over the sidebar) still moves as before, never calling onDetach', async () => {
    const onDetach = vi.fn()
    const onMove = vi.fn()
    renderGrid(TERM_AND_EDITOR_TREE, makeSessions(), onDetach, onMove)
    await flush()

    const head = container.querySelector('[data-panekey="1"] .pane-head')
    const targetPane = container.querySelector('[data-panekey="e1"]')
    if (!(head instanceof HTMLElement) || !(targetPane instanceof HTMLElement)) {
      throw new Error('grid did not render both panes')
    }

    elementFromPointResult = targetPane
    drag(head)
    await flush()

    expect(onDetach).not.toHaveBeenCalled()
    expect(onMove).toHaveBeenCalledTimes(1)
  })
})
