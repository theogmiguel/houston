// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'

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

import { OrchestratorBadge, SessionPane } from './SessionPane'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
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

function mountPane(liveChildren: number): HTMLElement {
  const info = {
    id: 1,
    agent: 'claude',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: 'orchestrator-pane',
    hidden: false,
    spawned_by: null,
    acp: null,
    live_children: liveChildren,
    children_waiting: 0
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
        onHeaderPointerDown={noop}
        onHandoff={noop}
        onOpenFile={noop}
        onOpenDir={noop}
      />
    )
  })
  return container!
}

describe('SessionPane orchestrator badge (v63)', () => {
  it('renders nothing at zero — live state, not a sticky badge', () => {
    const el = mountPane(0)
    expect(el.querySelector('[data-testid="orchestrator-badge"]')).toBeNull()
  })

  it('renders the live count once children exist', () => {
    const el = mountPane(2)
    const badge = el.querySelector('[data-testid="orchestrator-badge"]')
    expect(badge).not.toBeNull()
    expect(badge!.closest('[data-testid="head-identity"]')).not.toBeNull()
    expect(badge!.textContent).toBe('#1 · 2')
    expect(badge!.querySelector('svg')).not.toBeNull()
  })

  it('disappears again once the count drops back to zero — the same pane, re-rendered', () => {
    root = createRoot(container!)
    const renderWith = (liveChildren: number): void => {
      const info = {
        id: 1,
        agent: 'claude',
        project_dir: '/tmp/project',
        cwd: '/tmp/project',
        state: 'running',
        title: 'orchestrator-pane',
        hidden: false,
        spawned_by: null,
        acp: null,
        live_children: liveChildren
      } as SessionInfo
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
            onHeaderPointerDown={noop}
            onHandoff={noop}
            onOpenFile={noop}
            onOpenDir={noop}
          />
        )
      })
    }
    renderWith(1)
    expect(container!.querySelector('[data-testid="orchestrator-badge"]')).not.toBeNull()
    renderWith(0)
    expect(container!.querySelector('[data-testid="orchestrator-badge"]')).toBeNull()
  })

  it('keeps the full sentence as its accessible name, so nothing regresses for a screen reader', () => {
    root = createRoot(container!)
    act(() => {
      root!.render(
        <OrchestratorBadge
          info={{ id: 1, live_children: 3, children_waiting: 0 } as SessionInfo}
        />
      )
    })
    const badge = container!.querySelector('[data-testid="orchestrator-badge"]')
    expect(badge!.getAttribute('aria-label')).toBe('#1 · orchestrating 3 live child panes')
    expect(badge!.textContent).toBe('#1 · 3')
  })

  it('turns the count into a fraction, in warn ink, only while a child is waiting', () => {
    root = createRoot(container!)
    act(() => {
      root!.render(
        <OrchestratorBadge
          info={{ id: 1, live_children: 3, children_waiting: 1 } as SessionInfo}
        />
      )
    })
    const badge = container!.querySelector('[data-testid="orchestrator-badge"]')!
    expect(badge.textContent).toBe('#1 · 1/3')
    expect(badge.innerHTML).toContain('var(--warn)')
    expect(badge.getAttribute('aria-label')).toBe(
      '#1 · orchestrating 3 live child panes; 1 waiting on you'
    )
  })

  it('puts the orchestrator codename before its live count', () => {
    root = createRoot(container!)
    act(() => {
      root!.render(
        <OrchestratorBadge
          info={{
            id: 1,
            title: 'Plan login',
            codename: 'Max',
            live_children: 2,
            children_waiting: 0
          } as SessionInfo}
        />
      )
    })
    const badge = container!.querySelector('[data-testid="orchestrator-badge"]')!
    expect(badge.textContent).toBe('Max · 2')
    expect(badge.getAttribute('aria-label')).toBe('Max · orchestrating 2 live child panes')
    expect(badge.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      'Max · orchestrating 2 live child panes'
    )
  })

  it('keeps the count visible without repeating a codename used as the title', () => {
    root = createRoot(container!)
    act(() => {
      root!.render(
        <OrchestratorBadge
          info={{
            id: 1,
            title: 'Max',
            codename: 'Max',
            live_children: 2,
            children_waiting: 1
          } as SessionInfo}
        />
      )
    })
    const badge = container!.querySelector('[data-testid="orchestrator-badge"]')!
    expect(badge.textContent).toBe('1/2')
    expect(badge.getAttribute('aria-label')).toContain('Max')
    expect(badge.getAttribute('aria-label')).toContain('1 waiting on you')
  })
})
