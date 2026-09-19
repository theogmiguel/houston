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

import { SessionPane } from './SessionPane'

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

function mountPane(): HTMLElement {
  const info = {
    id: 1,
    agent: 'claude',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: 'a-title-long-enough-to-need-truncation-in-a-narrow-pane',
    hidden: false
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
        showProject
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

describe('pane header overflow containment', () => {
  it('groups the identity side in a shrinkable overflow-hidden container', () => {
    const el = mountPane()
    const identity = el.querySelector('[data-testid="head-identity"]')
    expect(identity, 'head-identity group must exist (the pre-fix header had none)').not.toBeNull()
    const cls = identity!.className
    expect(cls).toContain('min-w-0')
    expect(cls).toContain('overflow-hidden')
    expect(cls).toContain('[flex:0_1_auto]')
    expect(identity!.querySelector('[data-testid="pane-title-mock"]')).not.toBeNull()
  })

  it('keeps the close button outside every shrinkable/overflow container', () => {
    const el = mountPane()
    const close = el.querySelector('button[aria-label="Close"]')
    expect(close).not.toBeNull()
    expect(close!.closest('[data-testid="head-identity"]')).toBeNull()
    const actions = close!.closest('.head-actions')
    expect(actions).not.toBeNull()
    expect(actions!.className).toContain('flex-none')
    for (let n = close!.parentElement; n && n !== el; n = n.parentElement) {
      if (n.classList.contains('pane-head')) break
      expect(n.className).not.toContain('overflow-hidden')
    }
  })
})
