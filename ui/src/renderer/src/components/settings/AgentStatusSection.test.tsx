// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentHookState } from '../../houston/generated/AgentHookState'
import type { AgentKind } from '../../houston/generated/AgentKind'
import { AgentStatusSection, HOOK_COPY } from './AgentStatusSection'

function noop(): void {}

function state(overrides: Partial<AgentHookState> = {}): AgentHookState {
  return {
    provider: 'claude',
    path: '~/.claude/settings.json',
    scope: 'workspace',
    enabled: false,
    installed: false,
    error: null,
    present: true,
    version: '1.0.0',
    trust: null,
    ...overrides
  }
}

describe('AgentStatusSection', () => {
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

  function render(props: Partial<React.ComponentProps<typeof AgentStatusSection>>): void {
    act(() => {
      root.render(
        <AgentStatusSection providers={[]} onSet={noop} onRefresh={noop} {...props} />
      )
    })
  }

  function rows(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('[data-testid="agent-status-row"]')]
  }

  function rowFor(provider: AgentKind): HTMLElement {
    return rows().find((r) => r.getAttribute('data-provider') === provider)!
  }

  function select(provider: AgentKind): void {
    const button = rowFor(provider).closest('[data-testid="list-detail-item"]')!
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }

  it('teaches the next action while loading, with no rows and no fabricated status', () => {
    render({ providers: null })
    expect(container.querySelector('[data-testid="agent-status-loading"]')?.textContent).toContain(
      'Checking agent status'
    )
    expect(rows()).toHaveLength(0)
    const check = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-status-check-again"]'
    )!
    expect(check.disabled).toBe(true)
  })

  it('teaches the next action when the daemon reports nothing hookable', () => {
    render({ providers: [] })
    expect(container.querySelector('[data-testid="agent-status-empty"]')?.textContent).toContain(
      'no CLI it can wire'
    )
    const check = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-status-check-again"]'
    )!
    expect(check.disabled).toBe(false)
  })

  it('lists every provider by name, with its version and a one-line state', () => {
    render({
      providers: [
        state({ provider: 'claude', enabled: true, installed: true, version: '2.1.263' }),
        state({ provider: 'codex', scope: 'global', version: '0.153.4' }),
        state({ provider: 'grok', scope: 'global', present: false, version: null })
      ]
    })
    expect(rows()).toHaveLength(3)

    const claude = rowFor('claude')
    expect(claude.textContent).toContain('Claude Code')
    expect(claude.textContent).toContain('2.1.263')
    expect(claude.getAttribute('data-status')).toBe('ok')

    const codex = rowFor('codex')
    expect(codex.getAttribute('data-status')).toBe('off')

    const grok = rowFor('grok')
    expect(grok.getAttribute('data-status')).toBe('absent')
    expect(grok.textContent).toContain('Grok')
    expect(grok.className).toContain('text-[var(--text-secondary)]')
  })

  it("says each row's state in words, not only through the mark", () => {
    render({
      providers: [
        state({ provider: 'claude', enabled: true, installed: true }),
        state({ provider: 'codex', scope: 'global' }),
        state({ provider: 'cursor', scope: 'global', present: false, version: null }),
        state({ provider: 'grok', scope: 'global', enabled: true, installed: false })
      ]
    })
    const sub = (provider: AgentKind): string =>
      rowFor(provider).parentElement!.parentElement!.textContent ?? ''
    expect(sub('claude')).toContain('Installed · hooks on')
    expect(sub('codex')).toContain('Installed · hooks off')
    expect(sub('cursor')).toContain('Not found on PATH')
    expect(sub('grok')).toContain('Installed · hooks need attention')
  })

  it('carries a StatusIcon per row, matching the row state', () => {
    render({ providers: [state({ provider: 'cursor', present: false, version: null })] })
    const mark = container.querySelector('[data-testid="status-icon"]')!
    expect(mark.getAttribute('data-state')).toBe('absent')
  })

  it('flips a provider straight from its list row, naming that provider', () => {
    const flips: [AgentKind, boolean][] = []
    render({
      providers: [state({ provider: 'codex', scope: 'global' })],
      onSet: (p, on) => flips.push([p, on])
    })
    const sw = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-status-row-switch"]'
    )!
    expect(sw.getAttribute('role')).toBe('switch')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    act(() => sw.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(flips).toEqual([['codex', true]])
  })

  it('refuses the switch for a CLI that is not on the machine, rather than hiding it', () => {
    render({ providers: [state({ provider: 'grok', present: false, version: null })] })
    const sw = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-status-row-switch"]'
    )!
    expect(sw.disabled).toBe(true)
  })

  it('shows nothing but a prompt until a provider is picked', () => {
    render({ providers: [state()] })
    expect(container.querySelector('[data-testid="agent-status-detail"]')).toBeNull()
    expect(container.querySelector('[data-testid="list-detail-detail"]')?.textContent).toContain(
      'Nothing selected'
    )
  })

  it('opens a detail with the consent copy in full, the config path, and both groups', () => {
    render({ providers: [state({ provider: 'grok', scope: 'global', path: '~/.grok/hooks/h.json' })] })
    select('grok')
    const detail = container.querySelector<HTMLElement>('[data-testid="agent-status-detail"]')!
    expect(detail.textContent).toContain(HOOK_COPY.grok.writes)
    expect(detail.textContent).toContain('This machine')
    expect(detail.textContent).toContain('~/.grok/hooks/h.json')
    const headings = [...detail.querySelectorAll('[data-testid="settings-subhead"]')].map(
      (h) => h.textContent
    )
    expect(headings).toEqual(['Hooks', 'On this machine'])
  })

  it('answers Binary and Version from the wire, never from a guess', () => {
    render({
      providers: [
        state({ provider: 'codex', scope: 'global', present: true, version: '0.153.4' }),
        state({ provider: 'cursor', scope: 'global', present: false, version: null })
      ]
    })
    select('codex')
    let detail = container.querySelector<HTMLElement>('[data-testid="agent-status-detail"]')!
    expect(detail.textContent).toContain('Found on PATH')
    expect(detail.textContent).toContain('0.153.4')

    select('cursor')
    detail = container.querySelector<HTMLElement>('[data-testid="agent-status-detail"]')!
    expect(detail.textContent).toContain('Not found')
    expect(detail.textContent).toContain('Unknown')
  })

  it('says so in the detail when a provider is consented-to but not installed', () => {
    render({ providers: [state({ enabled: true, installed: false })] })
    select('claude')
    expect(
      container.querySelector('[data-testid="agent-status-mismatch"]')?.textContent
    ).toContain('nothing is installed right now')
  })

  it('surfaces a write failure in the detail, with the daemon’s own words', () => {
    render({ providers: [state({ enabled: true, installed: true, error: 'permission denied: /tmp/x' })] })
    select('claude')
    const detail = container.querySelector<HTMLElement>('[data-testid="agent-status-detail"]')!
    expect(detail.getAttribute('data-status')).toBe('differs')
    expect(container.querySelector('[data-testid="agent-status-error"]')?.textContent).toContain(
      'permission denied: /tmp/x'
    )
  })

  it('names Codex’s unconfirmed hook trust in the detail, and only for Codex', () => {
    render({
      providers: [
        state({
          provider: 'codex',
          scope: 'global',
          enabled: true,
          installed: true,
          trust: 'not_confirmed'
        }),
        state({ provider: 'claude', enabled: true, installed: true })
      ]
    })
    select('codex')
    expect(
      container.querySelector('[data-testid="agent-status-codex-trust"]')?.textContent
    ).toContain('Hooks installed, not confirmed')
    expect(container.querySelector('[data-testid="agent-status-codex-trust"]')?.textContent).toContain(
      'open any Codex pane'
    )

    select('claude')
    expect(container.querySelector('[data-testid="agent-status-codex-trust"]')).toBeNull()
  })

  it('holds the switch pending until the next providers update confirms or refuses it', () => {
    const calls: [AgentKind, boolean][] = []
    render({
      providers: [state({ provider: 'grok', scope: 'global' })],
      onSet: (p, on) => calls.push([p, on])
    })
    const sw = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>('[data-testid="agent-status-row-switch"]')!
    act(() => sw().dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(calls).toEqual([['grok', true]])
    expect(sw().disabled).toBe(true)

    render({
      providers: [state({ provider: 'grok', scope: 'global', enabled: true, installed: true })],
      onSet: (p, on) => calls.push([p, on])
    })
    expect(sw().disabled).toBe(false)
    expect(rowFor('grok').getAttribute('data-status')).toBe('ok')
  })

  it('clears a pending flip when the retry fails, without claiming success', () => {
    render({ providers: [state({ provider: 'cursor', scope: 'global', enabled: true, installed: false })] })
    const sw = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>('[data-testid="agent-status-row-switch"]')!
    act(() => sw().dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(sw().disabled).toBe(true)

    render({
      providers: [
        state({
          provider: 'cursor',
          scope: 'global',
          enabled: true,
          installed: false,
          error: 'refused: not ours'
        })
      ]
    })
    expect(sw().disabled).toBe(false)
    expect(rowFor('cursor').getAttribute('data-status')).toBe('differs')
  })

  it('wires Check again to onRefresh and disables it until the next providers update lands', () => {
    let refreshed = 0
    render({ providers: [state()], onRefresh: () => refreshed++ })
    const check = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>('[data-testid="agent-status-check-again"]')!
    act(() => check().dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(refreshed).toBe(1)
    expect(check().disabled).toBe(true)

    render({ providers: [state()], onRefresh: () => refreshed++ })
    expect(check().disabled).toBe(false)
  })
})
