// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceEmpty } from './WorkspaceEmpty'

describe('WorkspaceEmpty — state matrix', () => {
  let container: HTMLDivElement
  let root: Root
  const clicks: string[] = []

  beforeEach(() => {
    clicks.length = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root.render(
        <WorkspaceEmpty
          installedAgents={['claude', 'codex']}
          onSpawnAgent={(agent) => clicks.push(agent)}
          onTerminal={() => clicks.push('terminal')}
          onBrowser={() => clicks.push('browser')}
        />
      )
    )
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const click = (testid: string): void => {
    const b = container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)
    if (!b) throw new Error(`no ${testid}`)
    act(() => b.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }

  it('the words stand on a plate, never on the field', () => {
    const plate = container.querySelector('[data-testid="workspace-empty-plate"]')
    expect(plate?.className).toContain('bg-[var(--field-plate-bg)]')
    expect(plate?.querySelector('[data-testid="workspace-empty-headline"]')).not.toBeNull()
  })

  it('Empty — the headline names no workspace and promises no thread', () => {
    expect(container.querySelector('[data-testid="workspace-empty-headline"]')?.textContent).toBe(
      'Nothing running here yet'
    )
    expect(container.textContent).toContain(
      'Open a terminal or an installed agent inside this workspace.'
    )
    expect(container.textContent).not.toContain('thread')
  })

  it('the action row is the three doors that work', () => {
    const labels = Array.from(container.querySelectorAll('[data-testid="workspace-empty-new-session"], [data-testid="workspace-empty-terminal"], [data-testid="workspace-empty-browser"]')).map((b) => b.textContent?.trim())
    expect(labels).toEqual(['Terminal', 'Browser'])
    expect(container.textContent).toContain('＋ Add action')
  })

  it('Terminal and Browser each open ONE pane directly — no composer in between', () => {
    click('workspace-empty-terminal')
    click('workspace-empty-browser')
    expect(clicks).toEqual(['terminal', 'browser'])
  })

  it('installed agents launch directly and unavailable providers are absent', () => {
    const button = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Codex')!
    act(() => button.click())
    expect(clicks).toEqual(['codex'])
    expect(container.textContent).not.toContain('Antigravity')
    expect(container.querySelector('[data-testid="workspace-empty-new-session"]')).toBeNull()
  })

  it('Thread is gone, not merely disabled', () => {
    expect(container.querySelector('[data-testid="workspace-empty-thread"]')).toBeNull()
  })
})
