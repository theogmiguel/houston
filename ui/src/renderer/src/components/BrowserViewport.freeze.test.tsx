// @vitest-environment jsdom
import { act, fireEvent, render, waitFor, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { assertNativeSuppression, releaseNativeSuppression, __resetNativeSuppressionForTests } from '../layout/nativeSuppression'
import { __resetBrowserSurfaceRegistryForTests } from '../houston/browserSurfaceRegistry'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../houston/host', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
import { BrowserViewport } from './BrowserViewport'

const CAPTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
afterEach(() => {
  cleanup()
  __resetNativeSuppressionForTests()
  __resetBrowserSurfaceRegistryForTests()
  invoke.mockReset()
})

function mount(capture: () => Promise<string>) {
  invoke.mockImplementation((cmd) => cmd === 'browser_capture_placeholder' ? capture() : Promise.resolve({ x: 0, y: 0, width: 100, height: 100 }))
  return render(<BrowserViewport id="guest" url="about:blank"><span>Fallback</span></BrowserViewport>)
}

it('paints a loaded image before hiding and releases it after reveal', async () => {
  const view = mount(async () => CAPTURE)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_mount', expect.anything()))
  act(() => assertNativeSuppression('modal'))
  const image = await waitFor(() => {
    const image = view.container.querySelector('img')
    expect(image).not.toBeNull()
    return image!
  })
  expect(image.parentElement).toBe(view.container.querySelector('[data-browser-surface-id]'))
  expect(image.style.width).toBe('100%')
  expect(image.style.height).toBe('100%')
  expect(invoke.mock.calls.filter(([cmd]) => cmd === 'browser_set_visible')).toEqual([])
  fireEvent.load(image)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_set_visible', { id: 'guest', visible: false, reason: 'modal' }))
  act(() => releaseNativeSuppression('modal'))
  await waitFor(() => expect(view.container.querySelector('img')).toBeNull())
  expect(invoke).toHaveBeenCalledWith('browser_set_visible', { id: 'guest', visible: true, reason: 'modal' })
})

it('uses a theme background when capture fails', async () => {
  const view = mount(async () => { throw new Error('capture failed') })
  act(() => assertNativeSuppression('modal'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_set_visible', { id: 'guest', visible: false, reason: 'modal' }))
  expect(view.container.querySelector('[data-browser-surface-id]')?.getAttribute('style')).toContain('var(--content-bg)')
  expect(view.container.querySelector('img')).toBeNull()
})

it('bounds a stalled capture and ignores its late image after release', async () => {
  let complete!: (image: string) => void
  const view = mount(() => new Promise<string>((resolve) => { complete = resolve }))
  act(() => assertNativeSuppression('modal'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_set_visible', { id: 'guest', visible: false, reason: 'modal' }))
  act(() => releaseNativeSuppression('modal'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_set_visible', { id: 'guest', visible: true, reason: 'modal' }))
  await act(async () => complete(CAPTURE))
  expect(view.container.querySelector('img')).toBeNull()
})

it('shares a frame across concurrent reasons until the last release', async () => {
  const view = mount(async () => CAPTURE)
  act(() => { assertNativeSuppression('modal'); assertNativeSuppression('animating') })
  const image = await waitFor(() => {
    const image = view.container.querySelector('img')
    expect(image).not.toBeNull()
    return image!
  })
  fireEvent.load(image)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_set_visible', { id: 'guest', visible: false, reason: 'animating' }))
  act(() => releaseNativeSuppression('modal'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_set_visible', { id: 'guest', visible: true, reason: 'modal' }))
  expect(view.container.querySelector('img')).toBe(image)
  expect(invoke.mock.calls.filter(([cmd]) => cmd === 'browser_capture_placeholder')).toHaveLength(1)
  act(() => releaseNativeSuppression('animating'))
  await waitFor(() => expect(view.container.querySelector('img')).toBeNull())
})
