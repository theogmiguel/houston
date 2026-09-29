// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  install: vi.fn(),
  subscribe: vi.fn()
}))

vi.mock('../houston/manage', () => ({ daemonStatus: mocks.status }))
vi.mock('../houston/appUpdate', () => ({
  appUpdateInstall: mocks.install,
  onAppUpdateProgress: mocks.subscribe
}))

import {
  currentStepIndex,
  effectiveChoice,
  installSteps,
  sameIds,
  UpdateInstallModal
} from './UpdateInstallModal'
import { resetUpdateInstall, setUpdateInstallForTests } from '../updateInstall'
import type { SessionInfo } from '../houston/generated/SessionInfo'

const RELEASE = {
  version: '1.2.3',
  notes: '- a fix\n- a feature',
  notes_url: 'https://example.com/releases/1.2.3'
}

function session(id: number, title: string, agent = 'claude'): SessionInfo {
  return { id, title, codename: `cn-${id}`, agent } as unknown as SessionInfo
}

const SESSIONS = [session(1, 'ui-refactor'), session(2, 'api-tests', 'codex'), session(3, 'zsh', 'shell')]

function daemon(ids: number[], supported = true, reason = 'live SSH session(s) [2] block a PTY-only handoff') {
  return {
    live_sessions: { count: ids.length, ids },
    handoff: { supported, reason }
  }
}

function renderModal(props: Partial<React.ComponentProps<typeof UpdateInstallModal>> = {}) {
  const onClose = vi.fn()
  const onLater = vi.fn()
  const onOpenExternal = vi.fn()
  render(
    <UpdateInstallModal
      release={RELEASE}
      currentVersion="1.2.2"
      sessions={SESSIONS}
      onClose={onClose}
      onLater={onLater}
      onOpenExternal={onOpenExternal}
      {...props}
    />
  )
  return { onClose, onLater, onOpenExternal }
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  mocks.status.mockReset()
  mocks.install.mockReset()
  mocks.subscribe.mockReset()
  mocks.subscribe.mockResolvedValue(() => {})
  mocks.install.mockReturnValue(new Promise(() => {}))
  resetUpdateInstall()
})

afterEach(() => {
  cleanup()
  resetUpdateInstall()
})

describe('UpdateInstallModal helpers', () => {
  it('compares session id sets regardless of order', () => {
    expect(sameIds([3, 1], [1, 3])).toBe(true)
    expect(sameIds([1], [1, 2])).toBe(false)
    expect(sameIds([1, 2], [1, 3])).toBe(false)
  })

  it('forces stop when sessions are live and the handoff is unavailable', () => {
    expect(effectiveChoice('keep', 3, false)).toBe('stop')
    expect(effectiveChoice('keep', 3, true)).toBe('keep')
    expect(effectiveChoice('keep', 0, false)).toBe('keep')
  })

  it('lists a stop step only when sessions end and a move step only when they are kept', () => {
    expect(installSteps(0, 0).map((s) => s.label)).toEqual([
      'Download',
      'Verify signature',
      'Install',
      'Reopen Houston'
    ])
    expect(installSteps(3, 0).map((s) => s.label)).toContain('Stop 3 sessions')
    expect(installSteps(0, 1).map((s) => s.label)).toContain('Move 1 session to the new daemon')
  })

  it('maps install states onto step indexes', () => {
    const steps = installSteps(2, 0)
    expect(currentStepIndex({ kind: 'downloading', downloaded: 1, total: 2 }, steps)).toBe(0)
    expect(currentStepIndex({ kind: 'verifying' }, steps)).toBe(1)
    expect(currentStepIndex({ kind: 'stopping' }, steps)).toBe(2)
    expect(currentStepIndex({ kind: 'installing' }, steps)).toBe(3)
    expect(currentStepIndex({ kind: 'installed', version: '1.2.3' }, steps)).toBe(4)
  })
})

describe('UpdateInstallModal', () => {
  it('shows bullet release notes as list items, without their markdown markers', async () => {
    mocks.status.mockResolvedValue(daemon([]))
    renderModal()
    await settle()
    const items = screen.getByTestId('update-release-summary').querySelectorAll('li')
    expect(Array.from(items, (li) => li.textContent)).toEqual(['a fix', 'a feature'])
  })

  it('starts focus on Later and preselects keeping the sessions', async () => {
    mocks.status.mockResolvedValue(daemon([1, 2, 3]))
    renderModal()
    await settle()
    expect(document.activeElement).toBe(screen.getByTestId('update-modal-later'))
    const keep = screen.getByRole('radio', { name: /Keep sessions running/ })
    const stop = screen.getByRole('radio', { name: /Stop everything and update/ })
    expect(keep.getAttribute('aria-checked')).toBe('true')
    expect(stop.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('button', { name: 'Install and reopen' })).not.toBeNull()
    expect(screen.queryByTestId('update-session-list')).toBeNull()
  })

  it('keeps sessions running through the handoff path', async () => {
    mocks.status.mockResolvedValue(daemon([1, 2, 3]))
    renderModal()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Install and reopen' }))
    await settle()
    expect(mocks.install).toHaveBeenCalledWith('1.2.3', { mode: 'keep' })
  })

  it('moves the choice with the arrow keys, keeping one option in the tab order', async () => {
    mocks.status.mockResolvedValue(daemon([1, 2, 3]))
    renderModal()
    await settle()
    const keep = screen.getByRole('radio', { name: /Keep sessions running/ })
    const stop = screen.getByRole('radio', { name: /Stop everything and update/ })
    expect(keep.tabIndex).toBe(0)
    expect(stop.tabIndex).toBe(-1)
    fireEvent.keyDown(keep, { key: 'ArrowDown' })
    expect(stop.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(stop)
    expect(stop.tabIndex).toBe(0)
  })

  it('lists the sessions that end and sends exactly those ids when stopping everything', async () => {
    mocks.status.mockResolvedValue(daemon([1, 2, 3]))
    renderModal()
    await settle()
    fireEvent.click(screen.getByRole('radio', { name: /Stop everything and update/ }))
    const list = screen.getByTestId('update-session-list')
    expect(list.textContent).toContain('ui-refactor')
    expect(list.textContent).toContain('#3')
    fireEvent.click(screen.getByRole('button', { name: 'Stop 3 sessions and install' }))
    await settle()
    expect(mocks.install).toHaveBeenCalledWith('1.2.3', { mode: 'stop_all', expected: [1, 2, 3] })
  })

  it('refreshes the list with a notice instead of stopping a set the user never saw', async () => {
    mocks.status.mockResolvedValueOnce(daemon([1, 2, 3]))
    renderModal()
    await settle()
    fireEvent.click(screen.getByRole('radio', { name: /Stop everything and update/ }))
    mocks.status.mockResolvedValueOnce(daemon([1, 2, 3, 4]))
    fireEvent.click(screen.getByRole('button', { name: 'Stop 3 sessions and install' }))
    await settle()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(screen.getByText(/4 sessions now, 3 sessions before/)).not.toBeNull()
    expect(screen.getByText(/nothing was stopped/)).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Stop 4 sessions and install' })).not.toBeNull()
  })

  it('offers only the stop action, with the daemon reason, when the handoff is unavailable', async () => {
    mocks.status.mockResolvedValue(daemon([1, 2, 3], false))
    renderModal()
    await settle()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.getByText(/This update has to stop every session/)).not.toBeNull()
    expect(screen.getByTestId('update-session-list').textContent).toContain('api-tests')
    expect(screen.getByTestId('update-handoff-reason').textContent).toContain('PTY-only handoff')
    expect(screen.queryByRole('button', { name: 'Install and reopen' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop 3 sessions and install' }))
    await settle()
    expect(mocks.install).toHaveBeenCalledWith('1.2.3', { mode: 'stop_all', expected: [1, 2, 3] })
  })

  it('is a plain confirmation when no session is live', async () => {
    mocks.status.mockResolvedValue(daemon([]))
    renderModal()
    await settle()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.getByText(/No sessions are running/)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Install and reopen' }))
    await settle()
    expect(mocks.install).toHaveBeenCalledWith('1.2.3', { mode: 'keep' })
  })

  it('shows the previous failure in a stop callout and relabels the action Try again', async () => {
    mocks.status.mockResolvedValue(daemon([]))
    renderModal()
    await settle()
    act(() => setUpdateInstallForTests({ kind: 'failed', version: '1.2.3', error: 'signature did not match' }))
    expect(screen.getByTestId('update-failure').textContent).toBe('signature did not match')
    expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull()
  })

  it('walks the step list while installing, and Hide closes without dismissing', async () => {
    mocks.status.mockResolvedValue(daemon([1, 2, 3]))
    const { onClose, onLater } = renderModal()
    await settle()
    fireEvent.click(screen.getByRole('radio', { name: /Stop everything and update/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop 3 sessions and install' }))
    await settle()
    act(() => setUpdateInstallForTests({ kind: 'downloading', downloaded: 40, total: 100 }))
    const steps = screen.getByTestId('update-steps')
    expect(steps.textContent).toContain('Stop 3 sessions')
    expect(steps.textContent).toContain('40%')
    expect(steps.querySelector('[data-state="now"]')?.textContent).toContain('Download')
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
    act(() => setUpdateInstallForTests({ kind: 'stopping' }))
    expect(steps.querySelector('[data-state="now"]')?.textContent).toContain('Stop 3 sessions')
    fireEvent.click(screen.getByTestId('update-hide'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onLater).not.toHaveBeenCalled()
  })

  it('Later dismisses the offer; Escape and the scrim close without dismissing', async () => {
    mocks.status.mockResolvedValue(daemon([]))
    const { onClose, onLater } = renderModal()
    await settle()
    fireEvent.keyDown(screen.getByTestId('update-install-modal'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.mouseDown(screen.getByTestId('update-install-modal').parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(onLater).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('update-modal-later'))
    expect(onLater).toHaveBeenCalledTimes(1)
  })

  it('opens the release page from the footer', async () => {
    mocks.status.mockResolvedValue(daemon([]))
    const { onOpenExternal } = renderModal()
    await settle()
    fireEvent.click(screen.getByTestId('update-modal-notes'))
    expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/releases/1.2.3')
  })

  it('says why the choice is missing when the daemon cannot be read', async () => {
    mocks.status.mockRejectedValue(new Error('connection refused at 127.0.0.1:1'))
    renderModal()
    await settle()
    expect(screen.getByText(/connection refused at 127.0.0.1:1/)).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Install and reopen' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Check again' })).not.toBeNull()
  })
})
