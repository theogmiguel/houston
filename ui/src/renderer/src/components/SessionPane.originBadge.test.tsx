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

function mountPane(spawnedBy: number | null, acp: string | null = null): HTMLElement {
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

describe('SessionPane origin badge (v62 D3)', () => {
  it('renders iff spawned_by is set, inside the header identity group', () => {
    const el = mountPane(42)
    const badge = el.querySelector('[data-testid="origin-badge"]')
    expect(badge).not.toBeNull()
    expect(badge!.closest('[data-testid="head-identity"]')).not.toBeNull()
    expect(badge!.textContent).toBe('#42')
    expect(badge!.querySelector('svg')).not.toBeNull()
  })

  it('is a real button, so the header drag cannot swallow the click', () => {
    const el = mountPane(42)
    const badge = el.querySelector('[data-testid="origin-badge"]') as HTMLElement
    expect(badge.tagName).toBe('BUTTON')
  })

  it('renders nothing for an operator-spawned pane', () => {
    const el = mountPane(null)
    expect(el.querySelector('[data-testid="origin-badge"]')).toBeNull()
  })

  it('keeps the full sentence as its accessible name, so nothing regresses for a screen reader', () => {
    root = createRoot(container!)
    act(() => {
      root!.render(<OriginBadge info={{ id: 7, spawned_by: 42 } as SessionInfo} />)
    })
    const badge = container!.querySelector('[data-testid="origin-badge"]')
    expect(badge).not.toBeNull()
    expect(badge!.getAttribute('aria-label')).toBe('child of #42 · pane 42')
  })

  it('names the parent by codename with the roster, and carries the id in the tooltip', () => {
    root = createRoot(container!)
    const roster = {
      sessions: new Map([
        [42, { id: 42, title: 'Fix the flaky late attach flood today', codename: 'oak' } as SessionInfo]
      ]),
      maxLiveChildren: null
    }
    act(() => {
      root!.render(
        <OriginBadge info={{ id: 7, spawned_by: 42 } as SessionInfo} roster={roster} />
      )
    })
    const badge = container!.querySelector('[data-testid="origin-badge"]')
    expect(badge!.textContent).toBe('oak')
    expect(badge!.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      'child of oak · pane 42'
    )
    expect(badge!.getAttribute('aria-label')).toBe('child of oak · pane 42')
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

  it('shows both badges on an agent-spawned ACP pane — they answer different questions', () => {
    const el = mountPane(42, 'acp-grok')
    expect(el.querySelector('[data-testid="origin-badge"]')).not.toBeNull()
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
