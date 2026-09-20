// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, listenMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  isTauriMock: vi.fn(() => true)
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('./host', () => ({ isTauri: () => isTauriMock() }))

import {
  APP_UPDATE_PROGRESS_EVENT,
  appUpdateInstall,
  onAppUpdateProgress
} from './appUpdate'

beforeEach(() => {
  invokeMock.mockReset()
  listenMock.mockReset()
  isTauriMock.mockReset()
  isTauriMock.mockReturnValue(true)
})

describe('appUpdateInstall', () => {
  it('invokes app_update_install with the version the panel showed', async () => {
    invokeMock.mockResolvedValue({ kind: 'installed', version: '1.2.3' })
    const outcome = await appUpdateInstall('1.2.3')
    expect(invokeMock).toHaveBeenCalledWith('app_update_install', {
      expectedVersion: '1.2.3'
    })
    expect(outcome).toEqual({ kind: 'installed', version: '1.2.3' })
  })

  it('rejects with the backend refusal verbatim, never a synthetic message', async () => {
    const refusal =
      'app_update_install: refusing the downloaded update: its signature does not verify ' +
      'against the configured public key (bad signature). Nothing was installed'
    invokeMock.mockRejectedValue(refusal)
    await expect(appUpdateInstall('1.2.3')).rejects.toBe(refusal)
  })
})

describe('onAppUpdateProgress', () => {
  it('subscribes to the progress event and forwards the payload', async () => {
    const unlisten = vi.fn()
    listenMock.mockResolvedValue(unlisten)
    const handler = vi.fn()
    const stop = await onAppUpdateProgress(handler)
    expect(listenMock).toHaveBeenCalledWith(APP_UPDATE_PROGRESS_EVENT, expect.any(Function))
    const forward = listenMock.mock.calls[0][1] as (e: { payload: unknown }) => void
    forward({ payload: { phase: 'downloading', downloaded: 5, total: 10 } })
    expect(handler).toHaveBeenCalledWith({ phase: 'downloading', downloaded: 5, total: 10 })
    stop()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('subscribes to nothing outside Tauri and hands back a no-op unsubscribe', async () => {
    isTauriMock.mockReturnValue(false)
    const stop = await onAppUpdateProgress(() => {})
    expect(listenMock).not.toHaveBeenCalled()
    expect(() => stop()).not.toThrow()
  })

  it('survives an event API that fails to load, still handing back an unsubscribe', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    listenMock.mockRejectedValue(new Error('no event bridge'))
    const stop = await onAppUpdateProgress(() => {})
    expect(() => stop()).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
