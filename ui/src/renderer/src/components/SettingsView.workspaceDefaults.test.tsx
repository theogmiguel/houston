// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { baseSettingsViewProps, hostInfoFixture, setInputValue } from './settingsViewTestFixtures'

function openWorkspaceDefaults(): void {
  act(() => setSettingsNavForTests({ section: 'workspace-defaults' }))
}

describe('Settings › Workspaces (id `workspace-defaults`)', () => {
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

  it('settings-03: is genuinely reachable — the section renders real content, not an empty column', () => {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} />)
    })
    openWorkspaceDefaults()
    expect(container.textContent).toContain('Workspaces')
    expect(container.textContent).toContain('Restore budget')
    expect(container.textContent).toContain('Open links in')
  })

  it('D7: Grid layout and "Restore sessions on open" are gone — nothing read them', () => {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} />)
    })
    openWorkspaceDefaults()
    expect(container.textContent).not.toContain('Grid layout')
    expect(container.textContent).not.toContain('Restore sessions on open')
  })

  it('settings-55: Restore budget reads host_info.restore_budget and commits via onRestoreBudgetSet, naming its ceiling', () => {
    const committed: number[] = []
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          hostInfo={hostInfoFixture({ restore_budget: 8 })}
          onRestoreBudgetSet={(n) => committed.push(n)}
        />
      )
    })
    openWorkspaceDefaults()
    expect(container.textContent).toContain('500')
    const input = container.querySelector<HTMLInputElement>('[data-testid="settings-restore-budget"]')
    if (!input) throw new Error('no restore-budget input')
    expect(input.value).toBe('8')
    act(() => setInputValue(input, '20'))
    act(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(committed).toEqual([20])
  })

  it('settings-55: shows "Asking the daemon…" instead of a bogus number before host_info answers', () => {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} hostInfo={null} />)
    })
    openWorkspaceDefaults()
    expect(container.querySelector('[data-testid="settings-restore-budget"]')).toBeNull()
    expect(container.textContent).toContain('Asking the daemon')
  })

  it('the new-workspace orchestration default is gone from here', () => {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} />)
    })
    openWorkspaceDefaults()
    expect(container.querySelector('[data-testid="settings-ws-default-orchestration"]')).toBeNull()
  })

  it('the idle-reap policy lives here under Background sessions and round-trips through onSessionPolicy', () => {
    const sent: Array<{ idle_reap_enabled: boolean; idle_reap_minutes: number }> = []
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          sessionPolicy={{ idle_reap_enabled: false, idle_reap_minutes: 15 }}
          onSessionPolicy={(next) => sent.push(next)}
        />
      )
    })
    openWorkspaceDefaults()
    expect(container.textContent).toContain('Background sessions')
    expect(container.textContent).toContain('Close idle background sessions')
    const sw = container.querySelector<HTMLButtonElement>('[data-testid="idle-reap-switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('false')
    act(() => {
      sw.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(sent).toEqual([{ idle_reap_enabled: true, idle_reap_minutes: 15 }])
  })

  it('the idle-reap controls wait for the daemon: disabled while the policy is unknown', () => {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} sessionPolicy={null} />)
    })
    openWorkspaceDefaults()
    const sw = container.querySelector<HTMLButtonElement>('[data-testid="idle-reap-switch"]')!
    expect(sw.disabled).toBe(true)
  })

  it('the live "Open links in a browser pane" toggle sits here, under "This workspace"', () => {
    const sent: boolean[] = []
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          historyWorkspace="/proj"
          historyWorkspaceName="proj"
          openLinksInPane={false}
          onOpenLinksInPane={(v) => sent.push(v)}
        />
      )
    })
    openWorkspaceDefaults()
    expect(container.textContent).toContain('Open links in a browser pane')
    expect(container.textContent).toContain('This workspace')
    const toggles = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="switch"]'))
    const live = toggles[toggles.length - 1]
    expect(live.getAttribute('aria-checked')).toBe('false')
    act(() => {
      live.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(sent).toEqual([true])
  })

  it('D7: the new-workspace "Open links in" default is gone — nothing read it', () => {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} />)
    })
    openWorkspaceDefaults()
    expect(
      container.querySelector('[aria-label="Default link target for new workspaces"]')
    ).toBeNull()
  })
})
