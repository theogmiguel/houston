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

import { createSessionsStore, SessionsStoreContext } from '../sessionsStore'

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
        client={{ subscribe: () => () => {}, taskSnapshot: () => {}, taskQueueRun: () => {} } as unknown as HoustonClient}
        info={info}
        roster={{ sessions: new Map(Array.from({ length: liveChildren }, (_, index) => [index + 2, { ...info, id: index + 2, spawned_by: 1 }])), maxLiveChildren: null }}
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

  it('moves the hover card to the pinned orchestrator row once children exist', () => {
    const el = mountPane(2)
    const badge = el.querySelector('[data-testid="orchestrator-badge"]')
    expect(badge).not.toBeNull()
    expect(badge!.closest('[data-testid="head-identity"]')).toBeNull()
    expect(badge!.closest('[aria-label="Children roster"]')).not.toBeNull()
    expect(badge!.textContent).toBe('Orchestrator')
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
        client={{ subscribe: () => () => {}, taskSnapshot: () => {}, taskQueueRun: () => {} } as unknown as HoustonClient}
            info={info}
            roster={{ sessions: new Map(Array.from({ length: liveChildren }, (_, index) => [index + 2, { ...info, id: index + 2, spawned_by: 1 }])), maxLiveChildren: null }}
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

it('updates an open delegation card from the live store with unchanged roster props', () => {
  const parent: SessionInfo = { id: 1, agent: 'claude', project_dir: '/tmp/project', cwd: '/tmp/project', state: 'running', title: 'parent', codename: 'parent', hidden: false, spawned_by: null, live_children: 1, children_waiting: 0, inbox_unread: 0, tags: [], resumable: false }
  const child: SessionInfo = { ...parent, id: 2, spawned_by: 1, codename: 'worker', title: 'worker', live_children: 0, delegation: { parent: 1, state: 'working', stalled: false, started_at: 1000, result_staged: false, superseded: 0, turn_end_source: 'stop-hook', inbox_owed: 0, inbox_provisional: 0, reusable: true } }
  const sessions = new Map([[1, parent], [2, child]])
  const store = createSessionsStore(sessions)
  root = createRoot(container!)
  act(() => root!.render(<SessionsStoreContext.Provider value={store}><OrchestratorBadge info={parent} roster={{ sessions, maxLiveChildren: null }} /></SessionsStoreContext.Provider>))
  const badge = container!.querySelector<HTMLButtonElement>('[data-testid="orchestrator-badge"]')!
  act(() => badge.click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('working')
  act(() => store.set((previous) => new Map(previous)
    .set(1, { ...parent, children_waiting: 1 })
    .set(2, { ...child, delegation: { ...child.delegation!, state: 'needs_input', stalled: true } })))
  expect(badge.getAttribute('aria-label')).toContain('1 waiting on you')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('needs input')
})
