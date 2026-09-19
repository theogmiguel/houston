// @vitest-environment jsdom
import { act, StrictMode, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { leaf, type LayoutNode } from '../layout/tree'
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

const renameTitleRenderCounts: Record<string, number> = {}
vi.mock('./RenameTitle', () => ({
  RenameTitle: ({ title }: { title: string }) => {
    renameTitleRenderCounts[title] = (renameTitleRenderCounts[title] ?? 0) + 1
    return null
  }
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

describe('LayoutView expand-in-place (PERF-AUDIT §2)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mountCount = 0
    unmountCount = 0
    for (const key of Object.keys(renameTitleRenderCounts)) delete renameTitleRenderCounts[key]
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

  it('does not remount panes when expandedId toggles', () => {
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

    const render = (expandedId: number | null): void => {
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
            expandedId={expandedId}
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

    render(null)
    expect(mountCount).toBe(2)
    expect(unmountCount).toBe(0)

    render(1)
    expect(mountCount).toBe(2)
    expect(unmountCount).toBe(0)

    render(null)
    expect(mountCount).toBe(2)
    expect(unmountCount).toBe(0)
  })

  it('applies content-visibility:hidden and contain:strict only to the hidden-by-expand slot', () => {
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

    const render = (expandedId: number | null): void => {
      act(() => {
        root.render(
          <StrictMode>
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
              expandedId={expandedId}
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
          </StrictMode>
        )
      })
    }

    const slotFor = (session: number): HTMLElement => {
      const inner = container.querySelector<HTMLElement>(`[data-panekey="${session}"]`)
      const el = inner?.closest<HTMLElement>('.pane-slot')
      if (!el) throw new Error(`no pane-slot for session ${session}`)
      return el
    }

    render(null)
    expect(slotFor(1).style.contentVisibility).toBe('')
    expect(slotFor(1).style.contain).toBe('')
    expect(slotFor(2).style.contentVisibility).toBe('')
    expect(slotFor(2).style.contain).toBe('')

    render(1)
    expect(slotFor(1).style.contentVisibility).toBe('')
    expect(slotFor(1).style.contain).toBe('')
    expect(slotFor(2).style.contentVisibility).toBe('hidden')
    expect(slotFor(2).style.contain).toBe('strict')
    expect(slotFor(2).style.visibility).toBe('hidden')

    render(null)
    expect(slotFor(2).style.contentVisibility).toBe('')
    expect(slotFor(2).style.contain).toBe('')
  })

  it('scopes content-visibility/contain to session leaves only, not browser/editor leaves', () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'row',
      children: [leaf(1), { kind: 'browser', id: 'b1', url: 'http://x' }, { kind: 'editor', id: 'e1', path: '/x' }],
      weights: [34, 33, 33]
    }
    const sessions = new Map<number, SessionInfo>([[1, makeSession(1)]])

    act(() => {
      root.render(
        <StrictMode>
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
            expandedId={999}
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
        </StrictMode>
      )
    })

    const slots = container.querySelectorAll<HTMLElement>('.pane-slot')
    expect(slots.length).toBe(3)
    for (const slot of slots) {
      expect(slot.style.visibility).toBe('hidden')
    }
    const sessionSlot = container.querySelector('[data-panekey]')?.closest<HTMLElement>('.pane-slot')
    if (!sessionSlot) throw new Error('no session pane-slot found')
    expect(sessionSlot.style.contentVisibility).toBe('hidden')
    expect(sessionSlot.style.contain).toBe('strict')

    for (const slot of slots) {
      if (slot === sessionSlot) continue
      expect(slot.style.contentVisibility).toBe('')
      expect(slot.style.contain).toBe('')
    }
  })

  it('does not re-render a hidden sibling SessionPaneImpl body when expandedId toggles', () => {
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
    const noop = (): void => {}
    const registerOutput = (): (() => void) => () => {}

    const render = (expandedId: number | null): void => {
      act(() => {
        root.render(
          <StrictMode>
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
              expandedId={expandedId}
              registerOutput={registerOutput}
              shellIntegration={false}
              workspaceDir="/tmp/project"
              onReconnectSsh={noop}
              onActivate={noop}
              onExpand={noop}
              onZoom={noop}
              onShellZoom={noop}
              onSplit={noop}
              onMove={noop}
              onSwap={noop}
              onResize={noop}
              onCloseBrowser={noop}
              onBrowserNavigate={noop}
              onCloseEditor={noop}
              onSplitEditor={() => {}}
              onHandoff={noop}
              onOpenFile={noop}
              onOpenDir={noop}
            />
          </StrictMode>
        )
      })
    }

    render(null)
    const baseline1 = renameTitleRenderCounts['session-1'] ?? 0
    const baseline2 = renameTitleRenderCounts['session-2'] ?? 0
    expect(baseline1).toBeGreaterThan(0)
    expect(baseline2).toBeGreaterThan(0)

    render(1)
    expect(renameTitleRenderCounts['session-2']).toBe(baseline2)

    render(null)
    expect(renameTitleRenderCounts['session-2']).toBe(baseline2)
  })
})
