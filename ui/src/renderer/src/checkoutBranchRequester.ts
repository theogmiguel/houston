// Bounds the `git_branch` requests the renderer has in flight. Each runs git
// subprocesses in a daemon control slot (16 per connection, shared with every other
// request), and a reconnect or spawn burst asks for one per pane directory.

import type { HoustonClient } from './houston/client'

// Well below the daemon's 16 slots per connection, leaving room for git_status (4),
// pr_status and user actions that share them.
export const GIT_BRANCH_IN_FLIGHT_LIMIT = 4

// A refused or lost request never replies. 30 s matches the git_status poller: it
// covers the slowest measured round trip (22.5 s under load).
export const GIT_BRANCH_REPLY_TIMEOUT_MS = 30_000

// A refusal means the connection is saturated; retrying at once would refuse again.
// 0.5 s doubling to 8 s lets in-flight git work drain, and 5 attempts bound the
// retries (about 15 s of backoff) before the chip is left to the next focus refresh.
export const GIT_BRANCH_RETRY_BASE_MS = 500
export const GIT_BRANCH_RETRY_MAX_MS = 8_000
export const GIT_BRANCH_MAX_ATTEMPTS = 5

type Target = Pick<HoustonClient, 'gitBranch'>
type Phase = 'queued' | 'in_flight' | 'backoff'

interface Entry {
  target: Target
  phase: Phase
  failures: number
  timer: ReturnType<typeof setTimeout> | null
}

export interface CheckoutBranchRequester {
  /** Asks for a directory's branch unless that directory already awaits an answer. */
  request(target: Target, dir: string): void
  /** The directory was answered: it frees its slot and ends any retry. */
  settle(dir: string): void
  /** The daemon refused the directory's request: free the slot and retry after a backoff. */
  refused(dir: string): void
  has(dir: string): boolean
  /** Forgets every request, as a replaced connection does. */
  reset(): void
}

export function createCheckoutBranchRequester(
  onGiveUp: (dir: string) => void,
  limit: number = GIT_BRANCH_IN_FLIGHT_LIMIT,
  timeoutMs: number = GIT_BRANCH_REPLY_TIMEOUT_MS,
  retryBaseMs: number = GIT_BRANCH_RETRY_BASE_MS,
  maxAttempts: number = GIT_BRANCH_MAX_ATTEMPTS,
): CheckoutBranchRequester {
  const entries = new Map<string, Entry>()
  const queue: string[] = []
  let inFlight = 0

  const clear = (entry: Entry): void => {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
  }
  const drop = (dir: string): void => {
    const entry = entries.get(dir)
    if (!entry) return
    clear(entry)
    if (entry.phase === 'in_flight') inFlight -= 1
    if (entry.phase === 'queued') queue.splice(queue.indexOf(dir), 1)
    entries.delete(dir)
  }
  const pump = (): void => {
    while (inFlight < limit && queue.length > 0) {
      const dir = queue.shift() as string
      const entry = entries.get(dir) as Entry
      entry.phase = 'in_flight'
      inFlight += 1
      entry.timer = setTimeout(() => fail(dir), timeoutMs)
      entry.target.gitBranch(dir)
    }
  }
  const fail = (dir: string): void => {
    const entry = entries.get(dir)
    if (entry?.phase !== 'in_flight') return
    clear(entry)
    inFlight -= 1
    entry.failures += 1
    if (entry.failures >= maxAttempts) {
      entries.delete(dir)
      onGiveUp(dir)
    } else {
      entry.phase = 'backoff'
      entry.timer = setTimeout(() => {
        entry.timer = null
        entry.phase = 'queued'
        queue.push(dir)
        pump()
      }, Math.min(retryBaseMs * 2 ** (entry.failures - 1), GIT_BRANCH_RETRY_MAX_MS))
    }
    pump()
  }

  return {
    request(target, dir) {
      if (entries.has(dir)) return
      entries.set(dir, { target, phase: 'queued', failures: 0, timer: null })
      queue.push(dir)
      pump()
    },
    settle(dir) {
      drop(dir)
      pump()
    },
    refused: fail,
    has: (dir) => entries.has(dir),
    reset() {
      for (const entry of entries.values()) clear(entry)
      entries.clear()
      queue.length = 0
      inFlight = 0
    },
  }
}
