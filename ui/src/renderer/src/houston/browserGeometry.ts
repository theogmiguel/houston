export interface Rect {
  x: number
  y: number
  width: number
  height: number
  corners?: CornerSpec
}

export interface CornerSpec {
  radius: number
  borderWidth: number
  border: [number, number, number, number]
  surround: [number, number, number, number]
}

export interface BrowserCommands {
  mount(
    id: string,
    url: string,
    fullscreen: boolean,
    rect: Rect,
    workspaceId: string | null
  ): Promise<Rect>
  resize(id: string, rect: Rect): Promise<Rect>
  setVisible(id: string, visible: boolean, reason: string): Promise<void>
  destroy(id: string): Promise<void>
}

export const SETTLE_MS = [80, 200, 400] as const

export const MOUNT_RETRY_MS = [120, 300, 650, 1100, 1600] as const

// Sub-pixel layout churn (font metrics, 0.3px flex rounding) recurs every frame
// in some layouts and would page the GTK main thread, which runs every
// `browser_*` command inline, for no visible change.
export const RECT_EPSILON_PX = 1

export function computeDpr(platform: string, devicePixelRatio: number): number {
  return platform.includes('Linux') ? 1 : devicePixelRatio
}

export function rectsEqual(a: Rect, b: Rect, epsilon: number = RECT_EPSILON_PX): boolean {
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.width - b.width) <= epsilon &&
    Math.abs(a.height - b.height) <= epsilon &&
    cornersEqual(a.corners, b.corners)
  )
}

function cornersEqual(a: CornerSpec | undefined, b: CornerSpec | undefined): boolean {
  const square = (c: CornerSpec | undefined): boolean => !c || c.radius <= 0
  if (square(a) && square(b)) return true
  if (!a || !b) return false
  return (
    a.radius === b.radius &&
    a.borderWidth === b.borderWidth &&
    a.border.every((v, i) => v === b.border[i]) &&
    a.surround.every((v, i) => v === b.surround[i])
  )
}

export type Measure = () => Rect

export type MountStatus = 'idle' | 'mounting' | 'mounted' | 'failed'

export interface BrowserGeometryEngineOptions {
  id: string
  commands: BrowserCommands
  workspaceId?: string | null
  scheduleFrame?: (cb: () => void) => number
  cancelFrame?: (handle: number) => void
  setTimeoutFn?: (cb: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
  onMountFailure?: (id: string) => void
  onError?: (context: 'mount' | 'resize' | 'setVisible' | 'destroy', id: string, err: unknown) => void
}

export class BrowserGeometryEngine {
  private readonly id: string
  private readonly commands: BrowserCommands
  private readonly workspaceId: string | null
  private readonly scheduleFrame: (cb: () => void) => number
  private readonly cancelFrame: (handle: number) => void
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown
  private readonly clearTimeoutFn: (handle: unknown) => void
  private readonly onMountFailure?: (id: string) => void
  private readonly onError?: (
    context: 'mount' | 'resize' | 'setVisible' | 'destroy',
    id: string,
    err: unknown
  ) => void

// Every async command captures the generation active when it was issued; a
// result that resolves after `destroy()` or a fresh `mount()` bumped it is
// dropped, so a late reply never resizes a surface that has moved on.
  private generation = 0
  private mountStatus: MountStatus = 'idle'
  private lastCommittedRect: Rect | null = null

  private pendingFrame: number | null = null
  private pendingRect: Rect | null = null
  private settleTimers: unknown[] = []
  private mountRetryTimer: unknown = null

  constructor(options: BrowserGeometryEngineOptions) {
    this.id = options.id
    this.commands = options.commands
    this.workspaceId = options.workspaceId ?? null
    this.scheduleFrame =
      options.scheduleFrame ?? ((cb) => window.requestAnimationFrame(cb))
    this.cancelFrame = options.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle))
    this.setTimeoutFn = options.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimeoutFn =
      options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]))
    this.onMountFailure = options.onMountFailure
    this.onError = options.onError
  }

  get status(): MountStatus {
    return this.mountStatus
  }

  get currentGeneration(): number {
    return this.generation
  }

  get committedRect(): Rect | null {
    return this.lastCommittedRect
  }

  async mount(url: string, fullscreen: boolean, rect: Rect): Promise<void> {
    this.clearSettleTimers()
    this.clearMountRetryTimer()
    const generation = ++this.generation
    this.mountStatus = 'mounting'
    this.lastCommittedRect = null
    await this.attemptMount(generation, url, fullscreen, rect, 0)
  }

  private async attemptMount(
    generation: number,
    url: string,
    fullscreen: boolean,
    rect: Rect,
    attemptIndex: number
  ): Promise<void> {
    try {
      const committed = await this.commands.mount(
        this.id,
        url,
        fullscreen,
        rect,
        this.workspaceId
      )
      if (generation !== this.generation) return
      this.mountStatus = 'mounted'
      this.lastCommittedRect = committed
    } catch (err) {
      if (generation !== this.generation) return
      if (attemptIndex >= MOUNT_RETRY_MS.length) {
        this.mountStatus = 'failed'
        this.onMountFailure?.(this.id)
        this.onError?.('mount', this.id, err)
        return
      }
      const delayMs = MOUNT_RETRY_MS[attemptIndex]
      await new Promise<void>((resolve) => {
        this.mountRetryTimer = this.setTimeoutFn(() => {
          this.mountRetryTimer = null
          resolve()
        }, delayMs)
      })
      if (generation !== this.generation) return
      await this.attemptMount(generation, url, fullscreen, rect, attemptIndex + 1)
    }
  }

  requestRectUpdate(rect: Rect): void {
    if (this.mountStatus !== 'mounted') return
    this.pendingRect = rect
    if (this.pendingFrame !== null) return
    const generation = this.generation
    this.pendingFrame = this.scheduleFrame(() => {
      this.pendingFrame = null
      const next = this.pendingRect
      this.pendingRect = null
      if (!next) return
      if (generation !== this.generation) return
      this.commitRect(generation, next)
    })
  }

  private commitRect(generation: number, rect: Rect): void {
    if (this.lastCommittedRect && rectsEqual(this.lastCommittedRect, rect)) return
    this.commands
      .resize(this.id, rect)
      .then((committed) => {
        if (generation !== this.generation) return
        this.lastCommittedRect = committed
      })
      .catch((err) => {
        if (generation !== this.generation) return
        this.onError?.('resize', this.id, err)
      })
  }

  onResizeObserverBurst(measure: Measure): void {
    this.requestRectUpdate(measure())
    this.clearSettleTimers()
    const generation = this.generation
    for (const delayMs of SETTLE_MS) {
      const timer = this.setTimeoutFn(() => {
        if (generation !== this.generation) return
        this.requestRectUpdate(measure())
      }, delayMs)
      this.settleTimers.push(timer)
    }
  }

  setVisible(visible: boolean, reason: string): Promise<void> {
    return this.commands.setVisible(this.id, visible, reason).catch((err) => {
      this.onError?.('setVisible', this.id, err)
      throw err
    })
  }

  destroy(): void {
    this.generation++
    this.clearSettleTimers()
    this.clearMountRetryTimer()
    if (this.pendingFrame !== null) {
      this.cancelFrame(this.pendingFrame)
      this.pendingFrame = null
    }
    this.pendingRect = null
    this.mountStatus = 'idle'
    this.lastCommittedRect = null
    this.commands.destroy(this.id).catch((err) => {
      this.onError?.('destroy', this.id, err)
    })
  }

  private clearSettleTimers(): void {
    for (const timer of this.settleTimers) this.clearTimeoutFn(timer)
    this.settleTimers = []
  }

  private clearMountRetryTimer(): void {
    if (this.mountRetryTimer !== null) {
      this.clearTimeoutFn(this.mountRetryTimer)
      this.mountRetryTimer = null
    }
  }
}
