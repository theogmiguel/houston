// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filesPane, leaf, type LayoutNode } from '../layout/tree'
import { LayoutView } from './LayoutView'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./BrowserPane', () => ({ BrowserPane: () => null, tabsStorageKey: () => 'k' }))
vi.mock('./EditorLeaf', () => ({ EditorLeaf: () => null }))
vi.mock('../pane/TerminalPane', () => ({ TerminalPane: () => null }))

describe('surfaces kept off the boot chunk still load on demand', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(window as unknown as { houston: unknown }).houston = {
      listShells: () => Promise.resolve([]),
      fsList: () => Promise.resolve([])
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function settle(present: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
      if (present()) return
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
    throw new Error(`${what} never left its Suspense fallback after 60 ticks`)
  }

  it('a files leaf resolves FilesPane through LayoutView', async () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'row',
      children: [leaf(1), filesPane('/tmp/ws', 'f1')],
      weights: [50, 50]
    }
    act(() => {
      root.render(
        <LayoutView
          tree={tree}
          sessions={new Map()}
          viewAll={false}
          client={{} as never}
          theme="warm-espresso"
          fontSize={13}
          copyOnSelect={false}
          stripBoxGlyphs={true}
          activeId={null}
          activeLeafId={'f1'}
          connected={true}
          expandedId={null}
          registerOutput={() => () => {}}
          shellIntegration={false}
          workspaceDir="/tmp/ws"
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
          onCloseFiles={() => {}}
          onHandoff={() => {}}
          onOpenFile={() => {}}
          onOpenDir={() => {}}
        />
      )
    })
    await settle(() => container.querySelector('[data-panekey="f1"]') !== null, 'FilesPane')
    expect(container.querySelector('[data-panekey="f1"]')).not.toBeNull()
  })
})
