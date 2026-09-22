import type { SessionInfo } from './generated/SessionInfo'
import { isTauri } from './host'

export type TrayConnection = 'connecting' | 'ready' | 'reconnecting' | 'failed'

export type TrayStatus = 'running' | 'idle' | 'needsInput' | 'unknown' | 'done' | 'error'

export interface TraySessionPayload {
  id: number
  agent: string
  title: string
  status: TrayStatus
  needsInput: boolean
  workspace: string
}

export interface TraySyncPayload {
  connection: TrayConnection
  sessions: TraySessionPayload[]
}

export interface TrayStateView {
  available: boolean
  reason: string | null
  keepInTray: boolean
  hidesOnClose: boolean
}

export function trayStatusFor(session: SessionInfo): TrayStatus {
  switch (session.state) {
    case 'running':
      switch (session.status) {
        case 'needs-input':
          return 'needsInput'
        case 'idle':
          return 'idle'
        case 'unavailable':
          return 'unknown'
        default:
          return 'running'
      }
    case 'exited':
    case 'killed':
      return 'done'
    case 'interrupted':
      return 'error'
  }
}

export function traySessionPayload(
  session: SessionInfo,
  workspaceName: (projectDir: string) => string
): TraySessionPayload {
  const status = trayStatusFor(session)
  return {
    id: session.id,
    agent: session.detected_agent ?? session.agent,
    title: session.title,
    status,
    needsInput: status === 'needsInput',
    workspace: workspaceName(session.project_dir)
  }
}

export interface TrayActivity {
  status: TrayStatus
  at: number
}

export function updateTrayActivity(
  prev: ReadonlyMap<number, TrayActivity>,
  sessions: readonly SessionInfo[],
  now: number
): Map<number, TrayActivity> {
  const next = new Map<number, TrayActivity>()
  for (const session of sessions) {
    const status = trayStatusFor(session)
    const before = prev.get(session.id)
    next.set(session.id, before && before.status === status ? before : { status, at: now })
  }
  return next
}

export function orderForTray(
  sessions: readonly SessionInfo[],
  activity: ReadonlyMap<number, TrayActivity>
): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    const at = (activity.get(a.id)?.at ?? 0) - (activity.get(b.id)?.at ?? 0)
    return at !== 0 ? -at : b.id - a.id
  })
}

export function buildTrayPayload(
  connection: TrayConnection,
  sessions: readonly SessionInfo[],
  activity: ReadonlyMap<number, TrayActivity>,
  workspaceName: (projectDir: string) => string
): TraySyncPayload {
  return {
    connection,
    sessions: orderForTray(sessions, activity).map((s) => traySessionPayload(s, workspaceName))
  }
}

export const TRAY_SYNC_MIN_INTERVAL_MS = 250

export interface TraySyncer {
  sync(payload: TraySyncPayload): void
  dispose(): void
}

export function createTraySync(
  send: (payload: TraySyncPayload) => void,
  options: {
    minIntervalMs?: number
    now?: () => number
    setTimer?: (fn: () => void, ms: number) => number
    clearTimer?: (handle: number) => void
  } = {}
): TraySyncer {
  const interval = options.minIntervalMs ?? TRAY_SYNC_MIN_INTERVAL_MS
  const now = options.now ?? ((): number => Date.now())
  const setTimer = options.setTimer ?? ((fn, ms): number => window.setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle): void => window.clearTimeout(handle))

  let lastSentAt = Number.NEGATIVE_INFINITY
  let pending: TraySyncPayload | null = null
  let timer: number | null = null

  const fire = (payload: TraySyncPayload): void => {
    lastSentAt = now()
    send(payload)
  }

  return {
    sync(payload: TraySyncPayload): void {
      const elapsed = now() - lastSentAt
      if (elapsed >= interval && timer === null) {
        fire(payload)
        return
      }
      pending = payload
      if (timer !== null) return
      timer = setTimer(() => {
        timer = null
        const next = pending
        pending = null
        if (next !== null) fire(next)
      }, Math.max(0, interval - elapsed))
    },
    dispose(): void {
      if (timer !== null) clearTimer(timer)
      timer = null
      pending = null
    }
  }
}

export const TRAY_EVENT_FOCUS_PANE = 'tray://focus-pane'
export const TRAY_EVENT_STOP_DAEMON = 'tray://stop-daemon'

async function invoker(): Promise<
  <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke
}

export async function syncTray(payload: TraySyncPayload): Promise<void> {
  if (!isTauri()) return
  const invoke = await invoker()
  await invoke<void>('tray_sync', { payload })
}

export async function trayState(): Promise<TrayStateView | null> {
  if (!isTauri()) return null
  const invoke = await invoker()
  return invoke<TrayStateView>('tray_state', {})
}

export async function setKeepInTray(enabled: boolean): Promise<TrayStateView | null> {
  if (!isTauri()) return null
  const invoke = await invoker()
  return invoke<TrayStateView>('tray_set_keep_in_tray', { enabled })
}

export async function appQuit(): Promise<void> {
  if (!isTauri()) return
  const invoke = await invoker()
  await invoke<void>('app_quit', {})
}

export async function onTrayEvent<T>(
  event: string,
  handler: (payload: T) => void
): Promise<() => void> {
  if (!isTauri()) return () => {}
  try {
    const { listen } = await import('@tauri-apps/api/event')
    return await listen<T>(event, (e) => handler(e.payload))
  } catch (err) {
    console.warn(`houston: could not subscribe to the tray event ${event}`, err)
    return () => {}
  }
}
