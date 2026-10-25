import type { HoustonClient } from './client'
import { createBoundedPoller, type BoundedPoller } from './boundedPoller'

// inbox_list is a database read that replies in milliseconds, so 2 in flight drains a
// burst over every workspace quickly and leaves the connection's control slots to git
// work (rail and overview git_status, branch chips) and user actions.
export const INBOX_LIST_IN_FLIGHT_LIMIT = 2

// A failed inbox_list carries no context and a refused one never replies; 30 s matches
// the git pollers.
export const INBOX_LIST_REPLY_TIMEOUT_MS = 30_000

type InboxClient = Pick<HoustonClient, 'subscribe' | 'inboxList'>

const pollers = new WeakMap<InboxClient, BoundedPoller>()

/** Asks for each workspace's inbox rows. Every surface on a connection shares one bound,
 *  and a workspace already queued or in flight is not asked twice: its reply reaches
 *  every `inbox_rows` subscriber. */
export function requestInboxLists(client: InboxClient, workspaces: Iterable<string>): void {
  let poller = pollers.get(client)
  if (poller === undefined) {
    poller = createBoundedPoller(client, {
      send: (workspace) => client.inboxList(workspace),
      replies: (settle) => client.subscribe('inbox_rows', (message) => settle(message.workspace)),
    }, INBOX_LIST_IN_FLIGHT_LIMIT, INBOX_LIST_REPLY_TIMEOUT_MS)
    pollers.set(client, poller)
  }
  poller.request([...workspaces])
}
