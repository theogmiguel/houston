import type { HoustonClient } from '../../houston/client'
import { createBoundedPoller, type BoundedPoller } from '../../houston/boundedPoller'

// The daemon admits 16 control handlers per connection and each git_status runs
// ~6 git subprocesses, so a rail of 16+ checkouts must not fire them all at once.
// 4 keeps the rail refresh well under that cap and leaves room for user actions.
export const GIT_STATUS_IN_FLIGHT_LIMIT = 4

// An error reply names no directory and a refused request never replies, so a slot
// can outlive its request. 30 s covers the slowest measured round trip (22.5 s under
// load) and bounds how long a lost reply can hold a slot.
export const GIT_STATUS_REPLY_TIMEOUT_MS = 30_000

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
  }, limit, timeoutMs)
}
