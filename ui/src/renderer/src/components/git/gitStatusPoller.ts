import type { HoustonClient } from '../../houston/client'

// The daemon admits 16 control handlers per connection and each git_status runs
// ~6 git subprocesses, so a rail of 16+ checkouts must not fire them all at once.
// 4 keeps the rail refresh well under that cap and leaves room for user actions.
export const GIT_STATUS_IN_FLIGHT_LIMIT = 4

// An error reply names no directory and a refused request never replies, so a slot
// can outlive its request. 30 s covers the slowest measured round trip (22.5 s under
// load) and bounds how long a lost reply can hold a slot.
export const GIT_STATUS_REPLY_TIMEOUT_MS = 30_000

// The rail tick re-requests a failing directory every beat, so a broken repo keeps
// paying ~6 git subprocesses per minute. The delay after a failure doubles per
// consecutive failure and caps at 15 minutes; any reply resets the ladder.
export const GIT_STATUS_BACKOFF_BASE_MS = 60_000
export const GIT_STATUS_BACKOFF_MAX_MS = 900_000

type PollerClient = Pick<HoustonClient, 'subscribe' | 'gitStatus'>

/** One rung per consecutive failure: 60 s, 120 s, 240 s, 480 s, then the 15 min cap. */
export function gitStatusBackoffDelayMs(failures: number): number {
  return Math.min(GIT_STATUS_BACKOFF_BASE_MS * 2 ** (failures - 1), GIT_STATUS_BACKOFF_MAX_MS)
}

export interface GitStatusPoller {
  /** Queues each directory unless it awaits a reply, is queued, or is backing off. */
  request(dirs: readonly string[]): void
  /** Queues each directory, honouring only the in-flight and queued guards; for
   * user-initiated refreshes, which a failure ladder must never delay. */
  requestNow(dirs: readonly string[]): void
  /** Forgets queued directories; requests already sent keep their slot until they resolve. */
  dropQueued(): void
  dispose(): void
}

export function createGitStatusPoller(
  client: PollerClient,
  limit: number = GIT_STATUS_IN_FLIGHT_LIMIT,
  timeoutMs: number = GIT_STATUS_REPLY_TIMEOUT_MS,
): GitStatusPoller {
  const inFlight = new Map<string, ReturnType<typeof setTimeout>>()
  const queue: string[] = []
  const failures = new Map<string, number>()
  const nextAttemptAt = new Map<string, number>()
  let disposed = false

  const markFailure = (dir: string): void => {
    const count = (failures.get(dir) ?? 0) + 1
    failures.set(dir, count)
    nextAttemptAt.set(dir, Date.now() + gitStatusBackoffDelayMs(count))
  }
  const markSuccess = (dir: string): void => {
    failures.delete(dir)
    nextAttemptAt.delete(dir)
  }
  const backingOff = (dir: string): boolean => {
    const at = nextAttemptAt.get(dir)
    return at !== undefined && Date.now() < at
  }

  const pump = (): void => {
    while (!disposed && inFlight.size < limit && queue.length > 0) {
      const dir = queue.shift() as string
      inFlight.set(dir, setTimeout(() => {
        markFailure(dir)
        release(dir)
      }, timeoutMs))
      client.gitStatus(dir, null)
    }
  }
  const release = (dir: string): void => {
    const timer = inFlight.get(dir)
    if (timer === undefined) return
    clearTimeout(timer)
    inFlight.delete(dir)
    pump()
  }

  const offStatus = client.subscribe('git_status', (message) => {
    if (message.base != null) return
    markSuccess(message.dir)
    release(message.dir)
  })
  // git_status failures carry the context but not the directory: the oldest
  // request is the likeliest to have failed, and the timeout covers a wrong guess.
  const offError = client.subscribe('error', (message) => {
    if (message.context !== 'git_status') return
    const oldest = inFlight.keys().next()
    if (!oldest.done) {
      markFailure(oldest.value)
      release(oldest.value)
    }
  })

  return {
    request(dirs) {
      for (const dir of dirs) {
        if (inFlight.has(dir) || queue.includes(dir) || backingOff(dir)) continue
        queue.push(dir)
      }
      pump()
    },
    requestNow(dirs) {
      for (const dir of dirs) {
        if (!inFlight.has(dir) && !queue.includes(dir)) queue.push(dir)
      }
      pump()
    },
    dropQueued() {
      queue.length = 0
    },
    dispose() {
      disposed = true
      offStatus()
      offError()
      for (const timer of inFlight.values()) clearTimeout(timer)
      inFlight.clear()
      queue.length = 0
      failures.clear()
      nextAttemptAt.clear()
    },
  }
}
