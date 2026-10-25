import type { HoustonClient } from './client'

// The daemon admits 16 control handlers per connection and refuses the 17th. A surface
// that asks once per directory or workspace queues here: a bounded number in flight,
// and a key already queued or awaiting its reply is skipped.

export interface BoundedPoller {
  /** Queues each key unless it awaits a reply, is queued, or is backing off. */
  request(keys: readonly string[]): void
  /** Queues each key, honouring only the in-flight and queued guards; for
   * user-initiated refreshes, which a failure ladder must never delay. */
  requestNow(keys: readonly string[]): void
  /** Forgets queued keys; requests already sent keep their slot until they resolve. */
  dropQueued(): void
  dispose(): void
}

export interface BoundedPollerSpec {
  send(key: string): void
  /** Subscribes to the replies; each calls `settle` with the key it answers. */
  replies(settle: (key: string) => void): () => void
  /** The error context of a failed request, when its failures carry one. */
  errorContext?: string
  /** Delays a key's next `request` after a failed one (an error or a lost reply):
   * `baseMs`, doubling per consecutive failure up to `maxMs`. Any reply resets it. */
  backoff?: { baseMs: number; maxMs: number }
}

/** One rung per consecutive failure: `baseMs`, then doubling up to `maxMs`. */
export function backoffDelayMs(backoff: { baseMs: number; maxMs: number }, failures: number): number {
  return Math.min(backoff.baseMs * 2 ** (failures - 1), backoff.maxMs)
}

export function createBoundedPoller(
  client: Pick<HoustonClient, 'subscribe'>,
  spec: BoundedPollerSpec,
  limit: number,
  timeoutMs: number,
): BoundedPoller {
  const inFlight = new Map<string, ReturnType<typeof setTimeout>>()
  const queue: string[] = []
  const failures = new Map<string, number>()
  const nextAttemptAt = new Map<string, number>()
  let disposed = false

  const markFailure = (key: string): void => {
    if (!spec.backoff) return
    const count = (failures.get(key) ?? 0) + 1
    failures.set(key, count)
    // The deadline measures elapsed time, so read the monotonic clock: a
    // wall-clock step (NTP, manual change) must not extend or cut a backoff.
    nextAttemptAt.set(key, performance.now() + backoffDelayMs(spec.backoff, count))
  }
  const markSuccess = (key: string): void => {
    failures.delete(key)
    nextAttemptAt.delete(key)
  }
  const backingOff = (key: string): boolean => {
    const at = nextAttemptAt.get(key)
    return at !== undefined && performance.now() < at
  }

  const pump = (): void => {
    while (!disposed && inFlight.size < limit && queue.length > 0) {
      const key = queue.shift() as string
      inFlight.set(key, setTimeout(() => {
        markFailure(key)
        release(key)
      }, timeoutMs))
      spec.send(key)
    }
  }
  const release = (key: string): void => {
    const timer = inFlight.get(key)
    if (timer === undefined) return
    clearTimeout(timer)
    inFlight.delete(key)
    pump()
  }

  const offReplies = spec.replies((key) => {
    markSuccess(key)
    release(key)
  })
  // Failures carry the context but not the key: the oldest request is the likeliest
  // to have failed, and the timeout covers a wrong guess.
  const offError = client.subscribe('error', (message) => {
    if (spec.errorContext === undefined || message.context !== spec.errorContext) return
    const oldest = inFlight.keys().next()
    if (!oldest.done) {
      markFailure(oldest.value)
      release(oldest.value)
    }
  })

  return {
    request(keys) {
      for (const key of keys) {
        if (inFlight.has(key) || queue.includes(key) || backingOff(key)) continue
        queue.push(key)
      }
      pump()
    },
    requestNow(keys) {
      for (const key of keys) {
        if (!inFlight.has(key) && !queue.includes(key)) queue.push(key)
      }
      pump()
    },
    dropQueued() {
      queue.length = 0
    },
    dispose() {
      disposed = true
      offReplies()
      offError()
      for (const timer of inFlight.values()) clearTimeout(timer)
      inFlight.clear()
      queue.length = 0
      failures.clear()
      nextAttemptAt.clear()
    },
  }
}
