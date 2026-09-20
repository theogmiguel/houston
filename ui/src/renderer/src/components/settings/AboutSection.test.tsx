// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutSection } from './AboutSection'
import { restoreUpdate, setDismissedUpdateForTests } from '../../updateDismissal'
import { resetUpdateInstall, setUpdateInstallForTests } from '../../updateInstall'
import type { AppUpdateProgress } from '../../houston/appUpdate'
import type { HostInfo } from '../SettingsView'

const appUpdateMocks = vi.hoisted(() => ({ install: vi.fn(), subscribe: vi.fn() }))

vi.mock('../../houston/appUpdate', () => ({
  appUpdateInstall: appUpdateMocks.install,
  onAppUpdateProgress: appUpdateMocks.subscribe
}))

vi.mock('./ThirdPartyNotices', () => ({
  ThirdPartyNotices: () => <div data-testid="third-party-notices" />
}))

;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'

const HOST: HostInfo = {
  type: 'host_info',
  channel: 'dev',
  state_dir: '/tmp/houston',
  pid: 4242,
  port: 43153,
  protocol_version: 101,
  app_version: '0.0.0-test',
  build_commit: 'abc1234',
  uptime_ms: 0,
  live_sessions: 0,
  restore_budget: 0,
  restore_deferred: 0,
  orchestration_depth_in_use: 0,
  orchestration_max_depth: 0,
  mailbox_files_on_disk: 0,
  mailbox_retention_hours: 0,
  command_history_ignore_glob_count: 0,
  session_db_bytes: 0
}

const NOTES = '## What changed\n\n- a fix\n- a feature'

const AVAILABLE = {
  policy: { check: true },
  state: {
    kind: 'available' as const,
    release: {
      version: '1.2.3',
      notes: NOTES,
      notes_url: 'https://example.com/releases/1.2.3'
    },
    checked_at_ms: Date.now()
  }
}

function renderAbout(
  overrides: Partial<React.ComponentProps<typeof AboutSection>> = {}
): ReturnType<typeof render> {
  return render(
    <AboutSection
      onContact={() => {}}
      onOpenLicense={() => {}}
      hostInfo={null}
      update={null}
      onUpdateCheckNow={() => {}}
      onUpdatePolicySet={() => {}}
      onOpenExternal={() => {}}
      {...overrides}
    />
  )
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

// A promise the test resolves when it wants the install flight to land.
function deferInstall(): { resolve: (outcome: unknown) => void } {
  let resolve!: (outcome: unknown) => void
  appUpdateMocks.install.mockReturnValue(
    new Promise((r) => {
      resolve = r
    })
  )
  return { resolve }
}

let emitProgress: ((progress: AppUpdateProgress) => void) | null = null

beforeEach(() => {
  appUpdateMocks.install.mockReset()
  appUpdateMocks.subscribe.mockReset()
  emitProgress = null
  resetUpdateInstall()
  appUpdateMocks.subscribe.mockImplementation(
    async (handler: (progress: AppUpdateProgress) => void) => {
      emitProgress = handler
      return () => {
        emitProgress = null
      }
    }
  )
})

afterEach(() => {
  cleanup()
  restoreUpdate()
  resetUpdateInstall()
})

describe('AboutSection update rows', () => {
  it('renders the Updates row and a Check now button before the daemon answers', () => {
    const { container } = renderAbout()
    expect(container.querySelector('[data-settings-row-name="Updates"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Check now' })).not.toBeNull()
  })

  it('names the version, shows its bounded notes, and opens the release page', () => {
    const onOpenExternal = vi.fn()
    renderAbout({ update: AVAILABLE, onOpenExternal })
    expect(screen.getByText('Houston 1.2.3')).not.toBeNull()
    expect(screen.getByTestId('update-release-summary').textContent).toContain('a fix')
    fireEvent.click(screen.getByRole('button', { name: 'Release notes' }))
    expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/releases/1.2.3')
  })

  it('renders the notes as plain text, bounded, never as markup', () => {
    const hostile = ['<script>alert(1)</script>', ...Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)].join(
      '\n'
    )
    const { container } = renderAbout({
      update: {
        ...AVAILABLE,
        state: { ...AVAILABLE.state, release: { ...AVAILABLE.state.release, notes: hostile } }
      }
    })
    const summary = screen.getByTestId('update-release-summary')
    expect(container.querySelector('script')).toBeNull()
    expect(summary.textContent).toContain('<script>alert(1)</script>')
    expect(summary.textContent).toContain('…')
    expect(summary.textContent).not.toContain('line 30')
  })

  it('leaves the summary out when the release carries no notes', () => {
    renderAbout({
      update: {
        ...AVAILABLE,
        state: { ...AVAILABLE.state, release: { ...AVAILABLE.state.release, notes: '' } }
      }
    })
    expect(screen.queryByTestId('update-release-summary')).toBeNull()
    expect(screen.getByRole('button', { name: 'Release notes' })).not.toBeNull()
  })

  it('installs only on the click, handing the backend the version on screen', async () => {
    const { resolve } = deferInstall()
    renderAbout({ update: AVAILABLE })
    expect(appUpdateMocks.install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Install update' }))
    await flush()
    expect(appUpdateMocks.install).toHaveBeenCalledWith('1.2.3')
    resolve({ kind: 'installed', version: '1.2.3' })
  })

  it('walks downloading, installing and installed, with no cancel anywhere', async () => {
    const { resolve } = deferInstall()
    renderAbout({ update: AVAILABLE })
    fireEvent.click(screen.getByRole('button', { name: 'Install update' }))
    await flush()

    act(() => emitProgress!({ phase: 'downloading', downloaded: 42, total: 100 }))
    expect(screen.getByTestId('update-install-progress').textContent).toBe('Downloading… 42%')
    expect(screen.getByText(/Downloading the installer — 42%/)).not.toBeNull()
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()

    act(() => emitProgress!({ phase: 'installing', downloaded: 100, total: null }))
    expect(screen.getByTestId('update-install-progress').textContent).toBe('Installing…')
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()

    await act(async () => {
      resolve({ kind: 'installed', version: '1.2.3' })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('Houston 1.2.3 installed')).not.toBeNull()
    expect(screen.queryByTestId('update-install')).toBeNull()
    expect(screen.getByRole('button', { name: 'Check now' })).not.toBeNull()
  })

  it('never starts a second download while one is in flight', async () => {
    deferInstall()
    renderAbout({ update: AVAILABLE })
    fireEvent.click(screen.getByRole('button', { name: 'Install update' }))
    await flush()
    expect(screen.queryByRole('button', { name: 'Install update' })).toBeNull()
    expect(appUpdateMocks.install).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'development build',
      'app_update_install: refusing in a development build; only an installed bundle can be replaced. Update the packaged app instead'
    ],
    [
      'missing target',
      "app_update_install: https://example.com/latest.json publishes no updater artifact for this build: it offers [\"linux-x86_64-deb\"] and this build needs \"linux-x86_64-appimage\""
    ],
    [
      'signature',
      'app_update_install: refusing the downloaded update: its signature does not verify against the configured public key (bad signature). Nothing was installed'
    ],
    [
      'live-session handoff',
      'app_update_install: refusing to hand the daemon off: a live SSH session in pane 3 would stop; 2 panes would drop'
    ]
  ])('puts a %s refusal on screen verbatim and offers a retry', async (_label, refusal) => {
    appUpdateMocks.install.mockRejectedValueOnce(refusal)
    renderAbout({ update: AVAILABLE })
    fireEvent.click(screen.getByRole('button', { name: 'Install update' }))
    await flush()
    expect(screen.getByText(refusal)).not.toBeNull()
    appUpdateMocks.install.mockResolvedValueOnce({ kind: 'installed', version: '1.2.3' })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await flush()
    expect(appUpdateMocks.install).toHaveBeenCalledTimes(2)
  })

  it('reports an up-to-date feed after the click and lets Check now start over', async () => {
    appUpdateMocks.install.mockResolvedValue({ kind: 'up_to_date', version: '0.0.0-test' })
    const onUpdateCheckNow = vi.fn()
    renderAbout({ update: AVAILABLE, onUpdateCheckNow })
    fireEvent.click(screen.getByRole('button', { name: 'Install update' }))
    await flush()
    expect(screen.getByText(/nothing was installed/)).not.toBeNull()
    expect(screen.queryByTestId('update-install')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(onUpdateCheckNow).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Install update' })).not.toBeNull()
  })

  it('puts the daemon check error on screen verbatim when a check fails', () => {
    const message = 'network unreachable: dns lookup failed for releases.example.com'
    renderAbout({
      update: {
        policy: { check: true },
        state: { kind: 'failed', error: message, checked_at_ms: Date.now() }
      }
    })
    expect(screen.getByText(message)).not.toBeNull()
  })

  it('keeps the switch off when disabled, and Check once does not re-enable it', () => {
    const onUpdateCheckNow = vi.fn()
    const onUpdatePolicySet = vi.fn()
    renderAbout({
      update: { policy: { check: false }, state: { kind: 'disabled' } },
      onUpdateCheckNow,
      onUpdatePolicySet
    })
    expect(screen.getByTestId('update-policy-toggle').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Check once' }))
    expect(onUpdateCheckNow).toHaveBeenCalledTimes(1)
    expect(onUpdatePolicySet).not.toHaveBeenCalled()
  })

  it('turns the switch off through onUpdatePolicySet when it was on', () => {
    const onUpdatePolicySet = vi.fn()
    renderAbout({
      update: { policy: { check: true }, state: { kind: 'up_to_date', checked_at_ms: Date.now() } },
      onUpdatePolicySet
    })
    fireEvent.click(screen.getByTestId('update-policy-toggle'))
    expect(onUpdatePolicySet).toHaveBeenCalledWith({ check: false })
  })

  it('waves the offer off through Later, and offers the way back', () => {
    renderAbout({ update: AVAILABLE })
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.getByRole('button', { name: 'Show again' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show again' }))
    expect(screen.getByRole('button', { name: 'Later' })).not.toBeNull()
  })

  it('still names the release after it was waved off -- About is where the offer lives', () => {
    setDismissedUpdateForTests('1.2.3')
    renderAbout({ update: AVAILABLE })
    expect(screen.getByText('Houston 1.2.3')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Release notes' })).not.toBeNull()
  })

  it('never renders the word null when hostInfo has not arrived', () => {
    const { container } = renderAbout({ hostInfo: null })
    expect(container.textContent).not.toContain('null')
  })

  it('names the channel and build commit in the Houston row when hostInfo is present', () => {
    const { container } = renderAbout({ hostInfo: HOST })
    const houston = container.querySelector('[data-settings-row-name="Houston"]')
    expect(houston?.textContent).toContain('dev')
    expect(houston?.textContent).toContain('abc1234')
  })

  it('renders an install state only for the release it belongs to', () => {
    act(() => setUpdateInstallForTests({ kind: 'failed', version: '1.0.0', error: 'stale' }))
    renderAbout({ update: AVAILABLE })
    expect(screen.queryByText('stale')).toBeNull()
    expect(screen.getByRole('button', { name: 'Install update' })).not.toBeNull()
  })
})
