// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { leaf, MIN_PANE_PX, setRatio, type LayoutNode } from '../layout/tree'
import { LayoutView } from './LayoutView'

vi.mock('./BrowserPane', () => ({ BrowserPane: () => null }))
vi.mock('./EditorLeaf', () => ({ EditorLeaf: () => null }))
vi.mock('../pane/TerminalPane', () => ({ TerminalPane: () => null }))

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

const GRID_W = 1200
const GRID_H = 800
const STEP = 0.04

describe('LayoutView keyboard-resizable splitters (P3 #24)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(window as unknown as { houston: { listShells: () => Promise<unknown[]> } }).houston = {
      listShells: () => Promise.resolve([])
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: GRID_W,
      height: GRID_H,
      left: 0,
      top: 0,
      right: GRID_W,
      bottom: GRID_H,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  function renderTree(tree: LayoutNode, onResize: (path: number[], index: number, ratio: number) => void): void {
    const sessions = new Map<number, SessionInfo>([
      [1, makeSession(1)],
      [2, makeSession(2)],
      [3, makeSession(3)]
    ])
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
          onResize={onResize}
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

  it('is reachable/focusable and resizes a row splitter one step per ArrowRight, clamped like a drag', () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'row',
      children: [leaf(1), leaf(2)],
      weights: [50, 50]
    }
    const onResize = vi.fn()
    renderTree(tree, onResize)

    const splitter = container.querySelector<HTMLElement>('.splitter')
    if (!splitter) throw new Error('no splitter rendered')
    expect(splitter.tabIndex).toBe(0)
    expect(splitter.getAttribute('role')).toBe('separator')
    expect(splitter.getAttribute('aria-orientation')).toBe('vertical')
    expect(splitter.getAttribute('aria-label')).toBeTruthy()
    expect(splitter.getAttribute('aria-valuemin')).toBe('0')
    expect(splitter.getAttribute('aria-valuemax')).toBe('100')
    expect(splitter.getAttribute('aria-valuenow')).toBe('50')

    act(() => {
      splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })

    expect(onResize).toHaveBeenCalledTimes(1)
    expect(onResize).toHaveBeenCalledWith([], 0, 0.5 + STEP)
  })

  it('resizes a col splitter one step per ArrowDown on its own axis', () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'col',
      children: [leaf(1), leaf(2)],
      weights: [50, 50]
    }
    const onResize = vi.fn()
    renderTree(tree, onResize)

    const splitter = container.querySelector<HTMLElement>('.splitter')
    if (!splitter) throw new Error('no splitter rendered')
    expect(splitter.getAttribute('aria-orientation')).toBe('horizontal')

    act(() => {
      splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })

    expect(onResize).toHaveBeenCalledTimes(1)
    expect(onResize).toHaveBeenCalledWith([], 0, 0.5 + STEP)
  })

  it('leaves the perpendicular axis alone: ArrowUp/ArrowDown do not resize a row splitter', () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'row',
      children: [leaf(1), leaf(2)],
      weights: [50, 50]
    }
    const onResize = vi.fn()
    renderTree(tree, onResize)

    const splitter = container.querySelector<HTMLElement>('.splitter')
    if (!splitter) throw new Error('no splitter rendered')

    act(() => {
      splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    })
    act(() => {
      splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })

    expect(onResize).not.toHaveBeenCalled()
  })

  it('resizes a nested splitter in its own local coordinate space (non-zero startPct)', () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'row',
      children: [
        leaf(1),
        { kind: 'split', dir: 'row', children: [leaf(2), leaf(3)], weights: [50, 50] }
      ],
      weights: [50, 50]
    }
    const onResize = vi.fn()
    renderTree(tree, onResize)

    const splitters = container.querySelectorAll<HTMLElement>('.splitter')
    expect(splitters.length).toBe(2)
    const nested = splitters[1]

    act(() => {
      nested.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })

    expect(onResize).toHaveBeenCalledTimes(1)
    expect(onResize).toHaveBeenCalledWith([1], 0, 0.5 + STEP)
  })

  it('clamps repeated ArrowRight presses at the resize floor without overshoot or stalling short', () => {
    let tree: LayoutNode = { kind: 'split', dir: 'row', children: [leaf(1), leaf(2)], weights: [50, 50] }
    const onResize = (path: number[], index: number, ratio: number): void => {
      tree = setRatio(tree, path, index, ratio)
      renderTree(tree, onResize)
    }
    renderTree(tree, onResize)

    const pressArrowRight = (): void => {
      const splitter = container.querySelector<HTMLElement>('.splitter')
      if (!splitter) throw new Error('no splitter rendered')
      act(() => {
        splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      })
    }

    const bound = 1 - MIN_PANE_PX / GRID_W
    const presses = Math.ceil((bound - 0.5) / STEP)
    for (let i = 0; i < presses; i++) pressArrowRight()
    const atBound = (tree as { weights: number[] }).weights[0]
    expect(atBound).toBeCloseTo(bound * 100, 5)

    pressArrowRight()
    pressArrowRight()
    expect((tree as { weights: number[] }).weights[0]).toBeCloseTo(atBound, 5)
  })
})
