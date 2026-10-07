import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionInfo, HoustonClient } from './houston/client'

interface UseProactiveDiffOptions {
  client: HoustonClient | null
  enabled: boolean
  activeIdRef: { current: number | null }
  sessionsRef: { current: ReadonlyMap<number, SessionInfo> }
  setScmOpen: (open: boolean) => void
  setActiveSurface: (surface: 'grid' | 'side') => void
}

export function useProactiveDiff({ client, enabled, activeIdRef, sessionsRef, setScmOpen, setActiveSurface }: UseProactiveDiffOptions) {
  const [request, setRequest] = useState<{ id: number; hasDiff: boolean; userUntouched: boolean }>()
  const sequence = useRef(0)
  const panelUserActionCount = useRef(0)
  const turnActionCount = useRef(new Map<number, number>())
  const pendingProbe = useRef<{ dir: string; session: number; startedAt: number; userActionCount: number; turnActionCount: number } | null>(null)

  const onUserActionCounterChange = useCallback((count: number): void => {
    panelUserActionCount.current = count
  }, [])

  useEffect(() => {
    if (!client) return
    const stopAgentStatus = client.subscribe('agent_status', (message) => {
      if (message.status === 'working') {
        turnActionCount.current.set(message.session, panelUserActionCount.current)
        return
      }
      if (message.status !== 'idle') return
      const turnStartedAtCount = turnActionCount.current.get(message.session)
      turnActionCount.current.delete(message.session)
      if (!enabled || turnStartedAtCount === undefined || activeIdRef.current !== message.session) return
      const session = sessionsRef.current.get(message.session)
      if (!session) return
      const userActionCount = panelUserActionCount.current
      pendingProbe.current = {
        dir: session.project_dir,
        session: message.session,
        startedAt: Date.now(),
        userActionCount,
        turnActionCount: turnStartedAtCount,
      }
      client.gitStatus(session.project_dir)
    })
    const stopGitStatus = client.subscribe('git_status', (message) => {
      const pending = pendingProbe.current
      if (!pending || message.dir !== pending.dir) return
      pendingProbe.current = null
      if (Date.now() - pending.startedAt > 10_000 || message.files.length === 0) return
      const userUntouched = pending.userActionCount === pending.turnActionCount && panelUserActionCount.current === pending.userActionCount
      setRequest({ id: ++sequence.current, hasDiff: true, userUntouched })
      if (userUntouched && activeIdRef.current === pending.session) {
        setScmOpen(true)
        setActiveSurface('side')
      }
    })
    return () => {
      stopAgentStatus()
      stopGitStatus()
    }
  }, [activeIdRef, client, enabled, sessionsRef, setActiveSurface, setScmOpen])

  return { request, onUserActionCounterChange }
}
