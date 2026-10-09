// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentHookState } from '../../houston/generated/AgentHookState'
import { HooksSurface } from './HooksSurface'

function noop(): void {}

function state(overrides: Partial<AgentHookState> = {}): AgentHookState {
  return {
    provider: 'claude',
    path: '~/.claude/settings.json',
    scope: 'global',
    enabled: false,
    installed: false,
    error: null,
    present: true,
    version: '1.0.0',
    trust: null,
    ...overrides
  }
}

describe('HooksSurface — the Agents detail screen', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders something real with zero providers loaded', () => {
    act(() => {
      root.render(<HooksSurface providers={null} onSet={noop} onRefresh={noop} />)
    })
    expect(container.textContent).toContain('Asking the daemon what is installed.')
  })

  it('renders the Agent CLIs list and its selected detail', () => {
    act(() => {
      root.render(
        <HooksSurface providers={[state({ provider: 'claude' })]} onSet={noop} onRefresh={noop} />
      )
    })
    expect(container.querySelector('[data-testid="settings-section-title"]')?.textContent).toBe(
      'Agent CLIs'
    )
    expect(container.querySelector('[data-testid="list-detail"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="agent-status-row"]')?.textContent).toContain(
      'Claude Code'
    )
    const cli = container.querySelector<HTMLButtonElement>('[data-testid="list-detail-item"]')
    act(() => cli?.click())
    expect(container.querySelector('[data-testid="agent-status-detail"]')).not.toBeNull()
  })

  it('opts into the wide page column, so the shell can be two columns at all', () => {
    act(() => {
      root.render(<HooksSurface providers={[state()]} onSet={noop} onRefresh={noop} />)
    })
    const column = container.querySelector<HTMLElement>('[data-testid="nav-column"]')!
    expect(column.className).toContain('max-w-[1040px]')
  })

  it('keeps the provider-specific install and removal explanation in the detail', () => {
    act(() => {
      root.render(<HooksSurface providers={[state()]} onSet={noop} onRefresh={noop} />)
    })
    const cli = container.querySelector<HTMLButtonElement>('[data-testid="list-detail-item"]')
    act(() => cli?.click())
    expect(container.querySelector('[data-testid="nav-footnote"]')).toBeNull()
    const text = container.textContent ?? ''
    expect(text).toContain('Your own hooks are preserved')
    expect(text).toContain('turning this off removes Houston’s entries')
  })
})
