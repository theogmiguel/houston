import type { NoticeRingTone } from './components/SessionPane'
import { severityForNotice, type NoticeSeverity } from './components/noticeSeverity'
import type { NotificationRecord } from './notificationStore'

export interface Notice {
  id: number
  session: number
  title: string
  dir: string
  text: string
  time: number
  read: boolean
  ringTone?: NoticeRingTone
  severity: NoticeSeverity
}

export function toNotice(rec: NotificationRecord, agentKind?: string): Notice {
  return { ...rec, severity: severityForNotice(rec.kind, agentKind) }
}

export function fmtAgo(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export interface NoticeSection {
  title: string
  needsYou: boolean
  notices: Notice[]
}

export function startOfDay(now: number = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function groupNotices(notices: Notice[], now: number = Date.now()): NoticeSection[] {
  const midnight = startOfDay(now)
  const waiting = (n: Notice): boolean => !n.read && n.severity === 'needs-input'
  const rest = notices.filter((n) => !waiting(n))
  return [
    { title: 'Needs you', needsYou: true, notices: notices.filter(waiting) },
    { title: 'Today', needsYou: false, notices: rest.filter((n) => n.time >= midnight) },
    { title: 'Earlier', needsYou: false, notices: rest.filter((n) => n.time < midnight) }
  ].filter((s) => s.notices.length > 0)
}
