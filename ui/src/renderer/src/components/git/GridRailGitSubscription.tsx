import { useEffect, useMemo } from 'react'
import type { HoustonClient, SessionInfo } from '../../houston/client'
import { rememberRailGitFacts } from './railGitCache'
import { useRailGitFacts } from './useRailGitFacts'

export function GridRailGitSubscription({ client, sessions }: { client: HoustonClient | null; sessions: SessionInfo[] }): null {
  const dirs = useMemo(
    () => [...new Set(sessions.filter((session) => session.agent !== 'ssh').map((session) => session.worktree?.path ?? session.checkout_root ?? session.cwd))],
    [sessions],
  )
  const facts = useRailGitFacts(client, dirs)
  useEffect(() => rememberRailGitFacts(facts), [facts])
  return null
}
