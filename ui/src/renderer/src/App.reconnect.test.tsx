// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectionMock, currentClient, makeFakeClient, renderReadyApp, resetHarness, type AppHarness } from './test/appTestHarness'
import type { HoustonClient } from './houston/client'

const connectMock = connectionMock()
let app: AppHarness | undefined
beforeEach(() => { resetHarness(); localStorage.clear() })
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers() })

it('owns one pending retry, closes replaced and late clients, and ignores obsolete callbacks', async () => {
  app = await renderReadyApp()
  await import('./components/ReconnectBanner')
  const boot = currentClient()
  const bootClose = vi.spyOn(boot, 'close')
  const obsoleteClose = boot.onClose
  const obsoleteFrame = boot.onFrame
  let resolve!: (client: HoustonClient) => void
  connectMock.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  vi.useFakeTimers()
  await act(async () => { boot.onClose(); await Promise.resolve() })
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(connectMock).toHaveBeenCalledTimes(2)
  const retry = Array.from(app.container.querySelectorAll('button')).find(b => b.textContent === 'Retry now')!
  expect(retry).toBeDefined()
  act(() => { retry.click(); retry.click() })
  expect(connectMock).toHaveBeenCalledTimes(2)
  const replacement = makeFakeClient()
  const replacementClose = vi.spyOn(replacement, 'close')
  await act(async () => { resolve(replacement); await Promise.resolve() })
  expect(bootClose).toHaveBeenCalledOnce()
  act(() => { obsoleteClose(); obsoleteFrame(1, 0, new Uint8Array([65])) })
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(connectMock).toHaveBeenCalledTimes(2)
  let lateResolve!: (client: HoustonClient) => void
  connectMock.mockImplementationOnce(() => new Promise(r => { lateResolve = r }))
  act(() => replacement.onClose())
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  app.unmount(); app = undefined
  expect(replacementClose).toHaveBeenCalledOnce()
  const late = makeFakeClient()
  const lateClose = vi.spyOn(late, 'close')
  lateResolve(late)
  await Promise.resolve()
  expect(lateClose).toHaveBeenCalledOnce()
})
