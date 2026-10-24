import { useEffect, useState } from 'react'
import type { HoustonClient } from '../houston/client'
import type { SessionView } from '../houston/generated/SessionView'

/** Settings ▸ Agents ▸ Default view, followed live; Terminal until the daemon answers. */
export function useDefaultView(client: HoustonClient | null): SessionView {
  const [view, setView] = useState<SessionView>('terminal')
  useEffect(() => {
    if (!client) return
    const off = client.subscribe('default_view', (message) => setView(message.view))
    client.send({ type: 'default_view_get' })
    return off
  }, [client])
  return view
}

/** The view a new session opens in: an explicit choice wins, and the default applies to Claude only. */
export function newSessionView(agent: string, chosen: SessionView | undefined, fallback: SessionView): SessionView {
  if (chosen) return chosen
  return agent === 'claude' ? fallback : 'terminal'
}
