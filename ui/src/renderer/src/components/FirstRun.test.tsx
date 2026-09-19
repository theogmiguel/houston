// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FirstRun, type FirstRunProps } from './FirstRun'
import type { KeymapOverrides } from '../houston/client'

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
    onOpenHooks: () => {},
    onDone: () => {},
    ...over
  }
}

describe('FirstRun', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const render = (p: FirstRunProps): void => {
    act(() => root.render(<FirstRun {...p} />))
  }
  const step = (): string | null => host.querySelector('[data-testid="first-run-step"]')!.textContent
  const headline = (): string | null =>
    host.querySelector('[data-testid="empty-state-headline"]')!.textContent

  it('opens on the workspace screen and numbers all three', () => {
    render(props())
    expect(host.querySelector('[data-testid="workspaces-empty"]')).not.toBeNull()
    expect(step()).toBe('Step 1 of 3')
    expect(host.querySelector('[data-testid="first-run-skip"]')).toBeNull()
  })

  it('never draws a step whose prerequisite is already met', () => {
    render(props({ hasWorkspace: true, hooksInstalled: true }))
    expect(headline()).toBe('Let agents drive agents?')
    expect(step()).toBe('Step 1 of 1')
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
    expect(headline()).toBe('Hook up an agent CLI')
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
    expect(headline()).toBe('Hook up an agent CLI')
    render({ ...p, orchestrationConsented: false })
    expect(headline()).toBe('Hook up an agent CLI')
  })

  it('re-reads everything on a fresh entry — the latch does not outlive it', () => {
    const p = props({ hasWorkspace: true })
    render(p)
    render({ ...p, orchestrationConsented: true })
    expect(headline()).toBe('Hook up an agent CLI')
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
})
