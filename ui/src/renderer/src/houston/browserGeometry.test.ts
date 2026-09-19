import { describe, expect, it, vi } from 'vitest'
import {
  BrowserGeometryEngine,
  MOUNT_RETRY_MS,
  RECT_EPSILON_PX,
  SETTLE_MS,
  computeDpr,
  rectsEqual,
  type CornerSpec,
  type BrowserCommands,
  type Rect
} from './browserGeometry'

const RECT_A: Rect = { x: 0, y: 0, width: 800, height: 600 }
const RECT_B: Rect = { x: 100, y: 50, width: 400, height: 300 }

function rect(overrides: Partial<Rect> = {}): Rect {
  return { ...RECT_A, ...overrides }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function fakeFrameScheduler(): {
  scheduleFrame: (cb: () => void) => number
  cancelFrame: (handle: number) => void
  runFrame: () => void
  pendingCount: () => number
} {
  let nextId = 1
  const pending = new Map<number, () => void>()
  return {
    scheduleFrame: (cb) => {
      const id = nextId++
      pending.set(id, cb)
      return id
    },
    cancelFrame: (handle) => {
      pending.delete(handle)
    },
    runFrame: () => {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const cb of callbacks) cb()
    },
    pendingCount: () => pending.size
  }
}

function fakeTimerScheduler(): {
  setTimeoutFn: (cb: () => void, ms: number) => number
  clearTimeoutFn: (handle: unknown) => void
  delays: () => number[]
  fireNext: () => void
} {
  let nextId = 1
  const scheduled: Array<{ id: number; ms: number; cb: () => void }> = []
  const everyDelay: number[] = []
  return {
    setTimeoutFn: (cb, ms) => {
      const id = nextId++
      scheduled.push({ id, ms, cb })
      everyDelay.push(ms)
      return id
    },
    clearTimeoutFn: (handle) => {
      const idx = scheduled.findIndex((entry) => entry.id === handle)
      if (idx !== -1) scheduled.splice(idx, 1)
    },
    delays: () => [...everyDelay],
    fireNext: () => {
      const entry = scheduled.shift()
      entry?.cb()
    }
  }
}

function fakeCommands(overrides: Partial<BrowserCommands> = {}): BrowserCommands {
  return {
    mount: vi.fn().mockResolvedValue(rect()),
    resize: vi.fn().mockResolvedValue(rect()),
    setVisible: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

describe("constants (the reference's own geometry-sync ladders)", () => {
  it('pins the settle-timer ladder', () => {
    expect(SETTLE_MS).toEqual([80, 200, 400])
  })

  it('pins the mount-retry ladder', () => {
    expect(MOUNT_RETRY_MS).toEqual([120, 300, 650, 1100, 1600])
  })

  it('pins the rect comparator tolerance', () => {
    expect(RECT_EPSILON_PX).toBe(1)
  })
})

describe('computeDpr', () => {
  it('forces scale 1 on Linux regardless of the reported device pixel ratio', () => {
    expect(computeDpr('Linux x86_64', 2)).toBe(1)
    expect(computeDpr('Linux x86_64', 1)).toBe(1)
  })

  it('passes the device pixel ratio through on non-Linux platforms', () => {
    expect(computeDpr('MacIntel', 2)).toBe(2)
    expect(computeDpr('Win32', 1.5)).toBe(1.5)
  })
})

describe('rectsEqual', () => {
  it('treats an identical rect as equal', () => {
    expect(rectsEqual(rect(), rect())).toBe(true)
  })

  it('treats a rect moved by exactly the epsilon as still equal', () => {
    expect(rectsEqual(rect(), rect({ x: 1 }))).toBe(true)
  })

  it('treats a rect moved past the epsilon as unequal', () => {
    expect(rectsEqual(rect(), rect({ x: 1.01 }))).toBe(false)
  })

  it('checks every axis, not just position', () => {
    expect(rectsEqual(rect(), rect({ width: 803 }))).toBe(false)
    expect(rectsEqual(rect(), rect({ height: 603 }))).toBe(false)
  })

  describe('corners', () => {
    const corners = (overrides: Partial<CornerSpec> = {}): CornerSpec => ({
      radius: 9,
      borderWidth: 1,
      border: [0.2, 0.2, 0.2, 1],
      surround: [0.05, 0.05, 0.06, 1],
      ...overrides
    })

    it('treats an absent spec and a zero radius as the same square corner', () => {
      expect(rectsEqual(rect(), rect({ corners: corners({ radius: 0 }) }))).toBe(true)
    })

    it('is unequal when a square surface becomes a rounded one', () => {
      expect(rectsEqual(rect(), rect({ corners: corners() }))).toBe(false)
    })

    it('is unequal on a radius change alone — the 280px container query', () => {
      const a = rect({ corners: corners({ radius: 9 }) })
      const b = rect({ corners: corners({ radius: 5 }) })
      expect(rectsEqual(a, b)).toBe(false)
    })

    it('is unequal on a border-colour change alone — selection moving', () => {
      const a = rect({ corners: corners({ border: [0.2, 0.2, 0.2, 1] }) })
      const b = rect({ corners: corners({ border: [0.6, 0.6, 0.6, 1] }) })
      expect(rectsEqual(a, b)).toBe(false)
    })

    it('is unequal on a surround change alone — a theme swap', () => {
      const a = rect({ corners: corners({ surround: [0.05, 0.05, 0.06, 1] }) })
      const b = rect({ corners: corners({ surround: [0.98, 0.98, 0.98, 1] }) })
      expect(rectsEqual(a, b)).toBe(false)
    })

    it('does NOT apply the pixel epsilon to the radius', () => {
      expect(rectsEqual(rect(), rect({ x: 0.5 }))).toBe(true)
      const a = rect({ corners: corners({ radius: 9 }) })
      const b = rect({ corners: corners({ radius: 9.5 }) })
      expect(rectsEqual(a, b)).toBe(false)
    })
  })
})

describe('BrowserGeometryEngine — rect comparator gates the resize command', () => {
  it('issues no resize command when the new rect has not moved past RECT_EPSILON_PX', async () => {
    const frames = fakeFrameScheduler()
    const commands = fakeCommands({ mount: vi.fn().mockResolvedValue(rect()) })
    const engine = new BrowserGeometryEngine({
      id: 'leaf-1',
      commands,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame
    })

    await engine.mount('https://example.com', false, rect())
    engine.requestRectUpdate(rect({ x: 0.4, y: -0.6 }))
    frames.runFrame()
    await tick()

    expect(commands.resize).not.toHaveBeenCalled()
  })

  it('issues a resize command once the rect has moved past RECT_EPSILON_PX', async () => {
    const frames = fakeFrameScheduler()
    const moved = rect({ x: 20 })
    const commands = fakeCommands({
      mount: vi.fn().mockResolvedValue(rect()),
      resize: vi.fn().mockResolvedValue(moved)
    })
    const engine = new BrowserGeometryEngine({
      id: 'leaf-1',
      commands,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame
    })

    await engine.mount('https://example.com', false, rect())
    engine.requestRectUpdate(moved)
    frames.runFrame()
    await tick()

    expect(commands.resize).toHaveBeenCalledTimes(1)
    expect(commands.resize).toHaveBeenCalledWith('leaf-1', moved)
    expect(engine.committedRect).toEqual(moved)
  })
})

describe('BrowserGeometryEngine — rAF coalescing', () => {
  it('collapses a burst of rect updates inside one frame into a single resize command', async () => {
    const frames = fakeFrameScheduler()
    const commands = fakeCommands({ mount: vi.fn().mockResolvedValue(rect()) })
    const engine = new BrowserGeometryEngine({
      id: 'leaf-1',
      commands,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame
    })

    await engine.mount('https://example.com', false, rect())
    engine.requestRectUpdate(rect({ x: 10 }))
    engine.requestRectUpdate(rect({ x: 20 }))
    engine.requestRectUpdate(RECT_B)
    expect(frames.pendingCount()).toBe(1)

    frames.runFrame()
    await tick()

    expect(commands.resize).toHaveBeenCalledTimes(1)
    expect(commands.resize).toHaveBeenCalledWith('leaf-1', RECT_B)
  })
})

describe('BrowserGeometryEngine — settle-timer ladder', () => {
  it('arms SETTLE_MS after a ResizeObserver burst and re-measures at each rung', async () => {
    const frames = fakeFrameScheduler()
    const timers = fakeTimerScheduler()
    const commands = fakeCommands({ mount: vi.fn().mockResolvedValue(rect()) })
    const engine = new BrowserGeometryEngine({
      id: 'leaf-1',
      commands,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    })
    await engine.mount('https://example.com', false, rect())
    frames.runFrame()
    commands.resize = vi.fn().mockResolvedValue(rect())

    const measurements = [rect({ x: 5 }), rect({ x: 9 }), rect({ x: 40 })]
    let call = 0
    const measure = (): Rect => measurements[call++] ?? measurements[measurements.length - 1]

    engine.onResizeObserverBurst(measure)
    frames.runFrame()
    await tick()

    expect(timers.delays()).toEqual([80, 200, 400])

    timers.fireNext()
    frames.runFrame()
    await tick()
    timers.fireNext()
    frames.runFrame()
    await tick()
    timers.fireNext()
    frames.runFrame()
    await tick()

    expect(call).toBe(4)
  })

  it('drops a settle rung that fires after the engine has moved on to a new generation', async () => {
    const frames = fakeFrameScheduler()
    const timers = fakeTimerScheduler()
    const commands = fakeCommands({ mount: vi.fn().mockResolvedValue(rect()) })
    const engine = new BrowserGeometryEngine({
      id: 'leaf-1',
      commands,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    })
    await engine.mount('https://example.com', false, rect())

    let measureCalls = 0
    const measure = (): Rect => {
      measureCalls++
      return rect({ x: 99 })
    }
    engine.onResizeObserverBurst(measure)
    frames.runFrame()
    await tick()
    const callsBeforeDestroy = measureCalls

    engine.destroy()
    timers.fireNext()
    timers.fireNext()
    timers.fireNext()
    await tick()

    expect(measureCalls).toBe(callsBeforeDestroy)
  })
})

describe('BrowserGeometryEngine — mount-retry ladder', () => {
  it('retries a failing mount along MOUNT_RETRY_MS and reports a terminal failure once exhausted', async () => {
    const timers = fakeTimerScheduler()
    const mount = vi.fn().mockRejectedValue(new Error('mount failed'))
    const commands = fakeCommands({ mount })
    const onMountFailure = vi.fn()
    const onError = vi.fn()
    const engine = new BrowserGeometryEngine({
      id: 'leaf-1',
      commands,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onMountFailure,
      onError
    })

    const mountPromise = engine.mount('https://example.com', false, rect())
    await tick()
    expect(engine.status).toBe('mounting')

    for (let attempt = 0; attempt < MOUNT_RETRY_MS.length; attempt++) {
      timers.fireNext()
      await tick()
    }
    await mountPromise

    expect(timers.delays()).toEqual([...MOUNT_RETRY_MS])
    expect(mount).toHaveBeenCalledTimes(1 + MOUNT_RETRY_MS.length)
    expect(onMountFailure).toHaveBeenCalledTimes(1)
    expect(onMountFailure).toHaveBeenCalledWith('leaf-1')
    expect(onError).toHaveBeenCalledWith('mount', 'leaf-1', expect.any(Error))
    expect(engine.status).toBe('failed')
  })

  it('recovers if a retry succeeds before the ladder is exhausted', async () => {
    const timers = fakeTimerScheduler()
    const mount = vi
      .fn()
      .mockRejectedValueOnce(new Error('first attempt failed'))
      .mockResolvedValueOnce(rect())
    const commands = fakeCommands({ mount })
    const onMountFailure = vi.fn()
    const engine = new BrowserGeometryEngine({
      id: 'leaf-1',
      commands,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onMountFailure
    })

    const mountPromise = engine.mount('https://example.com', false, rect())
    await tick()
    expect(timers.delays()).toEqual([120])

    timers.fireNext()
    await mountPromise

    expect(mount).toHaveBeenCalledTimes(2)
    expect(onMountFailure).not.toHaveBeenCalled()
    expect(engine.status).toBe('mounted')
  })
})

describe('BrowserGeometryEngine — generations drop stale async results', () => {
  it('drops a mount result that resolves after destroy() moved the generation on', async () => {
    let resolveMount: ((committed: Rect) => void) | undefined
    const mount = vi.fn(
      () =>
        new Promise<Rect>((resolve) => {
          resolveMount = resolve
        })
    )
    const commands = fakeCommands({ mount })
    const engine = new BrowserGeometryEngine({ id: 'leaf-1', commands })

    void engine.mount('https://example.com', false, rect())
    await tick()
    expect(engine.status).toBe('mounting')

    engine.destroy()
    expect(engine.status).toBe('idle')

    resolveMount?.(rect({ x: 999 }))
    await tick()

    expect(engine.status).toBe('idle')
    expect(engine.committedRect).toBeNull()
  })

  it('drops a mount result that resolves after a fresh mount() call superseded it', async () => {
    let resolveFirst: ((committed: Rect) => void) | undefined
    const firstRectResult = rect({ x: 1 })
    const secondRectResult = rect({ x: 2 })
    const mount = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Rect>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce(secondRectResult)
    const commands = fakeCommands({ mount })
    const engine = new BrowserGeometryEngine({ id: 'leaf-1', commands })

    void engine.mount('https://example.com/first', false, rect())
    await tick()

    await engine.mount('https://example.com/second', false, rect())
    expect(engine.committedRect).toEqual(secondRectResult)

    resolveFirst?.(firstRectResult)
    await tick()

    expect(engine.committedRect).toEqual(secondRectResult)
    expect(engine.status).toBe('mounted')
  })

  it('drops a resize result that resolves after destroy() moved the generation on', async () => {
    const frames = fakeFrameScheduler()
    let resolveResize: ((committed: Rect) => void) | undefined
    const resize = vi.fn(
      () =>
        new Promise<Rect>((resolve) => {
          resolveResize = resolve
        })
    )
    const initial = rect()
    const commands = fakeCommands({ mount: vi.fn().mockResolvedValue(initial), resize })
    const engine = new BrowserGeometryEngine({
      id: 'leaf-1',
      commands,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame
    })

    await engine.mount('https://example.com', false, initial)
    engine.requestRectUpdate(rect({ x: 30 }))
    frames.runFrame()
    await tick()

    engine.destroy()
    resolveResize?.(rect({ x: 30 }))
    await tick()

    expect(engine.committedRect).toBeNull()
  })
})

describe('BrowserGeometryEngine — setVisible and destroy', () => {
  it('passes visible and reason straight through, without inventing a reason of its own (ledger D2)', async () => {
    const commands = fakeCommands()
    const engine = new BrowserGeometryEngine({ id: 'leaf-1', commands })

    await engine.setVisible(false, 'tabs-popover')

    expect(commands.setVisible).toHaveBeenCalledWith('leaf-1', false, 'tabs-popover')
  })

  it('issues browser_destroy and resets state so a later resize/burst is a no-op', async () => {
    const frames = fakeFrameScheduler()
    const commands = fakeCommands({ mount: vi.fn().mockResolvedValue(rect()) })
    const engine = new BrowserGeometryEngine({
      id: 'leaf-1',
      commands,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame
    })
    await engine.mount('https://example.com', false, rect())

    engine.destroy()
    await tick()

    expect(commands.destroy).toHaveBeenCalledWith('leaf-1')
    expect(engine.status).toBe('idle')

    engine.requestRectUpdate(rect({ x: 500 }))
    frames.runFrame()
    await tick()
    expect(commands.resize).not.toHaveBeenCalled()
  })
})
