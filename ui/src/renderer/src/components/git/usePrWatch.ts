import { useEffect, useState } from 'react'
import type { PrWatchInfo } from '../../houston/generated/PrWatchInfo'
import type { HoustonClient } from '../../houston/client'

export function usePrWatch(client: HoustonClient | null, session: number | null): PrWatchInfo[] {
  const [watches, setWatches] = useState<PrWatchInfo[]>([])
  useEffect(() => {
    setWatches([])
    if (
      !client ||
      session == null ||
      typeof client.subscribe !== 'function' ||
      typeof client.send !== 'function'
    ) {
      return
    }
    const apply = (forSession: number, next: PrWatchInfo[]): void => {
      if (forSession === session) setWatches(next)
    }
    const offList = client.subscribe('pr_watch_list', (message) => {
      apply(session, message.watches.find((item) => item.session === session)?.watches ?? [])
    })
    const offChanged = client.subscribe('pr_watch_changed', (message) => apply(message.session, message.watches))
    client.send({ type: 'pr_watch_list' })
    return () => { offList(); offChanged() }
  }, [client, session])
  return watches
}
