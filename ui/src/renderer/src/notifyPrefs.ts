import type { NoticeSeverity } from './components/noticeSeverity'

export const NOTIFY_KINDS_KEY = 'tr-notify-kinds'

export type NotifyKinds = Record<NoticeSeverity, boolean>

export const NOTIFY_KINDS_DEFAULT: NotifyKinds = {
  completed: true,
  error: true,
  'needs-input': true,
  info: true
}

export const NOTIFY_KIND_ROWS: { kind: NoticeSeverity; label: string; desc: string }[] = [
  {
    kind: 'needs-input',
    label: 'Agent needs input',
    desc: 'A permission prompt or a question — the one you usually want'
  },
  { kind: 'error', label: 'Errors', desc: 'A session or swarm agent failed' },
  { kind: 'completed', label: 'Completions', desc: 'An agent or swarm finished its work' },
  { kind: 'info', label: 'Other updates', desc: 'Everything else that reaches the inbox' }
]

export function loadNotifyKinds(): NotifyKinds {
  try {
    const raw = localStorage.getItem(NOTIFY_KINDS_KEY)
    if (!raw) return { ...NOTIFY_KINDS_DEFAULT }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...NOTIFY_KINDS_DEFAULT }
    const out = { ...NOTIFY_KINDS_DEFAULT }
    for (const k of Object.keys(NOTIFY_KINDS_DEFAULT) as NoticeSeverity[]) {
      const v = (parsed as Record<string, unknown>)[k]
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    return { ...NOTIFY_KINDS_DEFAULT }
  }
}

export function saveNotifyKinds(kinds: NotifyKinds): void {
  try {
    localStorage.setItem(NOTIFY_KINDS_KEY, JSON.stringify(kinds))
  } catch {
  }
}

export function notifyAllowed(
  master: boolean,
  kinds: NotifyKinds,
  severity: NoticeSeverity
): boolean {
  return master && kinds[severity] !== false
}
