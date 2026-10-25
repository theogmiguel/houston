import type { HoustonClient } from './client'

// The daemon admits 16 control handlers per connection and refuses the 17th. A surface
// that asks once per directory or workspace queues here: a bounded number in flight,
// and a key already queued or awaiting its reply is skipped.

export interface BoundedPoller {
  /** Queues each key unless it already awaits a reply or is already queued. */
  request(keys: readonly string[]): void
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
}

export function createBoundedPoller(
  client: Pick<HoustonClient, 'subscribe'>,
  spec: BoundedPollerSpec,
  limit: number,
  timeoutMs: number,
): BoundedPoller {
  const inFlight = new Map<string, ReturnType<typeof setTimeout>>()
  const queue: string[] = []
  let disposed = false

  const pump = (): void => {
    while (!disposed && inFlight.size < limit && queue.length > 0) {
      const key = queue.shift() as string
      inFlight.set(key, setTimeout(() => release(key), timeoutMs))
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

  const offReplies = spec.replies(release)
  // Failures carry the context but not the key: the oldest request is the likeliest
  // to have failed, and the timeout covers a wrong guess.
  const offError = client.subscribe('error', (message) => {
    if (spec.errorContext === undefined || message.context !== spec.errorContext) return
    const oldest = inFlight.keys().next()
    if (!oldest.done) release(oldest.value)
  })

  return {
    request(keys) {
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
    },
  }
}
