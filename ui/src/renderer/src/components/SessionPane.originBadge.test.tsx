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

import { AcpBadge, OriginBadge, SessionPane } from './SessionPane'

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

function mountPane(
  spawnedBy: number | null,
  acp: string | null = null,
  overrides: Partial<SessionInfo> = {}
): HTMLElement {
  const info = {
    id: 1,
    agent: 'claude',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: 'child-pane',
    hidden: false,
    spawned_by: spawnedBy,
    acp,
    live_children: 0,
    children_waiting: 0,
    ...overrides
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

describe('SessionPane origin badge (v62 D3)', () => {
  it('keeps child delegation badges out of the header', () => {
    const el = mountPane(42)
    expect(el.querySelector('.pane-head [data-testid="origin-badge"]')).toBeNull()
  })

  it('renders nothing for an operator-spawned pane', () => {
    const el = mountPane(null)
    expect(el.querySelector('[data-testid="origin-badge"]')).toBeNull()
  })

  it('keeps the child task title without adding a header badge', () => {
    const el = mountPane(42, null, { title: 'Adjust frontend', codename: 'Elle' })
    expect(el.querySelector('[data-testid="pane-title-mock"]')?.textContent).toBe(
      'Adjust frontend'
    )
    expect(el.querySelector('[data-testid="origin-badge"]')).toBeNull()
  })

  it('keeps the full sentence as its accessible name, so nothing regresses for a screen reader', () => {
    root = createRoot(container!)
    act(() => {
      root!.render(<OriginBadge info={{ id: 7, spawned_by: 42 } as SessionInfo} />)
    })
    const badge = container!.querySelector('[data-testid="origin-badge"]')
    expect(badge).not.toBeNull()
    expect(badge!.getAttribute('aria-label')).toBe('#7 · child of #42')
  })

  it('names the child by codename and keeps the parent link in the tooltip', () => {
    root = createRoot(container!)
    const roster = {
      sessions: new Map([
        [42, { id: 42, title: 'Fix the flaky late attach flood today', codename: 'oak' } as SessionInfo]
      ]),
      maxLiveChildren: null
    }
    act(() => {
      root!.render(
        <OriginBadge
          info={{
            id: 7,
            title: 'Adjust frontend',
            codename: 'fern',
            spawned_by: 42
          } as SessionInfo}
          roster={roster}
        />
      )
    })
    const badge = container!.querySelector('[data-testid="origin-badge"]')
    expect(badge!.textContent).toBe('fern')
    expect(badge!.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      'fern · child of oak'
    )
    expect(badge!.getAttribute('aria-label')).toBe('fern · child of oak')
    expect(badge!.getAttribute('aria-label')).not.toContain('42')
  })

  it('does not repeat a codename that is already the editable task title', () => {
    root = createRoot(container!)
    act(() => {
      root!.render(
        <OriginBadge
          info={{ id: 7, title: 'fern', codename: 'fern', spawned_by: 42 } as SessionInfo}
        />
      )
    })
    const identity = container!.querySelector('[data-testid="origin-badge"]')!
    expect(identity.textContent).toBe('')
    expect(identity.getAttribute('aria-label')).toContain('fern')
  })

  it('keeps the stable codename when the task title is renamed', () => {
    root = createRoot(container!)
    const render = (title: string): void => {
      act(() => {
        root!.render(
          <OriginBadge
            info={{ id: 7, title, codename: 'fern', spawned_by: 42 } as SessionInfo}
          />
        )
      })
    }
    render('Adjust frontend')
    expect(container!.querySelector('[data-testid="origin-badge"]')?.textContent).toBe('fern')
    render('Renamed frontend task')
    expect(container!.querySelector('[data-testid="origin-badge"]')?.textContent).toBe('fern')
  })
})

describe('SessionPane ACP badge (v62 #11)', () => {
  it('renders iff the pane runs in ACP mode, inside the header identity group', () => {
    const el = mountPane(null, 'acp-omp')
    const badge = el.querySelector('[data-testid="acp-badge"]')
    expect(badge).not.toBeNull()
    expect(badge!.closest('[data-testid="head-identity"]')).not.toBeNull()
    expect(badge!.textContent).toBe('acp')
  })

  it('renders nothing for an ordinary pane', () => {
    expect(mountPane(null).querySelector('[data-testid="acp-badge"]')).toBeNull()
  })

  it('keeps ACP identity in the header without an origin badge', () => {
    const el = mountPane(42, 'acp-grok')
    expect(el.querySelector('[data-testid="origin-badge"]')).toBeNull()
    expect(el.querySelector('[data-testid="acp-badge"]')).not.toBeNull()
  })

  it('names the slug and the status source in the tooltip and aria-label', () => {
    root = createRoot(container!)
    act(() => {
      root!.render(<AcpBadge slug="acp-grok" />)
    })
    const badge = container!.querySelector('[data-testid="acp-badge"]')
    expect(badge!.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      "ACP mode (acp-grok) — status comes from this CLI's own protocol stream, not hooks"
    )
    expect(badge!.getAttribute('aria-label')).toBe('ACP mode: acp-grok')
  })
})
