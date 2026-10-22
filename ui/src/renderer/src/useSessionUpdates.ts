import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { HoustonClient } from './houston/client'
import type { SessionInfo } from './houston/generated/SessionInfo'

/** The daemon's whole new info for a listed session; an unlisted one is not added. */
export function replaceListedSession(sessions: Map<number, SessionInfo>, info: SessionInfo): Map<number, SessionInfo> {
  return sessions.has(info.id) ? new Map(sessions).set(info.id, info) : sessions
}

/** Applies `session_updated`, which the daemon sends when it changes a session's info
 *  outside its state and status messages, such as an export's transferred mark. */
export function useSessionUpdates(client: HoustonClient | null, setSessions: Dispatch<SetStateAction<Map<number, SessionInfo>>>): void {
  useEffect(() => {
    if (!client) return
    return client.subscribe('session_updated', (msg) => setSessions((prev) => replaceListedSession(prev, msg.info)))
  }, [client, setSessions])
}
