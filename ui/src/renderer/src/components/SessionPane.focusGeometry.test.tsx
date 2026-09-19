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
    expect(pane.className).toContain('border-[var(--border)]')
    expect(pane.className).not.toContain('--accent')
    expect(pane.className).not.toContain('after:shadow')
  })

  it('a focused pane in a focused window gets the full --border-focus ring and header lift, still 1px', () => {
    const { container, root, pane, header } = renderPane(true)
    harness = { container, root }
    expect(pane.classList.contains('focus')).toBe(true)
    expect(pane.className).toContain('border-[var(--border-focus)]')
    expect(pane.className).toMatch(/(^|\s)border(\s|$)/)
    expect(pane.className).not.toMatch(/border-2\b/)
    expect(header.className).toContain('bg-[var(--raised)]')
    expect(header.className).not.toContain('--accent')
  })

  it('a focused pane in a BLURRED window dims the ring rather than dropping it', async () => {
    const { container, root, pane, header } = renderPane(true)
    harness = { container, root }
    await act(async () => {
      setWindowFocusedForTests(false)
    })
    expect(pane.classList.contains('focus')).toBe(true)
    expect(pane.className).toContain('color-mix(in_srgb,var(--border-focus)_45%,var(--border))')
    expect(header.className).toContain('color-mix(in_srgb,var(--raised)_45%,var(--session-terminal-header-bg))')
  })

  it('the pane name is primary ink, and steps down only while a SIBLING pane holds focus', () => {
    const { container, root } = renderPane(true)
    harness = { container, root }
    const title = container.querySelector('.pane-title')
    if (!(title instanceof HTMLElement)) throw new Error('SessionPane rendered no .pane-title')
    expect(title.className).toContain('text-[var(--text-primary)]')
    expect(title.className).toContain(
      '[body:has(.pane.focus)_.pane:not(.focus)_&]:text-[var(--text-secondary)]'
    )
  })

  it('every pane kind with a focus tier takes its name ink from the one shared rule', () => {
    for (const file of ['RenameTitle.tsx', 'EditorLeaf.tsx', 'FilesPane.tsx']) {
      const src = readFileSync(join(__dirname, file), 'utf8')
      expect(
        src,
        `${file} must spend PANE_TITLE_INK_CLS on its title — a hand-rolled copy is how ` +
          'three of these lost the rule in the first place'
      ).toContain('PANE_TITLE_INK_CLS')
    }
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
    for (const agent of ['codex', 'antigravity', 'opencode', 'cursor', 'grok'] as const) {
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
