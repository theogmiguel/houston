// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { EditorNode, PaneKey, Side } from '../layout/tree'

vi.mock('../pane/TerminalPane', () => ({
  TerminalPane: () => {
    useEffect(() => {}, [])
    return null
  }
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

const TREE = {
  kind: 'split' as const,
  dir: 'row' as const,
  weights: [50, 50],
  children: [
    { kind: 'leaf' as const, session: 1, id: 'p-term-1' },
    { kind: 'editor' as const, id: 'e1', path: 'a.ts' }
  ]
}

const TARGET_BOX = { left: 0, top: 0, width: 400, height: 400 }

const AT: Record<Side, { clientX: number; clientY: number }> = {
  left: { clientX: 20, clientY: 200 },
  right: { clientX: 380, clientY: 200 },
  top: { clientX: 200, clientY: 20 },
  bottom: { clientX: 200, clientY: 380 },
  center: { clientX: 200, clientY: 200 }
}

let container: HTMLDivElement
let root: Root
let onMove: ReturnType<typeof vi.fn>
let onSwap: ReturnType<typeof vi.fn>
let onStackWith: ReturnType<typeof vi.fn> | undefined

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

function renderGrid(): void {
  act(() => {
    root.render(
      <LayoutView
        tree={TREE}
        sessions={makeSessions()}
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
        onSwap={onSwap as never}
        onStackWith={onStackWith as never}
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

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function targetPane(): HTMLElement {
  const el = container.querySelector('[data-panekey="e1"]')
  if (!(el instanceof HTMLElement)) throw new Error('grid did not render the editor pane')
  el.getBoundingClientRect = (() => TARGET_BOX) as unknown as () => DOMRect
  return el
}

function dragTo(zone: Side, opts: { altKey?: boolean } = {}): void {
  const head = container.querySelector('[data-panekey="1"] .pane-head')
  if (!(head instanceof HTMLElement)) throw new Error('no draggable terminal header rendered')
  const target = targetPane()
  document.elementFromPoint = (() => target) as unknown as (x: number, y: number) => Element | null
  act(() => {
    head.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    )
  })
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { ...AT[zone], ...opts }))
  })
}

function release(zone: Side, opts: { altKey?: boolean } = {}): void {
  act(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { ...AT[zone], ...opts }))
  })
}

function indicator(): HTMLElement {
  const el = container.querySelector('[data-testid="pane-dropzone"]')
  if (!(el instanceof HTMLElement)) throw new Error('no drop indicator rendered')
  return el
}

beforeEach(() => {
  ;(window as unknown as { houston: { listShells: () => Promise<unknown[]> } }).houston = {
    listShells: () => Promise.resolve([])
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onMove = vi.fn()
  onSwap = vi.fn()
  onStackWith = vi.fn()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('pane drop indicator', () => {
  it('names the action in every one of the five zones, not just the swap one', async () => {
    const expected: Record<Side, string> = {
      left: 'Split left',
      right: 'Split right',
      top: 'Split up',
      bottom: 'Split down',
      center: 'Swap'
    }
    for (const zone of Object.keys(expected) as Side[]) {
      renderGrid()
      await flush()
      dragTo(zone)
      expect(indicator().dataset.side).toBe(zone)
      expect(indicator().textContent).toBe(expected[zone])
      release(zone)
      act(() => root.unmount())
      root = createRoot(container)
    }
  })

  it('dresses every zone in the same dashed accent stroke — the split bands used to be solid', async () => {
    for (const zone of ['bottom', 'center'] as Side[]) {
      renderGrid()
      await flush()
      dragTo(zone)
      expect(indicator().className).toContain('border-dashed')
      release(zone)
      act(() => root.unmount())
      root = createRoot(container)
    }
  })

  it('the pane being dragged wears a scrim, and it is the only one', async () => {
    renderGrid()
    await flush()
    expect(container.querySelectorAll('[data-testid="pane-drag-scrim"]')).toHaveLength(0)
    dragTo('center')
    const scrims = container.querySelectorAll('[data-testid="pane-drag-scrim"]')
    expect(scrims).toHaveLength(1)
    const scrimSlot = scrims[0]?.parentElement
    expect(scrimSlot?.className).toContain('pane-slot')
    expect(scrimSlot?.querySelector('[data-panekey="e1"]')).toBeNull()
    expect(indicator().parentElement?.querySelector('[data-panekey="e1"]')).not.toBeNull()
    release('center')
    expect(container.querySelectorAll('[data-testid="pane-drag-scrim"]')).toHaveLength(0)
  })

  it('Alt over the swap zone relabels to Stack and the drop stacks — the label cannot lie', async () => {
    renderGrid()
    await flush()
    dragTo('center', { altKey: true })
    expect(indicator().textContent).toBe('Stack')
    release('center', { altKey: true })
    expect(onStackWith).toHaveBeenCalledWith(1 as PaneKey, 'e1' as PaneKey)
    expect(onSwap).not.toHaveBeenCalled()
  })

  it('Alt pressed without moving the pointer still relabels, and releasing it goes back to Swap', async () => {
    renderGrid()
    await flush()
    dragTo('center')
    expect(indicator().textContent).toBe('Swap')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true }))
    })
    expect(indicator().textContent).toBe('Stack')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', altKey: false }))
    })
    expect(indicator().textContent).toBe('Swap')
    release('center')
    expect(onSwap).toHaveBeenCalledWith(1 as PaneKey, 'e1' as PaneKey)
    expect(onStackWith).not.toHaveBeenCalled()
  })

  it('with no stacking callback, Alt over the swap zone stays a Swap', async () => {
    onStackWith = undefined
    renderGrid()
    await flush()
    dragTo('center', { altKey: true })
    expect(indicator().textContent).toBe('Swap')
    release('center', { altKey: true })
    expect(onSwap).toHaveBeenCalledWith(1 as PaneKey, 'e1' as PaneKey)
  })

  it('an edge zone drop still moves, and Alt does not turn it into a stack', async () => {
    renderGrid()
    await flush()
    dragTo('bottom', { altKey: true })
    expect(indicator().textContent).toBe('Split down')
    release('bottom', { altKey: true })
    expect(onMove).toHaveBeenCalledWith(1 as PaneKey, 'e1' as PaneKey, 'bottom')
    expect(onStackWith).not.toHaveBeenCalled()
  })
})
