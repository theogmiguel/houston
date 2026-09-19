// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { leaf, MIN_PANE_PX, type LayoutNode } from '../layout/tree'
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

let gridW = 1200
const GRID_H = 800

let frames: FrameRequestCallback[] = []

describe('LayoutView splitter drag (v76)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    gridW = 1200
    frames = []
    ;(window as unknown as { houston: { listShells: () => Promise<unknown[]> } }).houston = {
      listShells: () => Promise.resolve([])
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          width: gridW,
          height: GRID_H,
          left: 0,
          top: 0,
          right: gridW,
          bottom: GRID_H,
          x: 0,
          y: 0,
          toJSON: () => ({})
        }) as DOMRect
    )
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  function renderTree(tree: LayoutNode, onResize = (): void => {}): void {
    const sessions = new Map<number, SessionInfo>([
      [2, makeSession(2)],
      [10, makeSession(10)]
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
          activeId={2}
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

  const splitTree: LayoutNode = {
    kind: 'split',
    dir: 'row',
    children: [leaf(2), leaf(10)],
    weights: [50, 50]
  }

  const slots = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>('.layout > .pane-slot'))
  const splitter = (): HTMLElement => {
    const el = container.querySelector<HTMLElement>('.splitter')
    if (!el) throw new Error('no splitter rendered')
    return el
  }

  const down = (x: number): void => {
    act(() => {
      splitter().dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x })
      )
    })
  }
  const move = (x: number): void => {
    act(() => {
      splitter().dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: x })
      )
    })
  }
  const flush = (): void => {
    const pending = frames
    frames = []
    act(() => pending.forEach((cb) => cb(0)))
  }
  const up = (x: number): void => {
    act(() => {
      splitter().dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: x })
      )
    })
  }
  const cancel = (): void => {
    act(() => {
      splitter().dispatchEvent(new MouseEvent('pointercancel', { bubbles: true, cancelable: true }))
    })
  }

  it('gives each pane its OWN live rect when DOM order and tree order disagree', () => {
    renderTree(splitTree)
    const [tenth, second] = slots()
    if (!tenth || !second) throw new Error('expected two pane slots')

    down(600)
    move(900)
    flush()

    expect(second.style.left).toContain('calc(0%')
    expect(second.style.width).toContain('calc(75%')
    expect(tenth.style.left).toContain('calc(75%')
    expect(tenth.style.width).toContain('calc(25%')
  })

  it('keeps the gutter inset while dragging, exactly as the render writes it', () => {
    renderTree(splitTree)
    const [tenth, second] = slots()
    if (!tenth || !second) throw new Error('expected two pane slots')
    down(600)
    move(900)
    flush()

    expect(second.style.left).toBe('calc(0% + var(--pane-gutter))')
    expect(second.style.width).toBe('calc(75% - var(--pane-gutter) - calc(var(--pane-gutter) / 2))')
    expect(tenth.style.left).toBe('calc(75% + calc(var(--pane-gutter) / 2))')
    expect(tenth.style.width).toBe('calc(25% - calc(var(--pane-gutter) / 2) - var(--pane-gutter))')
  })

  it('coalesces a burst of moves into one frame and one paint', () => {
    renderTree(splitTree)
    down(600)
    move(700)
    move(800)
    move(900)
    expect(frames.length).toBe(1)
    flush()
    const [, second] = slots()
    expect(second?.style.width).toBe('calc(75% - var(--pane-gutter) - calc(var(--pane-gutter) / 2))')
  })

  it('commits once, from the final pointer position rather than the last frame painted', () => {
    const onResize = vi.fn()
    renderTree(splitTree, onResize)

    down(600)
    move(900)
    flush()
    move(960)
    up(960)

    expect(onResize).toHaveBeenCalledTimes(1)
    expect(onResize).toHaveBeenCalledWith([], 0, 0.8)
  })

  it('paints the hairline only while the drag is live', () => {
    renderTree(splitTree)
    expect(splitter().dataset.dragging).toBeUndefined()

    down(600)
    expect(splitter().dataset.dragging).toBe('true')
    move(900)
    flush()
    expect(splitter().dataset.dragging).toBe('true')

    up(900)
    expect(splitter().dataset.dragging).toBeUndefined()
  })

  it('unpaints the hairline when the gesture is cancelled, not only when it commits', () => {
    renderTree(splitTree)
    down(600)
    move(900)
    flush()
    cancel()
    expect(splitter().dataset.dragging).toBeUndefined()
  })

  it('updates aria-valuenow as the handle moves', () => {
    renderTree(splitTree)
    expect(splitter().getAttribute('aria-valuenow')).toBe('50')
    down(600)
    move(900)
    flush()
    expect(splitter().getAttribute('aria-valuenow')).toBe('75')
  })

  it('clamps at MIN_PANE_PX rather than letting a pane vanish', () => {
    const onResize = vi.fn()
    renderTree(splitTree, onResize)

    down(600)
    move(gridW + 500)
    up(gridW + 500)

    expect(onResize).toHaveBeenCalledWith([], 0, 1 - MIN_PANE_PX / gridW)
  })

  it('restores the pre-drag geometry and commits nothing when the gesture is cancelled', () => {
    const onResize = vi.fn()
    renderTree(splitTree, onResize)
    const [tenth, second] = slots()
    if (!tenth || !second) throw new Error('expected two pane slots')
    const before = { left: second.style.left, width: second.style.width }

    down(600)
    move(900)
    flush()
    expect(second.style.width).not.toBe(before.width)

    cancel()

    expect(onResize).not.toHaveBeenCalled()
    expect(second.style.left).toBe(before.left)
    expect(second.style.width).toBe(before.width)
    expect(tenth.style.left).toBe('calc(50% + calc(var(--pane-gutter) / 2))')
  })

  it('refuses a gesture on a pair too narrow for both floors instead of pinning it to 50/50', () => {
    const onResize = vi.fn()
    gridW = 2 * MIN_PANE_PX
    renderTree(splitTree, onResize)

    down(gridW / 2)
    move(gridW - 10)

    expect(frames.length).toBe(0)
    up(gridW - 10)
    expect(onResize).not.toHaveBeenCalled()
  })
})
