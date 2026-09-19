// @vitest-environment jsdom
import { act } from 'react'
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

describe('browser pane focus geometry (charter §05b)', () => {
  it('an unselected browser pane carries the plain --border and no accent ring', () => {
    const { pane } = mount(false)
    expect(pane.className).toContain('border-[var(--border)]')
    expect(pane.className).not.toContain('--accent')
    expect(pane.className).not.toContain('after:shadow')
  })

  it('a selected browser pane gets the SAME --border-focus tier a terminal does, still 1px', () => {
    const { pane, header } = mount(true)
    expect(pane.className).toContain('border-[var(--border-focus)]')
    expect(pane.className).toMatch(/(^|\s)border(\s|$)/)
    expect(pane.className).not.toMatch(/border-2\b/)
    expect(pane.className).not.toContain('--accent')
    expect(header.className).toContain('bg-[var(--raised)]')
    expect(header.className).not.toContain('--accent')
  })

  it('a selected browser pane in a BLURRED window dims the ring rather than dropping it', () => {
    const { pane } = mount(true)
    act(() => setWindowFocusedForTests(false))
    expect(pane.className).toContain('color-mix(in_srgb,var(--border-focus)_45%,var(--border))')
    expect(pane.className).not.toContain('border-[var(--border-focus)]')
  })

  for (const active of [false, true]) {
    it(`a ${active ? 'selected' : 'unselected'} browser pane carries the pane-tier radius`, () => {
      const { pane } = mount(active)
      expect(pane.className).toContain('rounded-[var(--tr-radius-md)]')
      expect(pane.className).toContain('[@container_(max-width:280px)]:rounded-[var(--tr-radius-sm)]')
    })
  }

})
