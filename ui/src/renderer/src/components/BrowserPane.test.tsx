// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserNode } from '../layout/tree'
import { BrowserPane } from './BrowserPane'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function node(id: string, url: string): BrowserNode {
  return { kind: 'browser', id, url }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function mount(n: BrowserNode, onNavigate: (url: string) => void = () => {}): void {
  act(() => {
    root.render(
      <BrowserPane node={n} workspaceDir="/tmp/tr-test-ws" onNavigate={onNavigate} onClose={() => {}} onHeaderPointerDown={() => {}} />
    )
  })
}

function urlInput(): HTMLInputElement {
  const el = container.querySelector('input[aria-label="Address and search bar"]')
  if (!(el instanceof HTMLInputElement)) throw new Error('address bar not rendered')
  return el
}

function typeAndEnter(value: string): void {
  const input = urlInput()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

function openTabsPopover(): void {
  const pill = container.querySelector('button[aria-haspopup="menu"]')
  if (!(pill instanceof HTMLElement)) throw new Error('no tab-count pill rendered')
  act(() => {
    pill.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

describe('BrowserPane persisted tabs use a DISTINCT key per leaf (C9 item 2)', () => {
  it('writes each leaf to its own storage key, not one shared set', () => {
    const containerA = document.createElement('div')
    document.body.appendChild(containerA)
    const rootA = createRoot(containerA)
    act(() => {
      rootA.render(
        <BrowserPane
          node={node('leaf-a', 'https://a.example/')}
          workspaceDir="/tmp/tr-test-ws"
          onNavigate={() => {}}
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
        />
      )
    })
    mount(node('leaf-b', 'https://b.example/'))
    act(() => rootA.unmount())
    containerA.remove()

    const a = JSON.parse(localStorage.getItem('tr-browser-tabs.leaf.leaf-a') ?? 'null') as {
      tabs: { id: number; url: string }[]
    }
    const b = JSON.parse(localStorage.getItem('tr-browser-tabs.leaf.leaf-b') ?? 'null') as {
      tabs: { id: number; url: string }[]
    }
    expect(a.tabs).toEqual([{ id: 1, url: 'https://a.example/' }])
    expect(b.tabs).toEqual([{ id: 1, url: 'https://b.example/' }])
    expect(localStorage.getItem('tr-browser-tabs.leaf.leaf-a')).not.toBeNull()
    expect(localStorage.getItem('tr-browser-tabs.leaf.leaf-b')).not.toBeNull()
  })

  it('restores a leaf from ITS OWN key, surviving a restart', () => {
    localStorage.setItem(
      'tr-browser-tabs.leaf.leaf-a',
      JSON.stringify({ tabs: [{ id: 5, url: 'https://saved.example/' }], activeTabId: 5 })
    )
    localStorage.setItem(
      'tr-browser-tabs.leaf.leaf-b',
      JSON.stringify({ tabs: [{ id: 9, url: 'https://other-leafs-page.example/' }], activeTabId: 9 })
    )

    mount(node('leaf-a', 'https://fallback.example/'))

    expect(urlInput().value).toBe('https://saved.example/')
    expect(container.textContent).not.toContain('other-leafs-page.example')
  })

  it('seeds a fresh leaf from its OWN node.url, not RightPanel’s empty default', () => {
    mount(node('leaf-fresh', 'https://existing-leaf.example/'))

    expect(urlInput().value).toBe('https://existing-leaf.example/')
    expect(container.querySelector('[data-testid="browser-pane-open-cta"]')).toBeNull()
  })
})

describe('BrowserPane recents are the SAME global store RightPanel uses (C9 item 3)', () => {
  it('pushes a navigated url into tr-browser-recents', () => {
    mount(node('leaf-a', 'https://a.example/'))
    typeAndEnter('https://pushed.example/')

    const recents = JSON.parse(localStorage.getItem('tr-browser-recents') ?? '[]') as string[]
    expect(recents).toContain('https://pushed.example/')
  })

  it('offers recents in the empty-state CTA once every tab is closed', () => {
    localStorage.setItem('tr-browser-recents', JSON.stringify(['https://remembered.example/']))
    mount(node('leaf-a', 'https://a.example/'))

    openTabsPopover()
    const closeBtn = container.querySelector('button[aria-label^="Close "]')
    if (!(closeBtn instanceof HTMLElement)) throw new Error('no close button in tabs popover')
    act(() => closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))

    const cta = container.querySelector('[data-testid="browser-pane-open-cta"]')
    expect(cta).not.toBeNull()
    expect(container.textContent).toContain('remembered.example')
  })
})

describe('BrowserPane empty-state CTA (C9 item 1)', () => {
  it('does not show on an existing leaf that already has a page', () => {
    mount(node('leaf-a', 'https://a.example/'))
    expect(container.querySelector('[data-testid="browser-pane-open-cta"]')).toBeNull()
  })

  it('shows once the leaf’s last tab is closed', () => {
    mount(node('leaf-a', 'https://a.example/'))
    openTabsPopover()
    const closeBtn = container.querySelector('button[aria-label^="Close "]')
    if (!(closeBtn instanceof HTMLElement)) throw new Error('no close button in tabs popover')
    act(() => closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))

    expect(container.querySelector('[data-testid="browser-pane-open-cta"]')).not.toBeNull()
  })
})

describe('BrowserPane back/forward carry a real disabled attribute (C9 item 5)', () => {
  it('starts disabled and enables only once the webview reports navigable history', () => {
    mount(node('leaf-a', 'https://a.example/'))
    const back = container.querySelector('button[aria-label="Back"]')
    const forward = container.querySelector('button[aria-label="Forward"]')
    if (!(back instanceof HTMLButtonElement) || !(forward instanceof HTMLButtonElement)) {
      throw new Error('nav buttons not rendered')
    }
    expect(back.disabled).toBe(true)
    expect(forward.disabled).toBe(true)

    const wv = container.querySelector('webview[data-browser-tab]') as
      | (HTMLElement & { canGoBack?: () => boolean; canGoForward?: () => boolean })
      | null
    if (!wv) throw new Error('no tab webview rendered')
    wv.canGoBack = () => true
    wv.canGoForward = () => false
    act(() => {
      const e = new Event('did-navigate') as Event & { url?: string }
      Object.defineProperty(e, 'url', { value: 'https://a.example/page2' })
      wv.dispatchEvent(e)
    })

    expect(back.disabled).toBe(false)
    expect(forward.disabled).toBe(true)
  })
})

describe('BrowserPane persists its active tab’s url into the layout tree', () => {
  it('calls onNavigate with the active tab’s url on navigation, not on close/select', () => {
    const seen: string[] = []
    mount(node('leaf-a', 'https://a.example/'), (url) => seen.push(url))
    expect(seen).toEqual(['https://a.example/'])

    const wv = container.querySelector('webview[data-browser-tab]') as
      | (HTMLElement & { canGoBack?: () => boolean; canGoForward?: () => boolean })
      | null
    if (!wv) throw new Error('no tab webview rendered')
    act(() => {
      const e = new Event('did-navigate') as Event & { url?: string }
      Object.defineProperty(e, 'url', { value: 'https://a.example/deeper' })
      wv.dispatchEvent(e)
    })

    expect(seen).toEqual(['https://a.example/', 'https://a.example/deeper'])
  })
})

describe('BrowserPane fullscreen toggle (C10)', () => {
  function toggleButton(): HTMLButtonElement {
    const el = container.querySelector('button[aria-label="Expand browser to full screen"], button[aria-label="Exit full screen"]')
    if (!(el instanceof HTMLButtonElement)) throw new Error('fullscreen toggle button not rendered')
    return el
  }

  it('carries the carve’s exact copy strings and flips them with aria-pressed on click', () => {
    mount(node('leaf-a', 'https://a.example/'))

    const btn = toggleButton()
    expect(btn.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Expand to full screen')
    expect(btn.getAttribute('aria-label')).toBe('Expand browser to full screen')
    expect(btn.getAttribute('aria-pressed')).toBe('false')

    act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))

    const opened = toggleButton()
    expect(opened.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Exit full screen (Esc)')
    expect(opened.getAttribute('aria-label')).toBe('Exit full screen')
    expect(opened.getAttribute('aria-pressed')).toBe('true')
  })

  it('is disabled when the active tab has no page to expand', () => {
    mount(node('leaf-a', 'https://a.example/'))
    expect(toggleButton().disabled).toBe(false)

    openTabsPopover()
    const newTabBtn = container.querySelector('[data-testid="browser-new-tab"]')
    if (!(newTabBtn instanceof HTMLElement)) throw new Error('no "New tab" button rendered')
    act(() => newTabBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))

    expect(toggleButton().disabled).toBe(true)
  })

  it('renders the fullscreen modal with the exit button’s own strings, and Esc exits it', () => {
    mount(node('leaf-a', 'https://a.example/'))
    act(() => toggleButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))

    const exitBtn = document.body.querySelector('[data-testid="browser-fullscreen-exit"]')
    if (!(exitBtn instanceof HTMLButtonElement)) throw new Error('fullscreen exit button not rendered')
    expect(exitBtn.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Exit full screen (Esc)')
    expect(exitBtn.getAttribute('aria-label')).toBe('Exit full screen')
    expect(exitBtn.getAttribute('aria-pressed')).toBe('true')

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(document.body.querySelector('[data-testid="browser-fullscreen-exit"]')).toBeNull()
    expect(toggleButton().getAttribute('aria-pressed')).toBe('false')
  })

  it('the exit button itself also closes fullscreen', () => {
    mount(node('leaf-a', 'https://a.example/'))
    act(() => toggleButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))

    const exitBtn = document.body.querySelector('[data-testid="browser-fullscreen-exit"]')
    if (!(exitBtn instanceof HTMLButtonElement)) throw new Error('fullscreen exit button not rendered')
    act(() => exitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))

    expect(document.body.querySelector('[data-testid="browser-fullscreen-exit"]')).toBeNull()
  })
})
