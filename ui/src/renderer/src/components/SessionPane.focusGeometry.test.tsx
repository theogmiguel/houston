// @vitest-environment jsdom
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { SessionPane } from './SessionPane'
import { flushGhosttyAttach, ghosttyMock, ghosttySurfaceMockModule } from '../test/ghosttySurfaceMock'
import { setWindowFocusedForTests } from '../windowFocus'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => 400
})
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => 300
})

;(window as unknown as { houston: Partial<Window['houston']> }).houston = {
  listShells: vi.fn().mockResolvedValue([]),
  pathKind: vi.fn().mockResolvedValue(null),
  openPath: vi.fn().mockResolvedValue({ ok: true })
}

function makeSession(agent: SessionInfo['agent'] = 'claude'): SessionInfo {
  return {
    id: 1,
    agent,
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: 'session-1',
    hidden: false
  } as SessionInfo
}

function renderPane(active: boolean, agent: SessionInfo['agent'] = 'claude'): {
  container: HTMLDivElement
  root: Root
  pane: HTMLElement
  header: HTMLElement
} {
  const fakeClient = {
    subscribe: () => () => {},
      resizeSession: vi.fn(),
    attachSession: vi.fn(),
    sessionVisibility: vi.fn(),
    sendStdin: vi.fn(),
    respawnSession: vi.fn(),
    closeSession: vi.fn(),
    sessionCwd: vi.fn().mockResolvedValue('/tmp/project')
  } as unknown as HoustonClient
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <SessionPane
        client={fakeClient}
        info={makeSession(agent)}
        theme="black"
        active={active}
        connected={true}
        fontSize={13}
        copyOnSelect={false}
        stripBoxGlyphs={false}
        showProject={false}
        registerOutput={() => () => {}}
        shellIntegration={false}
        onReconnectSsh={() => {}}
        onActivate={() => {}}
        onExpand={() => {}}
        onZoom={() => {}}
        onShellZoom={() => {}}
        onSplit={() => {}}
        onHeaderPointerDown={() => {}}
        onHandoff={() => {}}
        onOpenFile={() => {}}
        onOpenDir={() => {}}
      />
    )
  })
  const pane = container.querySelector('.pane')
  const header = container.querySelector('.pane-head')
  if (!(pane instanceof HTMLElement) || !(header instanceof HTMLElement)) {
    throw new Error('SessionPane did not render its .pane/.pane-head')
  }
  return { container, root, pane, header }
}

describe('pane focus geometry (charter §05b)', () => {
  let harness: { container: HTMLDivElement; root: Root } | null = null

  beforeEach(() => {
    ghosttyMock.reset()
    setWindowFocusedForTests(true)
  })

  afterEach(async () => {
    if (harness) {
      await act(async () => {
        await flushGhosttyAttach()
      })
      act(() => harness!.root.unmount())
      harness.container.remove()
      harness = null
    }
  })

  it('an unfocused pane carries the plain --border, never .focus, and no accent ring', () => {
    const { container, root, pane } = renderPane(false)
    harness = { container, root }
    expect(pane.classList.contains('focus')).toBe(false)
    expect(pane.dataset.paneFocusBorder).toBe('none')
    expect(pane.className).not.toContain('--accent')
    expect(pane.className).not.toContain('after:shadow')
    const css = readFileSync(join(__dirname, '../components/ui/paneFocus.css'), 'utf8')
    expect(css).toContain("[data-pane-focus-border='none'] { border-color: var(--border); }")
    expect(css).toContain('border-width: var(--pane-frame-border-width);')
  })

  it('a focused pane in a focused window gets the full --border-focus ring and header lift, still 1px', () => {
    const { container, root, pane, header } = renderPane(true)
    harness = { container, root }
    expect(pane.classList.contains('focus')).toBe(true)
    expect(pane.dataset.paneFocusBorder).toBe('full')
    expect(pane.className).not.toMatch(/border-2\b/)
    expect(header.dataset.paneFocusHead).toBe('full')
    expect(header.className).not.toContain('--accent')
    const css = readFileSync(join(__dirname, '../components/ui/paneFocus.css'), 'utf8')
    expect(css).toContain("[data-pane-focus-border='full'] { border-color: var(--border-focus); }")
    expect(css).toContain("[data-pane-focus-head='full'] { background: var(--raised); }")
  })

  it('a focused pane in a BLURRED window dims the ring rather than dropping it', async () => {
    const { container, root, pane, header } = renderPane(true)
    harness = { container, root }
    await act(async () => {
      setWindowFocusedForTests(false)
    })
    expect(pane.classList.contains('focus')).toBe(true)
    expect(pane.dataset.paneFocusBorder).toBe('dim')
    expect(header.dataset.paneFocusHead).toBe('dim')
  })

  it('the pane name is primary ink, and steps down only while a SIBLING pane holds focus', () => {
    const { container, root } = renderPane(true)
    harness = { container, root }
    const title = container.querySelector('.pane-title')
    if (!(title instanceof HTMLElement)) throw new Error('SessionPane rendered no .pane-title')
    expect(title.dataset.paneFocusHead).toBeUndefined()
    expect(title.className).toContain('text-[var(--text-primary)]')
    const css = readFileSync(join(__dirname, '../components/ui/paneFocus.css'), 'utf8')
    expect(css).toContain('body:has(.pane.focus) .pane:not(.focus) .pane-title { color: var(--text-secondary); }')
  })

  it('every pane kind with a focus tier takes its name ink from the one shared rule', () => {
    const css = readFileSync(join(__dirname, '../components/ui/paneFocus.css'), 'utf8')
    expect(css.match(/\.pane-title \{ color: var\(--text-secondary\); \}/g)).toHaveLength(1)
  })

  it('the pane body (terminal canvas) never re-tints on focus', () => {
    const { container: c1, root: r1, pane: unfocused } = renderPane(false)
    const { container: c2, root: r2, pane: focused } = renderPane(true)
    const bg = (el: HTMLElement): string | undefined =>
      el.className.match(/bg-\[var\(--terminal-frame-bg\)\]/)?.[0]
    expect(bg(unfocused)).toBe('bg-[var(--terminal-frame-bg)]')
    expect(bg(focused)).toBe('bg-[var(--terminal-frame-bg)]')
    act(() => r1.unmount())
    act(() => r2.unmount())
    c1.remove()
    c2.remove()
  })

  it('renders the engine glyph tinted with the agent brand token, shed at 360px', () => {
    const { container, root } = renderPane(true, 'claude')
    harness = { container, root }
    const glyph = container.querySelector('[data-testid="engine-glyph"]')
    if (!(glyph instanceof HTMLElement)) throw new Error('no engine-glyph rendered')
    expect(glyph.style.color).toBe('var(--claude)')
    expect(glyph.className).toContain('[@container_(max-width:360px)]:hidden')
  })

  it('tints every spawnable provider, monochrome brands included', () => {
    for (const agent of ['codex', 'antigravity', 'opencode', 'cursor', 'grok', 'zcode'] as const) {
      const { container, root } = renderPane(true, agent)
      const glyph = container.querySelector('[data-testid="engine-glyph"]')
      if (!(glyph instanceof HTMLElement)) throw new Error(`no engine-glyph for ${agent}`)
      expect(glyph.style.color, `${agent} glyph tint`).toBe(`var(--${agent})`)
      act(() => root.unmount())
      container.remove()
    }
  })

  it('only a non-provider kind gets the muted glyph', async () => {
    const { container, root } = renderPane(true, 'shell')
    harness = { container, root }
    const glyph = container.querySelector('[data-testid="engine-glyph"]')
    if (!(glyph instanceof HTMLElement)) throw new Error('no engine-glyph rendered')
    expect(glyph.style.color).toBe('var(--text-muted)')
  })
})
