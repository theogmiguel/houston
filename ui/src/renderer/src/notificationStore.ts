export interface NotificationInput {
  session?: number
  agentId?: string | number
  kind: string
  title: string
  dir: string
  text: string
  read?: boolean
}

export interface NotificationRecord {
  id: number
  session: number
  agentId?: string | number
  kind: string
  title: string
  dir: string
  text: string
  time: number
  read: boolean
}

const COOLDOWN_MS = 5000
const MAX_RETAINED = 200

let seq = 0
const retained: NotificationRecord[] = []
const lastByKey = new Map<string, { hash: string; time: number }>()

function keyOf(input: NotificationInput): string {
  return `${input.session ?? input.agentId}::${input.kind}`
}

function hashOf(input: NotificationInput): string {
  return `${input.title}|${input.text}`
}

export function addNotification(
  input: NotificationInput,
  now: number = Date.now()
): NotificationRecord | null {
  const key = keyOf(input)
  const hash = hashOf(input)
  const last = lastByKey.get(key)
  if (last && last.hash === hash && now - last.time < COOLDOWN_MS) return null
  lastByKey.set(key, { hash, time: now })

  const record: NotificationRecord = {
    ...input,
    session: input.session ?? 0,
    id: ++seq,
    time: now,
    read: input.read ?? false
  }
  retained.unshift(record)
  retained.length = Math.min(retained.length, MAX_RETAINED)

  for (const [k, v] of lastByKey) {
    if (now - v.time >= COOLDOWN_MS) lastByKey.delete(k)
  }

  return record
}

export function getNotifications(): readonly NotificationRecord[] {
  return retained
}

export function resetNotificationStoreForTests(): void {
  seq = 0
  retained.length = 0
  lastByKey.clear()
}

export function getDedupeKeyCountForTests(): number {
  return lastByKey.size
}
