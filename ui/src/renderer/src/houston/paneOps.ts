export const LIVE_CHILDREN_MARKER = 'live_children_confirmation_required:'

// A daemon close ends a PTY and removes the session within a few seconds even with a
// slow-to-exit agent; 15 s leaves headroom before the pane is handed back to the user.
export const CLOSE_SETTLE_TIMEOUT_MS = 15_000

// A respawn answers with a session_state or an error well inside this; past it the
// buttons are re-enabled so a lost reply never leaves the pane stuck.
export const RESPAWN_SETTLE_TIMEOUT_MS = 15_000

const CONTEXT_REF = /^session:(\d+)$/
// Older daemons name the session only in the text ("session 7 is closing", "unknown session id 7").
const TEXT_REF = /\b(?:session|pane)(?: id)?[ :]+(\d+)\b/gi

/** Sessions an error is about: its `session:<id>` context, else the ids its text names. */
export function errorSessionIds(error: { message: string; context?: string | null }): number[] {
  const scoped = CONTEXT_REF.exec(error.context ?? '')
  if (scoped) return [Number(scoped[1])]
  return [...error.message.matchAll(TEXT_REF)].map((m) => Number(m[1]))
}

type Timer = ReturnType<typeof setTimeout>

/** Close and respawn requests in flight, so a closing session is never placed or mounted and a refusal lands in its pane. */
export class PaneOps {
  private closing = new Map<number, Timer>()
  private respawning = new Map<number, Timer>()
  private errors = new Map<number, string>()
  // Every subscriber sees the same error object; the first attribution answers them all.
  private attributed = new WeakMap<object, number | null>()
  private listeners = new Set<() => void>()
  private closingSnapshot: ReadonlySet<number> = new Set()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Sessions the user asked to close that the daemon has not yet removed. */
  closingIds = (): ReadonlySet<number> => this.closingSnapshot

  isRespawning(session: number): boolean {
    return this.respawning.has(session)
  }

  error(session: number): string | null {
    return this.errors.get(session) ?? null
  }

  beginClose(session: number): void {
    this.errors.delete(session)
    clearTimeout(this.closing.get(session))
    this.closing.set(
      session,
      setTimeout(() => {
        if (!this.releaseClose(session)) return
        this.errors.set(
          session,
          `Closing session ${session} was not confirmed within ${CLOSE_SETTLE_TIMEOUT_MS} ms; the pane is back.`
        )
        this.emit()
      }, CLOSE_SETTLE_TIMEOUT_MS)
    )
    this.closingSnapshot = new Set(this.closing.keys())
    this.emit()
  }

  beginRespawn(session: number): void {
    this.errors.delete(session)
    clearTimeout(this.respawning.get(session))
    this.respawning.set(
      session,
      setTimeout(() => {
        if (this.respawning.delete(session)) this.emit()
      }, RESPAWN_SETTLE_TIMEOUT_MS)
    )
    this.emit()
  }

  /** The daemon answered a respawn with a new state for the session. */
  respawnSettled(session: number): void {
    if (this.endRespawn(session)) this.emit()
  }

  sessionRemoved(session: number): void {
    const closed = this.releaseClose(session)
    const respawned = this.endRespawn(session)
    const hadError = this.errors.delete(session)
    if (closed || respawned || hadError) this.emit()
  }

  clearError(session: number): void {
    if (this.errors.delete(session)) this.emit()
  }

  /** Routes an error to the session whose close or respawn it refuses; null when none matches. Repeat calls with the same error return the first answer. */
  attribute(error: { message: string; context?: string | null }): number | null {
    const known = this.attributed.get(error)
    if (known !== undefined) return known
    const session = this.route(error)
    this.attributed.set(error, session)
    return session
  }

  private route(error: { message: string; context?: string | null }): number | null {
    const message = error.message
    for (const session of errorSessionIds(error)) {
      const closing = this.closing.has(session)
      const respawning = this.respawning.has(session)
      if (!closing && !respawning) continue
      this.releaseClose(session)
      this.endRespawn(session)
      if (message.startsWith(LIVE_CHILDREN_MARKER)) {
        this.emit()
        return null
      }
      this.errors.set(session, message)
      this.emit()
      return session
    }
    return null
  }

  private releaseClose(session: number): boolean {
    const timer = this.closing.get(session)
    if (timer === undefined) return false
    clearTimeout(timer)
    this.closing.delete(session)
    this.closingSnapshot = new Set(this.closing.keys())
    return true
  }

  private endRespawn(session: number): boolean {
    const timer = this.respawning.get(session)
    if (timer === undefined) return false
    clearTimeout(timer)
    this.respawning.delete(session)
    return true
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
