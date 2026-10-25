import type { HoustonClient } from '../../houston/client'
import { backoffDelayMs, createBoundedPoller, type BoundedPoller } from '../../houston/boundedPoller'

// The daemon admits 16 control handlers per connection and each git_status runs 2-4
// git subprocesses, so a rail of 16+ checkouts must not fire them all at once.
// 4 keeps the rail refresh well under that cap and leaves room for user actions.
export const GIT_STATUS_IN_FLIGHT_LIMIT = 4

// An error reply names no directory and a refused request never replies, so a slot
// can outlive its request. 30 s covers the slowest measured round trip (22.5 s under
// load) and bounds how long a lost reply can hold a slot.
export const GIT_STATUS_REPLY_TIMEOUT_MS = 30_000

// The rail tick re-requests a failing directory every beat, so a broken repo keeps
// paying 2-4 git subprocesses per minute. The delay after a failure doubles per
// consecutive failure and caps at 15 minutes; any reply resets the ladder.
export const GIT_STATUS_BACKOFF_BASE_MS = 60_000
export const GIT_STATUS_BACKOFF_MAX_MS = 900_000

/** One rung per consecutive failure: 60 s, 120 s, 240 s, 480 s, then the 15 min cap. */
export function gitStatusBackoffDelayMs(failures: number): number {
  return backoffDelayMs({ baseMs: GIT_STATUS_BACKOFF_BASE_MS, maxMs: GIT_STATUS_BACKOFF_MAX_MS }, failures)
}

export type GitStatusPoller = BoundedPoller

export function createGitStatusPoller(
  client: Pick<HoustonClient, 'subscribe' | 'gitStatus'>,
  limit: number = GIT_STATUS_IN_FLIGHT_LIMIT,
  timeoutMs: number = GIT_STATUS_REPLY_TIMEOUT_MS,
): GitStatusPoller {
  return createBoundedPoller(client, {
    send: (dir) => client.gitStatus(dir, null),
    replies: (settle) => client.subscribe('git_status', (message) => {
      if (message.base == null) settle(message.dir)
    }),
    errorContext: 'git_status',
    backoff: { baseMs: GIT_STATUS_BACKOFF_BASE_MS, maxMs: GIT_STATUS_BACKOFF_MAX_MS },
  }, limit, timeoutMs)
}
