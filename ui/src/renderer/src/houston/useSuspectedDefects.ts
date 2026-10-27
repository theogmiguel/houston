import { useEffect, useState } from 'react'
import type { HoustonClient } from './client'
import type { SuspectedDefect } from './generated/SuspectedDefect'

export interface SuspectedDefects {
  defects: SuspectedDefect[]
  loaded: boolean
}

/** A workspace's suspected defects; every record, decision or filing arrives as
 *  a `suspected_defects` broadcast, so the list never needs polling. */
export function useSuspectedDefects(
  client: HoustonClient | null,
  workspace: string | null
): SuspectedDefects {
  const [state, setState] = useState<{ workspace: string; defects: SuspectedDefect[] } | null>(null)

  useEffect(() => {
    setState(null)
    if (!client || !workspace) return
    const offDefects = client.subscribe('suspected_defects', (msg) => {
      if (msg.workspace === workspace) setState({ workspace, defects: msg.defects })
    })
    client.defectsGet(workspace)
    return offDefects
  }, [client, workspace])

  if (state?.workspace !== workspace) return { defects: [], loaded: false }
  return { defects: state.defects, loaded: true }
}
