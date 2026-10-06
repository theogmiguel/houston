// @vitest-environment jsdom
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserNode } from '../layout/tree'
import { BrowserPane } from './BrowserPane'
import { setWindowFocusedForTests } from '../windowFocus'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  setWindowFocusedForTests(true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function mount(active: boolean): { pane: HTMLElement; header: HTMLElement } {
  const n: BrowserNode = { kind: 'browser', id: 'b1', url: 'https://example.com' }
  act(() => {
    root.render(
      <BrowserPane
        node={n}
        workspaceDir="/tmp/tr-test-ws"
        active={active}
        onNavigate={() => {}}
        onClose={() => {}}
        onHeaderPointerDown={() => {}}
      />
    )
  })
  const pane = container.querySelector('.pane.browser')
  const header = container.querySelector('.pane-head')
  if (!(pane instanceof HTMLElement) || !(header instanceof HTMLElement)) {
    throw new Error('BrowserPane did not render its .pane.browser/.pane-head')
  }
  return { pane, header }
}

const paneFocusCss = (): string => readFileSync(join(__dirname, 'ui/paneFocus.css'), 'utf8')
const themeCss = (): string => readFileSync(join(__dirname, '../theme.css'), 'utf8')

describe('browser pane focus geometry (charter §05b)', () => {
  it('an unselected browser pane carries the plain --border and no accent ring', () => {
    const { pane } = mount(false)
    expect(pane.dataset.paneFocusBorder).toBe('none')
    expect(pane.className).not.toContain('--accent')
    expect(pane.className).not.toContain('after:shadow')
    expect(paneFocusCss()).toContain("[data-pane-focus-border='none'] { border-color: var(--border); }")
  })

  it('a selected browser pane gets the SAME --border-focus tier a terminal does, still 1px', () => {
    const { pane, header } = mount(true)
    expect(pane.dataset.paneFocusBorder).toBe('full')
    expect(pane.className).not.toMatch(/border-2\b/)
    expect(pane.className).not.toContain('--accent')
    expect(header.dataset.paneFocusHead).toBe('full')
    expect(header.className).not.toContain('--accent')
    const css = paneFocusCss()
    expect(css).toContain("[data-pane-focus-border='full'] { border-color: var(--border-focus); }")
    expect(css).toContain('border-width: var(--pane-frame-border-width);')
    expect(css).toContain("[data-pane-focus-head='full'] { background: var(--raised); }")
    expect(themeCss()).toContain('--pane-frame-border-width: 1px;')
  })

  it('a selected browser pane in a BLURRED window dims the ring rather than dropping it', () => {
    const { pane } = mount(true)
    act(() => setWindowFocusedForTests(false))
    expect(pane.dataset.paneFocusBorder).toBe('dim')
    expect(paneFocusCss()).toContain("[data-pane-focus-border='dim'] { border-color: var(--pane-focus-border-dim); }")
    expect(themeCss()).toContain('--pane-focus-border-dim: color-mix(in srgb, var(--border-focus) 45%, var(--border));')
  })

  for (const active of [false, true]) {
    it(`a ${active ? 'selected' : 'unselected'} browser pane carries the pane-tier radius`, () => {
      const { pane } = mount(active)
      expect(pane.dataset.paneFocusBorder).toBeDefined()
      expect(paneFocusCss()).toContain('border-radius: var(--tr-radius-md);')
      expect(pane.className).toContain('[@container_(max-width:280px)]:rounded-[var(--tr-radius-sm)]')
    })
  }
})
