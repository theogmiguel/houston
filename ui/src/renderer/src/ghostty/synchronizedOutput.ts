import type { GhosttyTerminalCore } from './core'

// Recover from an interrupted writer without displaying its intermediate clears.
const MAX_HOLD_MS = 1000

export class SynchronizedOutput {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly core: Pick<GhosttyTerminalCore, 'isSynchronizedOutput' | 'endSynchronizedOutput'>,
    private readonly requestRender: () => void
  ) {}

  defer(): boolean {
    if (!this.core.isSynchronizedOutput()) {
      this.dispose()
      return false
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.core.endSynchronizedOutput()
        this.requestRender()
      }, MAX_HOLD_MS)
    }
    return true
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
