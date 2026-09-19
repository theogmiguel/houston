import { getHostConfig } from './host'

export const MANAGE_VERSION = 1

export interface ManageLiveSessions {
  count: number
  ids: number[]
}

export interface ManageHandoff {
  supported: boolean
  reason: string
}

export interface ManageReap {
  armed: boolean
  deadline_ms: number | null
}

export interface DaemonStatus {
  manage_version: number
  protocol_version: number
  build: string
  pid: number
  started_at: string
  live_sessions: ManageLiveSessions
  routines_enabled: number
  clients_connected: number
  handoff: ManageHandoff
  reap: ManageReap
}

export interface DaemonShutdownOk {
  ok: true
  stopped_sessions: number
  disarmed_routines: number
}

export class ManageError extends Error {}

type Verb = 'daemon_status' | 'daemon_shutdown'

async function manageRequest<T>(verb: Verb): Promise<T> {
  const { port, token } = await getHostConfig()
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${port}/manage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ manage_version: MANAGE_VERSION, verb })
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ManageError(
      `Could not reach the daemon's management endpoint at 127.0.0.1:${port}/manage: ${message}`
    )
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }
  const errorField =
    body !== null && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
      ? (body as { error: string }).error
      : null
  if (!res.ok) throw new ManageError(errorField ?? `Daemon management request failed: HTTP ${res.status}`)
  if (errorField !== null) throw new ManageError(errorField)
  return body as T
}

export function daemonStatus(): Promise<DaemonStatus> {
  return manageRequest<DaemonStatus>('daemon_status')
}

export function daemonShutdown(): Promise<DaemonShutdownOk> {
  return manageRequest<DaemonShutdownOk>('daemon_shutdown')
}
