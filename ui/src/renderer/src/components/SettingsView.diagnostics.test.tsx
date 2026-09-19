// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { baseSettingsViewProps, hostInfoFixture } from './settingsViewTestFixtures'
import type { AgentHookState } from '../houston/generated/AgentHookState'

function openDiagnostics(): void {
  act(() => setSettingsNavForTests({ section: 'diagnostics' }))
}

function hook(overrides: Partial<AgentHookState>): AgentHookState {
  return {
    provider: 'claude',
    path: '~/.claude/settings.json',
    scope: 'workspace',
    enabled: true,
    installed: true,
    error: null,
    present: true,
    version: '1.0.0',
    trust: null,
    ...overrides
  }
}

describe('Settings › Diagnostics (settings-03/-65..-69/-61)', () => {
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

  it('settings-03: is genuinely reachable, and says it is asking before host_info answers', () => {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} hostInfo={null} />)
    })
    openDiagnostics()
    expect(container.textContent).toContain('Diagnostics')
    expect(container.textContent).toContain('Asking the daemon')
  })

  it('settings-65: Channel / State directory / Process / Port / Protocol version / Uptime, straight off host_info', () => {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} hostInfo={hostInfoFixture({})} />)
    })
    openDiagnostics()
    const daemon = container.querySelector('[data-testid="settings-diagnostics-daemon"]')
    if (!daemon) throw new Error('no Daemon readout block')
    const text = daemon.textContent ?? ''
    expect(text).toContain('dev')
    expect(text).toContain('/home/t/.houston-dev')
    expect(text).toContain('pid 4242')
    expect(text).toContain('43153')
    expect(text).toContain('70')
    expect(text).toContain('4h 12m')
  })

  it('settings-66: Live sessions / Deferred by restore budget / Orchestration depth / Mailbox files, "of N" phrasing', () => {
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          hostInfo={hostInfoFixture({
            live_sessions: 7,
            restore_deferred: 0,
            restore_budget: 8,
            orchestration_depth_in_use: 2,
            orchestration_max_depth: 4,
            mailbox_files_on_disk: 31
          })}
        />
      )
    })
    openDiagnostics()
    const sessions = container.querySelector('[data-testid="settings-diagnostics-sessions"]')
    if (!sessions) throw new Error('no Sessions readout block')
    const text = sessions.textContent ?? ''
    expect(text).toContain('7')
    expect(text).toContain('0 of 8')
    expect(text).toContain('2 of 4')
    expect(text).toContain('31')
  })

  it('settings-67: Hooks — wired count, per-CLI dot list, warn callout for the unwired one, no toggle (read-only mirror)', () => {
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          hostInfo={hostInfoFixture({})}
          agentHooks={[
            hook({ provider: 'claude' }),
            hook({ provider: 'codex' }),
            hook({ provider: 'antigravity' }),
            hook({ provider: 'opencode', enabled: false, installed: false })
          ]}
        />
      )
    })
    openDiagnostics()
    const hooks = container.querySelector('[data-testid="settings-diagnostics-hooks"]')
    if (!hooks) throw new Error('no Hooks readout block')
    const text = hooks.textContent ?? ''
    expect(text).toContain('3 of 4 detected CLIs')
    expect(text).toContain('not wired')
    expect(hooks.querySelectorAll('[role="switch"]')).toHaveLength(0)
  })

  it('settings-67: "Open Agent setup" opens the one integration editor', () => {
    const onOpenHooks = vi.fn()
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          hostInfo={hostInfoFixture({})}
          agentHooks={[hook({ provider: 'claude' })]}
          onOpenHooks={onOpenHooks}
        />
      )
    })
    openDiagnostics()
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="settings-diagnostics-open-hooks"]')
    if (!btn) throw new Error('no "Open Agent setup" button')
    act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpenHooks).toHaveBeenCalledTimes(1)
  })

  it('settings-68: "Daemon logs" names the actual channel and opens via onOpenLogsFolder', () => {
    const onOpenLogsFolder = vi.fn()
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          hostInfo={hostInfoFixture({ channel: 'dev' })}
          onOpenLogsFolder={onOpenLogsFolder}
        />
      )
    })
    openDiagnostics()
    expect(container.textContent).toContain("this channel's (dev) log folder")
    const buttons = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent === 'Open folder'
    )
    expect(buttons).toHaveLength(1)
    act(() => buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpenLogsFolder).toHaveBeenCalledTimes(1)
  })

  it('settings-69: "Copy diagnostics" writes a text summary to the clipboard, no secrets, and flashes success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          hostInfo={hostInfoFixture({ channel: 'dev', pid: 4242 })}
          agentHooks={[hook({ provider: 'claude' })]}
        />
      )
    })
    openDiagnostics()
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="settings-diagnostics-copy"]')
    if (!btn) throw new Error('no Copy diagnostics button')
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0][0] as string
    expect(copied).toContain('Channel: dev')
    expect(copied).toContain('pid 4242')
    expect(copied).not.toMatch(/secret|token|password/i)
    expect(btn.textContent).toBe('Copied')
  })

  it('settings-61: Privacy → Session database shows host_info.session_db_bytes and reveals it', () => {
    const onRevealSessionDb = vi.fn()
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          hostInfo={hostInfoFixture({ session_db_bytes: 3_984_588 })}
          onRevealSessionDb={onRevealSessionDb}
        />
      )
    })
    act(() => setSettingsNavForTests({ section: 'privacy' }))
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="settings-reveal-session-db"]')
    if (!btn) throw new Error('no Reveal button')
    expect(container.textContent).toContain('Session database')
    expect(container.textContent).toContain('3.8 MB')
    act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onRevealSessionDb).toHaveBeenCalledTimes(1)
  })

  it('settings-62: Privacy discloses telemetry is off, not just a toggle that could be either way', () => {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} />)
    })
    act(() => setSettingsNavForTests({ section: 'privacy' }))
    expect(container.textContent).toContain('Telemetry')
    expect(container.textContent).toContain('None')
    const telemetryRow = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="settings-row"]')
    ).find((r) => r.textContent?.includes('Telemetry'))
    expect(telemetryRow?.querySelector('[role="switch"]')).toBeNull()
  })

  it('Privacy discloses the transcript invariant on screen, not only in the repo docs', () => {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} />)
    })
    act(() => setSettingsNavForTests({ section: 'privacy' }))
    expect(container.textContent).toContain('Agent transcripts')
    expect(container.textContent).toContain('Never read')
  })

  it('the DEV badge is conditioned on the actual channel, not always on', () => {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} hostInfo={hostInfoFixture({ channel: 'dev' })} />)
    })
    openDiagnostics()
    expect(container.querySelector('[data-testid="settings-diagnostics-dev-badge"]')).not.toBeNull()

    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} hostInfo={hostInfoFixture({ channel: 'release' })} />)
    })
    expect(container.querySelector('[data-testid="settings-diagnostics-dev-badge"]')).toBeNull()
  })
})
