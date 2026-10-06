import { useEffect, useMemo } from 'react'
import type { HoustonClient, SessionInfo } from '../../houston/client'
import { rememberRailGitFacts } from './railGitCache'
import { useRailGitFacts } from './useRailGitFacts'

// Only running sessions are polled: an ended session's worktree may already be removed,
// and polling it would raise a daemon error on every refresh. Its last totals stay cached.
export function railGitDirs(sessions: readonly SessionInfo[]): string[] {
  return [...new Set(sessions
    .filter((session) => session.agent !== 'ssh' && session.state === 'running')
    .map((session) => session.worktree?.path ?? session.checkout_root ?? session.cwd))]
}

export function GridRailGitSubscription({ client, sessions }: { client: HoustonClient | null; sessions: SessionInfo[] }): null {
  const dirs = useMemo(() => railGitDirs(sessions), [sessions])
  const facts = useRailGitFacts(client, dirs)
  useEffect(() => rememberRailGitFacts(facts), [facts])
  return null
}
