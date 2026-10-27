import type { HoustonClient } from './client'
import { createBoundedPoller, type BoundedPoller } from './boundedPoller'

// These reads are database lookups that reply in milliseconds, so 2 in flight drains a
// mount burst and leaves the connection's other control slots to git work and user actions.
export const SHARED_LIST_IN_FLIGHT_LIMIT = 2
export const SHARED_LIST_REPLY_TIMEOUT_MS = 30_000

type SharedClient = Pick<HoustonClient, 'subscribe' | 'send' | 'mergeQueueGet' | 'mergeQueueSummaryGet'>

const PR_WATCH_KEY = 'pr_watch_list'
const MERGE_SUMMARY_KEY = 'merge_queue_summary'
const MERGE_QUEUE_PREFIX = 'merge_queue:'

const pollers = new WeakMap<SharedClient, BoundedPoller>()

function pollerOf(client: SharedClient): BoundedPoller {
  let poller = pollers.get(client)
  if (poller === undefined) {
    poller = createBoundedPoller(client, {
      send: (key) => {
        if (key === PR_WATCH_KEY) client.send({ type: 'pr_watch_list' })
        else if (key === MERGE_SUMMARY_KEY) client.mergeQueueSummaryGet()
        else client.mergeQueueGet(key.slice(MERGE_QUEUE_PREFIX.length))
      },
      replies: (settle) => {
        const offs = [
          client.subscribe('pr_watch_list', () => settle(PR_WATCH_KEY)),
          client.subscribe('merge_queue_summary', () => settle(MERGE_SUMMARY_KEY)),
          client.subscribe('merge_queue', (message) => settle(`${MERGE_QUEUE_PREFIX}${message.dir}`)),
        ]
        return () => { for (const off of offs) off() }
      },
    }, SHARED_LIST_IN_FLIGHT_LIMIT, SHARED_LIST_REPLY_TIMEOUT_MS)
    pollers.set(client, poller)
  }
  return poller
}

/** Asks for every session's PR watches. The reply lists all sessions, so one request
 *  serves each `usePrWatch` mounted while it is outstanding. */
export function requestPrWatchList(client: SharedClient): void {
  pollerOf(client).request([PR_WATCH_KEY])
}

/** Asks for the merge queue of the workspace `dir` belongs to; one request per `dir`
 *  while its reply is outstanding. */
export function requestMergeQueue(client: SharedClient, dir: string): void {
  pollerOf(client).request([`${MERGE_QUEUE_PREFIX}${dir}`])
}

/** Asks for the parked counts of every workspace. */
export function requestMergeQueueSummary(client: SharedClient): void {
  pollerOf(client).request([MERGE_SUMMARY_KEY])
}
