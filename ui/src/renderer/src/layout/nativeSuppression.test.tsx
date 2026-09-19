// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('../houston/host', () => ({ isTauri: () => isTauriMock() }))

import {
  __resetNativeSuppressionForTests,
  assertNativeSuppression,
  isNativelySuppressed,
  releaseNativeSuppression,
  setSuppressionSink,
  suppressedReasons,
  useNativeSuppression,
  useNativeSuppressionCount,
  type NativeSuppressionReason
} from './nativeSuppression'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  __resetNativeSuppressionForTests()
  setSuppressionSink(null)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  setSuppressionSink(null)
  __resetNativeSuppressionForTests()
})

describe('assert/release ref-counting (mirrors suppress.rs)', () => {
  it('starts unsuppressed', () => {
    expect(isNativelySuppressed()).toBe(false)
  })

  it('asserting a reason suppresses', () => {
    assertNativeSuppression('modal')
    expect(isNativelySuppressed()).toBe(true)
  })

  it('releasing the only assertion un-suppresses', () => {
    assertNativeSuppression('modal')
    releaseNativeSuppression('modal')
    expect(isNativelySuppressed()).toBe(false)
  })

  it('two asserters of the same reason both need releasing before the pane can show', () => {
    assertNativeSuppression('modal')
    assertNativeSuppression('modal')
    releaseNativeSuppression('modal')
    expect(isNativelySuppressed()).toBe(true)
    releaseNativeSuppression('modal')
    expect(isNativelySuppressed()).toBe(false)
  })

  it('overlapping different reasons stay suppressed until every reason clears', () => {
    assertNativeSuppression('modal')
    assertNativeSuppression('popover')
    releaseNativeSuppression('modal')
    expect(isNativelySuppressed()).toBe(true)
    releaseNativeSuppression('popover')
    expect(isNativelySuppressed()).toBe(false)
  })

  it('releasing an unasserted reason is a no-op, not an error', () => {
    assertNativeSuppression('modal')
    expect(() => releaseNativeSuppression('grid-hidden')).not.toThrow()
    expect(isNativelySuppressed()).toBe(true)
  })

  it('sink fires only on the 0->1 and 1->0 transitions, never on redundant asserts', () => {
    const calls: Array<[NativeSuppressionReason, boolean]> = []
    setSuppressionSink((reason, visible) => calls.push([reason, visible]))
    assertNativeSuppression('modal')
    assertNativeSuppression('modal')
    releaseNativeSuppression('modal')
    releaseNativeSuppression('modal')
    expect(calls).toEqual([
      ['modal', false],
      ['modal', true]
    ])
  })

  it('a reason asserted with no sink registered is still readable once a sink registers later', () => {
    assertNativeSuppression('grid-hidden')
    const calls: Array<[NativeSuppressionReason, boolean]> = []
    setSuppressionSink((reason, visible) => calls.push([reason, visible]))
    expect(calls).toEqual([])
    expect(suppressedReasons()).toEqual(['grid-hidden'])
  })
})

function Probe({ reason, active }: { reason: NativeSuppressionReason; active: boolean }): null {
  useNativeSuppression(reason, active)
  return null
}

describe('useNativeSuppression (mount-scoped hook)', () => {
  it('asserts while active and releases on unmount', () => {
    act(() => {
      root.render(
        <StrictMode>
          <Probe reason="modal" active={true} />
        </StrictMode>
      )
    })
    expect(isNativelySuppressed()).toBe(true)
    act(() => root.unmount())
    root = createRoot(container)
    expect(isNativelySuppressed()).toBe(false)
  })

  it('releases when active flips false without unmounting', () => {
    let active = true
    const render = (): void =>
      act(() => {
        root.render(<Probe reason="popover" active={active} />)
      })
    render()
    expect(isNativelySuppressed()).toBe(true)
    active = false
    render()
    expect(isNativelySuppressed()).toBe(false)
  })

  it('unmounting while still active still releases -- no leaked suppression', () => {
    act(() => {
      root.render(<Probe reason="modal" active={true} />)
    })
    expect(isNativelySuppressed()).toBe(true)
    act(() => root.unmount())
    root = createRoot(container)
    expect(isNativelySuppressed()).toBe(false)
  })

  it('two mounted asserters of the same reason: unmounting one leaves the other holding it', () => {
    const a = document.createElement('div')
    document.body.appendChild(a)
    const rootA = createRoot(a)
    act(() => {
      root.render(<Probe reason="modal" active={true} />)
      rootA.render(<Probe reason="modal" active={true} />)
    })
    expect(isNativelySuppressed()).toBe(true)
    act(() => root.unmount())
    root = createRoot(container)
    expect(isNativelySuppressed()).toBe(true)
    act(() => rootA.unmount())
    a.remove()
    expect(isNativelySuppressed()).toBe(false)
  })

  it('Electron host issues nothing: the hook is a no-op when isTauri() is false', () => {
    isTauriMock.mockReturnValue(false)
    const calls: Array<[NativeSuppressionReason, boolean]> = []
    setSuppressionSink((reason, visible) => calls.push([reason, visible]))
    act(() => {
      root.render(<Probe reason="modal" active={true} />)
    })
    expect(isNativelySuppressed()).toBe(false)
    expect(calls).toEqual([])
  })
})

function CountProbe({
  reason,
  count
}: {
  reason: NativeSuppressionReason
  count: number
}): null {
  useNativeSuppressionCount(reason, count)
  return null
}

describe('useNativeSuppressionCount (several asserters of one reason)', () => {
  const sinkCalls: Array<[NativeSuppressionReason, boolean]> = []

  beforeEach(() => {
    sinkCalls.length = 0
    setSuppressionSink((reason, visible) => {
      sinkCalls.push([reason, visible])
    })
  })

  const renderCount = (count: number): void => {
    act(() => {
      root.render(<CountProbe reason="grid-hidden" count={count} />)
    })
  }

  it('emits nothing when one asserter hands over to another (1 -> 1)', () => {
    renderCount(1)
    expect(sinkCalls).toEqual([['grid-hidden', false]])
    renderCount(1)
    expect(sinkCalls).toEqual([['grid-hidden', false]])
  })

  it('stays asserted across 1 -> 2 -> 1', () => {
    renderCount(1)
    renderCount(2)
    expect(suppressedReasons()).toEqual(['grid-hidden'])
    renderCount(1)
    expect(suppressedReasons()).toEqual(['grid-hidden'])
  })

  it('churns once when the count changes without reaching zero (1 -> 2)', () => {
    renderCount(1)
    sinkCalls.length = 0
    renderCount(2)
    expect(sinkCalls).toEqual([
      ['grid-hidden', true],
      ['grid-hidden', false]
    ])
    expect(suppressedReasons()).toEqual(['grid-hidden'])
  })

  it('shows again only when the last asserter closes', () => {
    renderCount(2)
    sinkCalls.length = 0
    renderCount(0)
    expect(sinkCalls).toEqual([['grid-hidden', true]])
    expect(isNativelySuppressed()).toBe(false)
  })

  it('releases everything it holds on unmount, whatever the count was', () => {
    renderCount(3)
    expect(isNativelySuppressed()).toBe(true)
    act(() => root.unmount())
    root = createRoot(container)
    expect(isNativelySuppressed()).toBe(false)
  })

  it('leaks nothing across StrictMode’s double-invoke, at a count above one', () => {
    act(() => {
      root.render(
        <StrictMode>
          <CountProbe reason="grid-hidden" count={2} />
        </StrictMode>
      )
    })
    expect(suppressedReasons()).toEqual(['grid-hidden'])
    act(() => root.unmount())
    root = createRoot(container)
    expect(isNativelySuppressed()).toBe(false)
  })

  it('is inert under the Electron host (D4)', () => {
    isTauriMock.mockReturnValue(false)
    renderCount(2)
    expect(isNativelySuppressed()).toBe(false)
    expect(sinkCalls).toEqual([])
  })
})
