import type { SessionInfo } from '../houston/client'

export function collapseHome(path: string): string {
  return path.replace(/^\/(home|Users)\/[^/]+/, '~')
}

/** One plain sentence for why the daemon left a session as a husk. */
export function restoreReasonSentence(info: Pick<SessionInfo, 'restore_deferred' | 'cwd'>): string | null {
  switch (info.restore_deferred) {
    case 'invalid-cwd': return `The folder ${collapseHome(info.cwd)} no longer exists.`
    case 'ssh': return 'SSH sessions are not restored automatically.'
    case 'budget': return 'Too many sessions were restoring at startup, so this one was held back.'
    case 'previous-crash': return 'Houston ended unexpectedly last time, so this session was not restarted automatically.'
    case 'safe-mode': return 'Safe mode skipped automatic restore.'
    case 'spawn-failed': return 'The agent could not be started.'
    default: return null
  }
}

/** Everything the daemon recorded about why a pane was not resumed, or null when it recorded nothing. */
export function recoveryReason(info: Pick<SessionInfo, 'restore_deferred' | 'cwd' | 'resume_notice'>): string | null {
  const parts = [restoreReasonSentence(info), info.resume_notice].filter((part): part is string => !!part)
  return parts.length > 0 ? parts.join(' ') : null
}
