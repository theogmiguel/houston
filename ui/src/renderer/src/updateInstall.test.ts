// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const appUpdateMocks = vi.hoisted(() => ({
  install: vi.fn(),
  subscribe: vi.fn()
}))

vi.mock('./houston/appUpdate', () => ({
  appUpdateInstall: appUpdateMocks.install,
  onAppUpdateProgress: appUpdateMocks.subscribe
}))

import {
  resetUpdateInstall,
  startUpdateInstall,
  useUpdateInstall,
  type UpdateInstallState
} from './updateInstall'
import type { AppUpdateProgress } from './houston/appUpdate'

let emitProgress: ((progress: AppUpdateProgress) => void) | null = null
let unsubscribed = 0

function observed(): { result: { current: UpdateInstallState } } {
  return renderHook(() => useUpdateInstall())
}

beforeEach(() => {
  appUpdateMocks.install.mockReset()
  appUpdateMocks.subscribe.mockReset()
  emitProgress = null
  unsubscribed = 0
  resetUpdateInstall()
  appUpdateMocks.subscribe.mockImplementation(
    async (handler: (progress: AppUpdateProgress) => void) => {
      emitProgress = handler
      return () => {
        unsubscribed += 1
      }
    }
  )
})

describe('startUpdateInstall', () => {
  it('starts in downloading, relays progress, and lands on installed', async () => {
    let resolveInstall!: (outcome: unknown) => void
    appUpdateMocks.install.mockReturnValue(
      new Promise((r) => {
        resolveInstall = r
      })
    )
    const { result } = observed()
    expect(result.current).toEqual({ kind: 'idle' })

    let flight: Promise<void> = Promise.resolve()
    act(() => {
      flight = startUpdateInstall('1.2.3')
    })
    expect(result.current).toEqual({ kind: 'downloading', downloaded: 0, total: null })

    act(() => emitProgress!({ phase: 'downloading', downloaded: 5, total: 10 }))
    expect(result.current).toEqual({ kind: 'downloading', downloaded: 5, total: 10 })

    act(() => emitProgress!({ phase: 'installing', downloaded: 10, total: null }))
    expect(result.current).toEqual({ kind: 'installing' })

    await act(async () => {
      resolveInstall({ kind: 'installed', version: '1.2.3' })
      await flight
    })
    expect(result.current).toEqual({ kind: 'installed', version: '1.2.3' })
    expect(appUpdateMocks.install).toHaveBeenCalledWith('1.2.3')
    expect(unsubscribed).toBe(1)
  })

  it('surfaces a backend refusal verbatim and stops the flight', async () => {
    const refusal =
      'app_update_install: refusing in a development build; only an installed bundle can be ' +
      'replaced. Update the packaged app instead'
    appUpdateMocks.install.mockRejectedValue(refusal)
    const { result } = observed()
    await act(async () => {
      await startUpdateInstall('1.2.3')
    })
    expect(result.current).toEqual({ kind: 'failed', version: '1.2.3', error: refusal })
  })

  it('reports up_to_date without inventing a version', async () => {
    appUpdateMocks.install.mockResolvedValue({ kind: 'up_to_date', version: '0.10.0' })
    const { result } = observed()
    await act(async () => {
      await startUpdateInstall('1.2.3')
    })
    expect(result.current).toEqual({ kind: 'up_to_date' })
  })

  it('ignores a second start while the first is in flight', async () => {
    appUpdateMocks.install.mockReturnValue(new Promise(() => {}))
    const { result } = observed()
    await act(async () => {
      void startUpdateInstall('1.2.3')
      await Promise.resolve()
    })
    await act(async () => {
      await startUpdateInstall('1.2.3')
    })
    expect(appUpdateMocks.install).toHaveBeenCalledTimes(1)
    expect(result.current.kind).toBe('downloading')
  })

  it('retries after a refusal through a fresh flight', async () => {
    appUpdateMocks.install.mockRejectedValueOnce('app_update_install: refused').mockResolvedValue({
      kind: 'installed',
      version: '1.2.3'
    })
    const { result } = observed()
    await act(async () => {
      await startUpdateInstall('1.2.3')
    })
    expect(result.current.kind).toBe('failed')
    await act(async () => {
      await startUpdateInstall('1.2.3')
    })
    expect(result.current).toEqual({ kind: 'installed', version: '1.2.3' })
  })

  it('reset returns to idle and unsubscribes a live flight', async () => {
    appUpdateMocks.install.mockReturnValue(new Promise(() => {}))
    const { result } = observed()
    await act(async () => {
      void startUpdateInstall('1.2.3')
      await Promise.resolve()
    })
    act(() => resetUpdateInstall())
    expect(result.current).toEqual({ kind: 'idle' })
    expect(unsubscribed).toBe(1)
    // A late progress event must not resurrect the aborted state.
    act(() => emitProgress?.({ phase: 'downloading', downloaded: 1, total: 2 }))
    expect(result.current).toEqual({ kind: 'idle' })
  })
})
