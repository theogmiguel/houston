// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutSection } from './AboutSection'
import { restoreUpdate, setDismissedUpdateForTests } from '../../updateDismissal'
import { resetUpdateInstall, setUpdateInstallForTests } from '../../updateInstall'
import { closeUpdateModal, isUpdateModalOpen } from '../../updateModal'
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
  restore_resume: true,
  restore_deferred: 0,
  orchestration_depth_in_use: 0,
  orchestration_max_depth: 0,
  mailbox_files_on_disk: 0,
  mailbox_retention_hours: 0,
  settled_retention_hours: 24,
  worktree_cleanup_enabled: false,
  worktree_cleanup_grace_hours: 24,
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

beforeEach(() => {
  appUpdateMocks.install.mockReset()
  appUpdateMocks.subscribe.mockReset()
  resetUpdateInstall()
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

  it('opens the install modal on the click and starts nothing itself', () => {
    closeUpdateModal()
    renderAbout({ update: AVAILABLE })
    expect(isUpdateModalOpen()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Install update…' }))
    expect(isUpdateModalOpen()).toBe(true)
    expect(appUpdateMocks.install).not.toHaveBeenCalled()
    closeUpdateModal()
  })

  it('names the live session count before the click, and the empty set as words', () => {
    const { unmount } = renderAbout({ update: AVAILABLE, liveSessionCount: 3 })
    expect(screen.getByTestId('update-live-sessions').textContent).toBe('3 live sessions')
    unmount()
    const again = renderAbout({ update: AVAILABLE, liveSessionCount: 1 })
    expect(screen.getByTestId('update-live-sessions').textContent).toBe('1 live session')
    again.unmount()
    renderAbout({ update: AVAILABLE, liveSessionCount: 0 })
    expect(screen.getByTestId('update-live-sessions').textContent).toBe('No live sessions')
  })

  it('shows every running step as progress that reopens the modal, with no cancel anywhere', () => {
    closeUpdateModal()
    renderAbout({ update: AVAILABLE })
    act(() => setUpdateInstallForTests({ kind: 'downloading', downloaded: 42, total: 100 }))
    expect(screen.getByTestId('update-install-progress').textContent).toBe('Downloading… 42%')
    expect(screen.getByText(/Downloading the installer — 42%/)).not.toBeNull()
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
    expect(screen.queryByTestId('update-install')).toBeNull()

    act(() => setUpdateInstallForTests({ kind: 'verifying' }))
    expect(screen.getByTestId('update-install-progress').textContent).toBe('Verifying…')
    act(() => setUpdateInstallForTests({ kind: 'stopping' }))
    expect(screen.getByTestId('update-install-progress').textContent).toBe('Stopping sessions…')
    act(() => setUpdateInstallForTests({ kind: 'installing' }))
    expect(screen.getByTestId('update-install-progress').textContent).toBe('Installing…')

    fireEvent.click(screen.getByTestId('update-install-progress'))
    expect(isUpdateModalOpen()).toBe(true)
    closeUpdateModal()

    act(() => setUpdateInstallForTests({ kind: 'installed', version: '1.2.3' }))
    expect(screen.getByText('Houston 1.2.3 installed')).not.toBeNull()
    expect(screen.getByText('Houston is reopening with the new version.')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Check now' })).not.toBeNull()
  })

  it('puts a refusal on screen verbatim and reopens the modal to try again', () => {
    closeUpdateModal()
    const refusal =
      'app_update_install: refusing the downloaded update: its signature does not verify against the configured public key (bad signature). Nothing was installed'
    renderAbout({ update: AVAILABLE })
    act(() => setUpdateInstallForTests({ kind: 'failed', version: '1.2.3', error: refusal }))
    expect(screen.getByText(refusal)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(isUpdateModalOpen()).toBe(true)
    closeUpdateModal()
  })

  it('reports an up-to-date feed after the install and lets Check now start over', () => {
    const onUpdateCheckNow = vi.fn()
    renderAbout({ update: AVAILABLE, onUpdateCheckNow })
    act(() => setUpdateInstallForTests({ kind: 'up_to_date' }))
    expect(screen.getByText(/nothing was installed/)).not.toBeNull()
    expect(screen.queryByTestId('update-install')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(onUpdateCheckNow).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Install update…' })).not.toBeNull()
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
    expect(screen.getByRole('button', { name: 'Install update…' })).not.toBeNull()
  })
})
