// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentKind } from '../houston/client'
import { PaneHandoff, handoffTargets, type HandoffSource } from './PaneHandoff'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SOURCE: HandoffSource = {
  session: 7,
  agent: 'claude',
  title: 'atlas',
  cwd: '/home/tester/project',
  conversation: '$ cargo test\nall green\n'
}

describe('handoffTargets', () => {
  it('offers every spawnable engine but the one already running the thread', () => {
    expect(handoffTargets('claude')).toEqual(['codex', 'cursor', 'antigravity', 'opencode', 'grok'])
  })

  it('never offers a shell — a shell takes no opening prompt', () => {
    expect(handoffTargets('shell')).not.toContain('shell')
  })
})

describe('PaneHandoff', () => {
  let container: HTMLDivElement
  let root: Root
  let onHandoff: ReturnType<typeof vi.fn>
  let onCancel: ReturnType<typeof vi.fn>

  function render(source: HandoffSource = SOURCE): void {
    act(() => {
      root.render(
        <PaneHandoff
          source={source}
          onCancel={onCancel as unknown as () => void}
          onHandoff={onHandoff as unknown as (agent: AgentKind, packet: string) => void}
        />
      )
    })
  }

  function tile(agent: string): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(`button[data-agent="${agent}"]`)
    if (!el) throw new Error(`no ${agent} tile`)
    return el
  }

  function click(el: HTMLElement): void {
    act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  }

  function byTestId(id: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  }

  beforeEach(() => {
    onHandoff = vi.fn()
    onCancel = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('names the pane it is handing off and where that pane is', () => {
    render()
    const head = container.querySelector('#pane-handoff-title')!
    expect(head.textContent).toContain('Handoff')
    expect(head.textContent).toContain('Claude Code')
    expect(head.textContent).toContain('~/project')
  })

  it('previews nothing until an engine is picked, and cannot be confirmed', () => {
    render()
    expect(byTestId('handoff-preview-empty')?.textContent).toContain(
      'Pick an engine to preview the packet.'
    )
    expect((byTestId('handoff-confirm') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the whole packet — thread included — once an engine is picked', () => {
    render()
    click(tile('codex'))
    const preview = byTestId('handoff-preview')!
    expect(preview.textContent).toContain(
      'You are picking up a conversation from Claude Code ("atlas").'
    )
    expect(preview.textContent).toContain('Continue from here.')
    expect(preview.textContent).toContain('# Prior conversation')
    expect(preview.textContent).toContain('all green')
    expect(byTestId('handoff-check-codex')).not.toBeNull()
  })

  it('rewrites the preview as the ask is edited', () => {
    render()
    click(tile('codex'))
    const ask = byTestId('handoff-ask') as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )!.set!
      setter.call(ask, 'Land the release.')
      ask.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(byTestId('handoff-preview')!.textContent).toContain('Land the release.')
  })

  it('hands up the chosen engine and the previewed packet, byte for byte', () => {
    render()
    click(tile('antigravity'))
    const previewed = byTestId('handoff-preview')!.textContent
    click(byTestId('handoff-confirm')!)
    expect(onHandoff).toHaveBeenCalledTimes(1)
    expect(onHandoff.mock.calls[0][0]).toBe('antigravity')
    expect(onHandoff.mock.calls[0][1]).toBe(previewed)
  })

  it('cancels on Escape without handing anything off', () => {
    render()
    click(tile('codex'))
    act(() => {
      container
        .querySelector('[data-testid="pane-handoff"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalled()
    expect(onHandoff).not.toHaveBeenCalled()
  })
})
