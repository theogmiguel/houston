// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { SessionContext } from '../houston/generated/SessionContext'
import {
  setContextIndicatorForTests,
  setContextIndicatorVisible
} from '../contextIndicatorPref'

vi.mock('../pane/TerminalPane', () => ({ TerminalPane: () => null }))
vi.mock('../houston/bridge', () => ({
  listShells: async () => [],
  pathKind: async () => 'none',
  pickDirectory: async () => null,
  showItemInFolder: async () => {}
}))
vi.mock('./RenameTitle', () => ({
  RenameTitle: ({ title }: { title: string }) => <span data-testid="pane-title-mock">{title}</span>
}))

import { SessionPane } from './SessionPane'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  setContextIndicatorForTests(true)
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
})

const noop = (): void => {}

function mountPane(opts: {
  agent?: SessionInfo['agent']
  detectedAgent?: SessionInfo['detected_agent']
  spawnedBy?: number | null
  acp?: string | null
  liveChildren?: number
  profileLabel?: string | null
  context?: SessionContext | null
  onAddPane?: (id: number, rect: DOMRect) => void
  onHeaderPointerDown?: (id: number, e: React.PointerEvent) => void
}): HTMLElement {
  const info = {
    id: 1,
    agent: opts.agent ?? 'claude',
    detected_agent: opts.detectedAgent ?? null,
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: 'session-1',
    hidden: false,
    spawned_by: opts.spawnedBy ?? null,
    acp: opts.acp ?? null,
    live_children: opts.liveChildren ?? 0,
    children_waiting: 0,
    profile_label: opts.profileLabel ?? null,
    context: opts.context ?? null
  } as SessionInfo
  root = createRoot(container!)
  act(() => {
    root!.render(
      <SessionPane
        client={{} as unknown as HoustonClient}
        info={info}
        theme="black"
        active
        connected
        fontSize={13}
        copyOnSelect={false}
        stripBoxGlyphs={false}
        showProject={false}
        registerOutput={() => noop}
        shellIntegration={false}
        onReconnectSsh={noop}
        onActivate={noop}
        onExpand={noop}
        onZoom={noop}
        onShellZoom={noop}
        onSplit={noop}
        onAddPane={opts.onAddPane}
        onHeaderPointerDown={opts.onHeaderPointerDown ?? noop}
        onHandoff={noop}
        onOpenFile={noop}
        onOpenDir={noop}
      />
    )
  })
  return container!
}

function assertBareText(el: Element): void {
  expect(el.className).not.toMatch(/\bborder\b/)
  expect(el.className).not.toContain('bg-[var(--card-bg)]')
  expect(el.className).not.toContain('rounded-full')
}

describe('pane header anatomy (step 13, reference shape)', () => {
  const context: SessionContext = {
    used_tokens: 150_000,
    window_tokens: 200_000,
    used_percent: 75,
    state: 'idle',
    source: 'derived',
    as_of_ms: Date.now()
  }

  it('puts the engine glyph in head-identity, beside the name — not the meta zone', () => {
    const el = mountPane({})
    const glyph = el.querySelector('[data-testid="engine-glyph"]')
    expect(glyph).not.toBeNull()
    expect(glyph!.closest('[data-testid="head-identity"]')).not.toBeNull()
    expect(glyph!.closest('.head-meta')).toBeNull()
  })

  it('the glyph is the CLI running in the pane, not the kind it was spawned as', () => {
    const el = mountPane({ agent: 'shell', detectedAgent: 'claude' })
    const glyph = el.querySelector('[data-testid="engine-glyph"]')!
    expect(glyph.getAttribute('aria-label')).toBe('claude session')
    expect(glyph.querySelector('rect'), 'the shell mark is a rect; claude is a path').toBeNull()

    const plain = mountPane({ agent: 'shell' })
    const shellGlyph = plain.querySelector('[data-testid="engine-glyph"]')!
    expect(shellGlyph.getAttribute('aria-label')).toBe('shell session')
    expect(shellGlyph.querySelector('rect')).not.toBeNull()
  })

  it('renders no branch chip at all — D4: the prop itself is gone, not just unread', () => {
    const el = mountPane({})
    expect(el.querySelector('[data-testid="branch-chip"]')).toBeNull()
    expect(el.querySelector('[data-testid="header-divider"]')).toBeNull()
  })

  it('renders the origin/ACP/orchestrator badges as bare text, no pill chrome', () => {
    const el = mountPane({ spawnedBy: 42, acp: 'acp-grok', liveChildren: 2 })
    for (const testid of ['origin-badge', 'acp-badge', 'orchestrator-badge']) {
      const badge = el.querySelector(`[data-testid="${testid}"]`)
      expect(badge, testid).not.toBeNull()
      assertBareText(badge!)
    }
  })

  it('renders the profile badge as bare text when the pane ran under a saved profile', () => {
    const el = mountPane({ profileLabel: 'personal' })
    const badge = el.querySelector('[data-testid="profile-badge"]')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toBe('personal')
    assertBareText(badge!)
  })

  it('renders no profile badge for the default account', () => {
    const el = mountPane({})
    expect(el.querySelector('[data-testid="profile-badge"]')).toBeNull()
  })

  it('keeps the context indicator in the pane action zone and obeys its preference', () => {
    const el = mountPane({ context })
    const indicator = el.querySelector('[data-testid="context-indicator"]')
    expect(indicator).not.toBeNull()
    expect(indicator!.closest('.head-actions')).not.toBeNull()

    act(() => setContextIndicatorVisible(false))
    expect(el.querySelector('[data-testid="context-indicator"]')).toBeNull()
  })

  it('does not start a pane drag from the context indicator', () => {
    const onHeaderPointerDown = vi.fn()
    const el = mountPane({ context, onHeaderPointerDown })
    const indicator = el.querySelector('[data-testid="context-indicator"]')!

    act(() => indicator.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))

    expect(onHeaderPointerDown).not.toHaveBeenCalled()
  })

  it('keeps the full sentence as the accessible name on both orchestration badges', () => {
    const el = mountPane({ spawnedBy: 42, liveChildren: 2 })
    expect(
      el.querySelector('[data-testid="origin-badge"]')!.getAttribute('aria-label')
    ).toBe('child of #42 · pane 42')
    expect(
      el.querySelector('[data-testid="orchestrator-badge"]')!.getAttribute('aria-label')
    ).toBe('Orchestrating 2 live child panes')
  })

  it('renders head-identity in its hide order, with the two container-query cuts on the ends', () => {
    const el = mountPane({ spawnedBy: 42, acp: 'acp-grok', liveChildren: 2, profileLabel: 'personal' })
    const identity = el.querySelector('[data-testid="head-identity"]')!
    const order = [
      'engine-glyph',
      'pane-title-mock',
      'origin-badge',
      'orchestrator-badge',
      'acp-badge',
      'profile-badge'
    ]
    const seen = [...identity.querySelectorAll('[data-testid]')]
      .map((n) => n.getAttribute('data-testid'))
      .filter((t) => t !== null && order.includes(t))
    expect(seen).toEqual(order)
    expect(identity.querySelector('[data-testid="engine-glyph"]')!.className).toContain(
      '[@container_(max-width:360px)]:hidden'
    )
    for (const testid of ['origin-badge', 'orchestrator-badge', 'acp-badge', 'profile-badge']) {
      expect(
        identity.querySelector(`[data-testid="${testid}"]`)!.className,
        `${testid} must survive every width`
      ).not.toContain('@container')
    }
  })

  it('offers a header "+" that opens the shared Add-pane popover, anchored on this pane', () => {
    const onAddPane = vi.fn()
    const el = mountPane({ onAddPane })
    const plus = el.querySelector('button[aria-label="New pane"]') as HTMLButtonElement
    expect(plus).not.toBeNull()
    act(() => plus.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    expect(onAddPane).toHaveBeenCalledTimes(1)
    expect(onAddPane.mock.calls[0][0]).toBe(1)
  })

  it('omits the header "+" entirely when no workspace owns the pane (onAddPane withheld)', () => {
    const el = mountPane({ onAddPane: undefined })
    expect(el.querySelector('button[aria-label="New pane"]')).toBeNull()
  })
})
