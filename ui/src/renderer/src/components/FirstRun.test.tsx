// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FirstRun, type FirstRunProps } from './FirstRun'
import type { KeymapOverrides } from '../houston/client'
import type { AgentHookState } from '../houston/generated/AgentHookState'
import { DEFAULT_PREFS, setMascotPrefsForTests } from '../mascot/mascotPrefs'

const keymapOverrides = { shortcuts_enabled: true, bindings: {} } as unknown as KeymapOverrides

function props(over: Partial<FirstRunProps> = {}): FirstRunProps {
  return {
    workspaces: {
      onAdd: () => {},
      pending: false,
      refusals: [],
      error: null,
      keymapOverrides
    },
    hasWorkspace: false,
    orchestrationConsented: false,
    stateKnown: true,
    caps: { max_live_children: 4, max_spawn_depth: 2 },
    onEnableOrchestration: () => {},
    hooksInstalled: false,
    agentHooks: [],
    onAgentHooksSet: () => {},
    onDone: () => {},
    ...over
  }
}

describe('FirstRun', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    setMascotPrefsForTests({ ...DEFAULT_PREFS, enabled: false })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    setMascotPrefsForTests({ ...DEFAULT_PREFS })
  })

  const render = (p: FirstRunProps): void => {
    act(() => root.render(<FirstRun {...p} />))
  }
  const step = (): string | null => host.querySelector('[data-testid="first-run-step"]')!.textContent
  const headline = (): string | null =>
    host.querySelector('[data-testid="empty-state-headline"], [data-testid="first-run-hooks-headline"]')!.textContent

  it('opens on the workspace screen and numbers all three', () => {
    render(props())
    expect(host.querySelector('[data-testid="workspaces-empty"]')).not.toBeNull()
    expect(step()).toBe('Step 1 of 3')
    expect(host.querySelector('[data-testid="first-run-skip"]')).toBeNull()
  })

  it('shows the mascot hero when enabled and restores the workspace actions after Skip intro', async () => {
    setMascotPrefsForTests({ ...DEFAULT_PREFS })
    await act(async () => {
      root.render(<FirstRun {...props()} />)
      await import('./ui/MascotIntro')
    })
    expect(host.querySelector('[data-testid="mascot-intro"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="workspaces-empty"]')).toBeNull()
    expect(host.querySelector('[data-testid="first-run-step"]')).toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('.mascot-skipintro')!.click())
    expect(host.querySelector('[data-testid="mascot-intro"]')).toBeNull()
    expect(host.querySelector('[data-testid="workspaces-empty"]')).not.toBeNull()
    expect(step()).toBe('Step 1 of 3')
    expect(host.querySelector('[data-testid="first-run-skip"]')).toBeNull()
  })

  it('never draws a step whose prerequisite is already met', () => {
    render(props({ hasWorkspace: true, hooksInstalled: true }))
    expect(headline()).toBe('Let agents drive agents?')
    expect(step()).toBe('Step 2 of 3')
  })

  it('states the spawn caps the switch buys', () => {
    render(props({ hasWorkspace: true }))
    const desc = host.querySelector('[data-testid="first-run-orchestration"]')!.textContent ?? ''
    expect(desc).toContain('4')
    expect(desc).toContain('2')
    expect(desc).toContain('Settings')
  })

  it('declining a step advances rather than dead-ending', () => {
    const onDone = vi.fn()
    render(props({ hasWorkspace: true, onDone }))
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="first-run-skip"]')!.click())
    expect(headline()).toBe('Hook up your agents')
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="first-run-skip"]')!.click())
    expect(onDone).toHaveBeenCalled()
  })

  it('keeps its numbering while live state satisfies the steps under it', () => {
    const p = props()
    render(p)
    expect(step()).toBe('Step 1 of 3')
    render({ ...p, hasWorkspace: true })
    expect(step()).toBe('Step 2 of 3')
    render({ ...p, hasWorkspace: true, orchestrationConsented: true })
    expect(step()).toBe('Step 3 of 3')
  })

  it('latches a satisfied screen so an unrelated broadcast cannot rewind it', () => {
    const p = props({ hasWorkspace: true })
    render(p)
    expect(headline()).toBe('Let agents drive agents?')
    render({ ...p, orchestrationConsented: true })
    expect(headline()).toBe('Hook up your agents')
    render({ ...p, orchestrationConsented: false })
    expect(headline()).toBe('Hook up your agents')
  })

  it('re-reads everything on a fresh entry — the latch does not outlive it', () => {
    const p = props({ hasWorkspace: true })
    render(p)
    render({ ...p, orchestrationConsented: true })
    expect(headline()).toBe('Hook up your agents')
    act(() => root.unmount())
    root = createRoot(host)
    render(p)
    expect(headline()).toBe('Let agents drive agents?')
  })

  it('draws the plain workspace screen until the daemon has answered', () => {
    render(props({ stateKnown: false }))
    expect(host.querySelector('[data-testid="workspaces-empty"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="first-run-step"]')).toBeNull()
  })

  it('closes when nothing is left to ask', () => {
    const onDone = vi.fn()
    render(props({ hasWorkspace: true, orchestrationConsented: true, hooksInstalled: true, onDone }))
    expect(onDone).toHaveBeenCalled()
  })

  it('installs a selected CLI through the existing hook message', () => {
    const onAgentHooksSet = vi.fn()
    const claude: AgentHookState = {
      provider: 'claude', path: '~/.claude/settings.json', scope: 'workspace', enabled: false,
      installed: true, error: null, present: true, version: '2.3.1', trust: null
    }
    const codex: AgentHookState = {
      ...claude, provider: 'codex', path: '~/.codex/hooks.json', installed: false, version: '0.98.0'
    }
    render(props({ hasWorkspace: true, orchestrationConsented: true, agentHooks: [claude, codex], onAgentHooksSet }))

    act(() => host.querySelector<HTMLButtonElement>('[data-testid="first-run-hook-codex"]')!.click())
    expect(onAgentHooksSet).toHaveBeenCalledWith('codex', true)
  })

  it('installs every silent present CLI from the primary action and gives absent CLIs no action', () => {
    const onAgentHooksSet = vi.fn()
    const base: AgentHookState = {
      provider: 'claude', path: '~/.claude/settings.json', scope: 'workspace', enabled: false,
      installed: false, error: null, present: true, version: '1.0.0', trust: null
    }
    render(props({
      hasWorkspace: true,
      orchestrationConsented: true,
      agentHooks: [
        { ...base, provider: 'claude', installed: true },
        { ...base, provider: 'codex' },
        { ...base, provider: 'opencode' },
        { ...base, provider: 'cursor', present: false },
        { ...base, provider: 'grok', present: false },
        { ...base, provider: 'antigravity', present: false }
      ],
      onAgentHooksSet
    }))

    expect(host.querySelector('[data-testid="first-run-hook-cursor"]')).toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="first-run-install-all"]')!.click())
    expect(onAgentHooksSet.mock.calls).toEqual([['codex', true], ['opencode', true]])
    expect(host.querySelector('[data-testid="first-run-install-all"]')?.textContent).toBe('Install for 2 CLIs')
  })

  it('marks a declined step as skipped in the three-step indicator', () => {
    render(props({ hasWorkspace: true }))
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="first-run-skip"]')!.click())
    expect(host.querySelector('[data-testid="first-run-steps"] [data-state="skipped"]')?.textContent).toContain('Orchestration · Skipped')
    expect(host.querySelector('[data-testid="first-run-step"]')?.textContent).toBe('Step 3 of 3')
  })

  it('shows the provider error and explains why the bulk action is disabled', () => {
    const claude: AgentHookState = {
      provider: 'claude', path: '~/.claude/settings.json', scope: 'workspace', enabled: false,
      installed: true, error: 'Unsupported settings format', present: true, version: '2.3.1', trust: null
    }
    render(props({ hasWorkspace: true, orchestrationConsented: true, agentHooks: [claude] }))

    expect(host.querySelector('[data-testid="first-run-hook-error-claude"]')?.textContent).toBe('Unsupported settings format')
    expect(host.querySelector('[data-testid="first-run-install-all"]')?.hasAttribute('disabled')).toBe(true)
    expect(host.querySelector('[data-testid="first-run-install-reason"]')?.textContent).toBe('All present CLIs are already reporting.')
  })
})
