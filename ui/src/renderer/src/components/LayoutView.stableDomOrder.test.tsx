// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { leaf, swapLeaf, type LayoutNode } from '../layout/tree'
import { LayoutView } from './LayoutView'

vi.mock('./BrowserPane', () => ({ BrowserPane: () => null }))
vi.mock('./EditorLeaf', () => ({ EditorLeaf: () => null }))
vi.mock('../pane/TerminalPane', () => ({
  TerminalPane: () => null
}))
vi.mock('./RenameTitle', () => ({
  RenameTitle: () => null
}))

function makeSession(id: number): SessionInfo {
  return {
    id,
    agent: 'shell',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: `session-${id}`,
    hidden: false
  } as SessionInfo
}

const fakeClient = {} as unknown as HoustonClient

describe('LayoutView stable DOM order across swaps (PERF-ADOPTION §C.2 C1)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(window as unknown as { houston: { listShells: () => Promise<unknown[]> } }).houston = {
      listShells: () => Promise.resolve([])
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (tree: LayoutNode, sessions: Map<number, SessionInfo>): void => {
    act(() => {
      root.render(
        <LayoutView
          tree={tree}
          sessions={sessions}
          viewAll={false}
          client={fakeClient}
          theme="warm-espresso"
          fontSize={13}
          copyOnSelect={false}
          stripBoxGlyphs={true}
          activeId={1}
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
          onMove={() => {}}
          onSwap={() => {}}
          onResize={() => {}}
          onCloseBrowser={() => {}}
          onBrowserNavigate={() => {}}
          onCloseEditor={() => {}}
          onSplitEditor={() => {}}
          onHandoff={() => {}}
          onOpenFile={() => {}}
          onOpenDir={() => {}}
        />
      )
    })
  }

  it('swapLeaf changes pane styles, never DOM child order or node identity', () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'row',
      children: [leaf(1), leaf(2)],
      weights: [50, 50]
    }
    const sessions = new Map<number, SessionInfo>([
      [1, makeSession(1)],
      [2, makeSession(2)]
    ])

    render(tree, sessions)
    const before = Array.from(container.querySelectorAll<HTMLElement>('.pane-slot'))
    expect(before).toHaveLength(2)
    const beforeLefts = before.map((el) => el.style.left)
    expect(beforeLefts[0]).not.toBe(beforeLefts[1])

    const swapped = swapLeaf(tree, 1, 2)!
    render(swapped, sessions)
    const after = Array.from(container.querySelectorAll<HTMLElement>('.pane-slot'))
    expect(after).toHaveLength(2)

    expect(after[0].style.left).toBe(beforeLefts[1])
    expect(after[1].style.left).toBe(beforeLefts[0])
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
  })
})
