// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { leaf, type LayoutNode } from '../layout/tree'
import { LayoutView, PANE_DRAG_CLASS } from './LayoutView'

vi.mock('./BrowserPane', () => ({ BrowserPane: () => null }))
vi.mock('./EditorLeaf', () => ({ EditorLeaf: () => null }))
;(window as unknown as { houston: unknown }).houston = { listShells: () => Promise.resolve([]) }
vi.mock('../pane/TerminalPane', () => ({ TerminalPane: () => null }))

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
document.elementFromPoint = (() => null) as unknown as typeof document.elementFromPoint

const TREE: LayoutNode = {
  kind: 'split',
  dir: 'row',
  weights: [50, 50],
  children: [
    leaf(2),
    leaf(10)
  ]
}

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

let container: HTMLDivElement
let root: Root
const root_el = (): HTMLElement => document.documentElement

function renderGrid(): void {
  act(() => {
    root.render(
      <LayoutView
        tree={TREE}
        sessions={
          new Map<number, SessionInfo>([
            [2, makeSession(2)],
            [10, makeSession(10)]
          ])
        }
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

function header(): HTMLElement {
  const head = container.querySelector('[data-panekey="2"] .pane-head')
  if (!(head instanceof HTMLElement)) throw new Error('no pane header rendered for 2')
  return head
}

function selectSomeText(): void {
  const text = document.createElement('p')
  text.textContent = 'sidebar label'
  document.body.appendChild(text)
  const range = document.createRange()
  range.selectNodeContents(text)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  root_el().classList.remove(PANE_DRAG_CLASS)
  window.getSelection()?.removeAllRanges()
})

describe('pane header drag selection guard', () => {
  it('sets the guard and clears an existing selection on pointerdown, removes it on pointerup', () => {
    renderGrid()
    selectSomeText()
    expect(window.getSelection()?.toString()).toBe('sidebar label')

    act(() => {
      header().dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
    })
    expect(root_el().classList.contains(PANE_DRAG_CLASS)).toBe(true)
    expect(window.getSelection()?.toString()).toBe('')

    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 60, clientY: 10 }))
    })
    expect(root_el().classList.contains(PANE_DRAG_CLASS)).toBe(true)

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 60, clientY: 10 }))
    })
    expect(root_el().classList.contains(PANE_DRAG_CLASS)).toBe(false)
  })

  it.each(['pointercancel', 'blur'])('removes the guard on %s', (type) => {
    renderGrid()
    act(() => {
      header().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    expect(root_el().classList.contains(PANE_DRAG_CLASS)).toBe(true)
    act(() => {
      window.dispatchEvent(new Event(type))
    })
    expect(root_el().classList.contains(PANE_DRAG_CLASS)).toBe(false)
  })
})

describe('selection guard CSS', () => {
  const css = readFileSync(join(__dirname, '..', 'base.css'), 'utf8')

  it('turns user-select off for the drag class and for pane headers and the terminal host', () => {
    expect(css).toMatch(new RegExp(`html\\.${PANE_DRAG_CLASS}\\s*\\*[^{]*\\{[^}]*user-select:\\s*none\\s*!important`))
    const header = readFileSync(join(__dirname, 'ui', 'PaneHeader.tsx'), 'utf8')
    expect(header).toMatch(/className=\{`group pane-head [^`]*\bselect-none\b[^`]*\[&_input\]:select-text/)
    const chrome = readFileSync(join(__dirname, 'ui', 'TerminalHost.tsx'), 'utf8')
    const hostStyles = readFileSync(join(__dirname, 'ui', 'TerminalHost.css'), 'utf8')
    expect(chrome).toMatch(/className="term-host /)
    expect(hostStyles).toMatch(/\.term-host\s*\{[^}]*user-select:\s*none/)
  })
})
