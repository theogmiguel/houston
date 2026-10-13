import type { SessionInfo } from '../../houston/client'

export function doingNow(session: SessionInfo): string | null {
  const activity = session.activity
  if (session.status === 'needs-input' && activity?.question?.trim()) return activity.question.trim()
  return activity?.last_message?.trim() || activity?.prompt?.trim() || null
}
