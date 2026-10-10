
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  __resetNativeSuppressionForTests,
  assertNativeSuppression,
  releaseNativeSuppression,
  setSuppressionSink
} from '../layout/nativeSuppression'
import {
  __resetBrowserSurfaceRegistryForTests,
  nativeBrowserSurfaceRects,
  registerBrowserSurface,
  unregisterBrowserSurface
} from './browserSurfaceRegistry'

afterEach(() => {
  __resetBrowserSurfaceRegistryForTests()
  __resetNativeSuppressionForTests()
  setSuppressionSink(null)
})

const noop = (): Promise<void> => Promise.resolve()

describe('browserSurfaceRegistry — the reason->id fan-out', () => {
  it('hides every live surface when a reason is asserted, and shows them again on release', async () => {
    const a = vi.fn(noop)
    const b = vi.fn(noop)
    registerBrowserSurface('leaf-1', a)
    registerBrowserSurface('right-panel', b)

    assertNativeSuppression('modal')
    expect(a).toHaveBeenCalledWith(false, 'modal')
    expect(b).toHaveBeenCalledWith(false, 'modal')

    releaseNativeSuppression('modal')
    expect(a).toHaveBeenCalledWith(true, 'modal')
    expect(b).toHaveBeenCalledWith(true, 'modal')
  })

  it('fires once per transition, not once per asserter', () => {
    const a = vi.fn(noop)
    registerBrowserSurface('leaf-1', a)

    assertNativeSuppression('popover')
    assertNativeSuppression('popover')
    expect(a).toHaveBeenCalledTimes(1)

    releaseNativeSuppression('popover')
    expect(a).toHaveBeenCalledTimes(1)

    releaseNativeSuppression('popover')
    expect(a).toHaveBeenCalledTimes(2)
    expect(a).toHaveBeenLastCalledWith(true, 'popover')
  })

  it('brings a surface up hidden when it mounts under an already-asserted reason', () => {
    assertNativeSuppression('modal')
    assertNativeSuppression('grid-hidden')

    const late = vi.fn(noop)
    registerBrowserSurface('mounted-late', late)

    expect(late).toHaveBeenCalledWith(false, 'modal')
    expect(late).toHaveBeenCalledWith(false, 'grid-hidden')
    expect(late).toHaveBeenCalledTimes(2)
  })

  it('stops talking to a surface once it unregisters', () => {
    const gone = vi.fn(noop)
    registerBrowserSurface('leaf-1', gone)
    unregisterBrowserSurface('leaf-1')

    assertNativeSuppression('modal')
    expect(gone).not.toHaveBeenCalled()
  })

  it('skips a detached surface for a reason asserted in the main window', () => {
    const attached = vi.fn(noop)
    const detached = vi.fn(noop)
    registerBrowserSurface('leaf-1', attached)
    registerBrowserSurface('leaf-2', detached, () => true)

    assertNativeSuppression('modal')
    expect(attached).toHaveBeenCalledWith(false, 'modal')
    expect(detached).not.toHaveBeenCalled()

    releaseNativeSuppression('modal')
    expect(attached).toHaveBeenCalledWith(true, 'modal')
    expect(detached).not.toHaveBeenCalled()
  })

  it('skips the catch-up replay too when a surface mounts already detached', () => {
    assertNativeSuppression('modal')

    const late = vi.fn(noop)
    registerBrowserSurface('mounted-late', late, () => true)

    expect(late).not.toHaveBeenCalled()
  })

  it('does not let one surface’s failure reach the asserting overlay', () => {
    const failing = vi.fn(() => Promise.reject(new Error('the child is gone')))
    const healthy = vi.fn(noop)
    registerBrowserSurface('dead', failing)
    registerBrowserSurface('alive', healthy)

    expect(() => assertNativeSuppression('modal')).not.toThrow()
    expect(healthy).toHaveBeenCalledWith(false, 'modal')
  })
})

it('does not hide a surface outside the overlay rectangle', () => {
  const visible = vi.fn(noop)
  registerBrowserSurface('left', visible, () => false, () => ({ x: 0, y: 0, width: 100, height: 100 }))
  const scope = { key: 'menu', rect: () => ({ x: 200, y: 0, width: 20, height: 20 }) }
  assertNativeSuppression('popover', scope)
  expect(visible).not.toHaveBeenCalled()
  releaseNativeSuppression('popover', scope)
  expect(visible).not.toHaveBeenCalled()
})

it('keeps overlapping menus independent and releases the original reason after a move', () => {
  const visible = vi.fn(noop)
  registerBrowserSurface('guest', visible, () => false, () => ({ x: 0, y: 0, width: 100, height: 100 }))
  let x = 10
  const a = { key: 'tabs', rect: () => ({ x, y: 10, width: 20, height: 20 }) }
  const b = { key: 'select', rect: () => ({ x: 20, y: 10, width: 20, height: 20 }) }
  assertNativeSuppression('popover', a)
  assertNativeSuppression('popover', b)
  expect(visible.mock.calls).toEqual([[false, 'popover:tabs'], [false, 'popover:select']])
  x = 200
  assertNativeSuppression('popover', a)
  expect(visible).toHaveBeenLastCalledWith(true, 'popover:tabs')
  releaseNativeSuppression('popover', a)
  expect(visible).toHaveBeenCalledTimes(3)
  releaseNativeSuppression('popover', b)
  expect(visible).toHaveBeenLastCalledWith(true, 'popover:select')
})

it('replays intersecting overlays for a surface mounted later', () => {
  const scope = { key: 'tabs', rect: () => ({ x: 10, y: 10, width: 20, height: 20 }) }
  assertNativeSuppression('popover', scope)
  const visible = vi.fn(noop)
  registerBrowserSurface('late', visible, () => false, () => ({ x: 0, y: 0, width: 100, height: 100 }))
  expect(visible).toHaveBeenCalledWith(false, 'popover:tabs')
  releaseNativeSuppression('popover', scope)
  expect(visible).toHaveBeenLastCalledWith(true, 'popover:tabs')
})

it('exposes live attached browser rectangles for renderer placement without including detached or empty surfaces', () => {
  let rect = { x: 200, y: 100, width: 500, height: 400 }
  registerBrowserSurface('attached', noop, () => false, () => rect)
  registerBrowserSurface('detached', noop, () => true, () => rect)
  registerBrowserSurface('empty', noop, () => false, () => ({ ...rect, width: 0 }))
  expect(nativeBrowserSurfaceRects()).toEqual([rect])
  rect = { ...rect, x: 300 }
  expect(nativeBrowserSurfaceRects()).toEqual([rect])
  unregisterBrowserSurface('attached')
  expect(nativeBrowserSurfaceRects()).toEqual([])
})
