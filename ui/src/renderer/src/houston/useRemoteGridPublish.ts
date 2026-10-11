import { useEffect } from 'react'
import type { HoustonClient } from './client'
import type { RemoteGrid } from './generated/RemoteGrid'
import { onGridsSaved, savedGrids } from '../layout/tree'

// A drag or a burst of splits writes the layout many times; one publish covers it.
const PUBLISH_DEBOUNCE_MS = 400

/** Keeps the daemon's copy of the grids current, so paired devices group panes
 *  as the desktop does. Publishes on every connection and after layout saves. */
export function useRemoteGridPublish(client: HoustonClient | null): void {
  useEffect(() => {
    if (!client) return
    let last = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const publish = (): void => {
      const grids: RemoteGrid[] = savedGrids()
      const key = JSON.stringify(grids)
      if (key === last) return
      last = key
      client.remoteGridsPublish(grids)
    }
    publish()
    const off = onGridsSaved(() => {
      clearTimeout(timer)
      timer = setTimeout(publish, PUBLISH_DEBOUNCE_MS)
    })
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [client])
}
