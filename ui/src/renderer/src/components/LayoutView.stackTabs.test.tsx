// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { leaf, stackWith, type LayoutNode } from '../layout/tree'
import { LayoutView } from './LayoutView'

vi.mock('./BrowserPane', () => ({ BrowserPane: () => null }))
vi.mock('./EditorLeaf', () => ({ EditorLeaf: () => null }))

let mountCount = 0
let unmountCount = 0
vi.mock('../pane/TerminalPane', () => ({
  TerminalPane: ({ info }: { info: SessionInfo }) => {
    useEffect(() => {
      mountCount++
      return () => {
        unmountCount++
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [info.id])
    return null
  }
}))

function makeSession(id: number, status: SessionInfo['status'] = 'idle'): SessionInfo {
  return {
    id,
    agent: 'shell',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: `session-${id}`,
    hidden: false,
    status
  } as SessionInfo
}

const fakeClient = {} as unknown as HoustonClient

describe('LayoutView tab stacks', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mountCount = 0
    unmountCount = 0
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

  function renderStack(
    tree: LayoutNode,
    sessions: Map<number, SessionInfo>,
    onSelectStackTab: (stackId: string, key: number | string) => void = () => {}
  ): void {
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
          onSelectStackTab={onSelectStackTab}
          onUnstack={() => {}}
        />
      )
    })
  }

  it('mounts every tab once and never unmounts one on switch', () => {
    const tree = stackWith(
      { kind: 'split', dir: 'row', children: [leaf(1), leaf(2)], weights: [50, 50] },
      1,
      2
    )
    const sessions = new Map([
      [1, makeSession(1)],
      [2, makeSession(2)]
    ])
    renderStack(tree, sessions)
    expect(mountCount).toBe(2)
    expect(unmountCount).toBe(0)

    const tabs = container.querySelectorAll('[data-testid="stack-tab"]')
    expect(tabs).toHaveLength(2)
    act(() => {
      ;(tabs[1] as HTMLElement).click()
    })
    expect(mountCount).toBe(2)
    expect(unmountCount).toBe(0)

    const slots = container.querySelectorAll('[data-testid="stack-child-slot"]')
    expect(slots).toHaveLength(2)
  })

  it('a background tab that needs input shows a badge without being selected', () => {
    const tree = stackWith(
      { kind: 'split', dir: 'row', children: [leaf(1), leaf(2)], weights: [50, 50] },
      1,
      2
    )
    const sessions = new Map([
      [1, makeSession(1, 'idle')],
      [2, makeSession(2, 'needs-input')]
    ])
    renderStack(tree, sessions)
    const tabs = container.querySelectorAll('[data-testid="stack-tab"]')
    expect(tabs[0].getAttribute('data-active')).toBe('true')
    expect(tabs[1].getAttribute('data-active')).toBe('false')
    expect(tabs[1].getAttribute('data-needs-input-badge')).toBe('true')
    expect(container.querySelector('[data-testid="stack-tab-badge"]')).not.toBeNull()
  })

  it('the active tab never shows the background-needs-input badge, even when it needs input itself', () => {
    const tree = stackWith(
      { kind: 'split', dir: 'row', children: [leaf(1), leaf(2)], weights: [50, 50] },
      1,
      2
    )
    const sessions = new Map([
      [1, makeSession(1, 'needs-input')],
      [2, makeSession(2, 'idle')]
    ])
    renderStack(tree, sessions)
    const tabs = container.querySelectorAll('[data-testid="stack-tab"]')
    expect(tabs[0].getAttribute('data-needs-input-badge')).toBe('false')
  })

  it('clicking a tab calls onSelectStackTab with the stack id and that tab’s key', () => {
    const tree = stackWith(
      { kind: 'split', dir: 'row', children: [leaf(1), leaf(2)], weights: [50, 50] },
      1,
      2
    )
    const sessions = new Map([
      [1, makeSession(1)],
      [2, makeSession(2)]
    ])
    const calls: Array<[string, number | string]> = []
    renderStack(tree, sessions, (stackId, key) => calls.push([stackId, key]))
    const tabs = container.querySelectorAll('[data-testid="stack-tab"]')
    act(() => {
      ;(tabs[1] as HTMLElement).click()
    })
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toBe(2)
  })

  it('shows the cap indicator at MAX_STACK_TABS and never renders a 5th tab', () => {
    let tree: LayoutNode = {
      kind: 'split',
      dir: 'row',
      children: [leaf(1), leaf(2), leaf(3), leaf(4)],
      weights: [25, 25, 25, 25]
    }
    tree = stackWith(tree, 1, 2)
    tree = stackWith(tree, 1, 3)
    tree = stackWith(tree, 1, 4)
    const sessions = new Map([1, 2, 3, 4].map((id) => [id, makeSession(id)]))
    renderStack(tree, sessions)
    expect(container.querySelectorAll('[data-testid="stack-tab"]')).toHaveLength(4)
    expect(container.querySelector('[data-testid="stack-full-indicator"]')?.textContent).toBe(
      '4/4'
    )
  })
})
