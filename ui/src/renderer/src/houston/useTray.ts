import { useEffect, useRef } from 'react'
import { daemonShutdown } from './manage'
import { listEnvironments } from './environments'
import type { SessionInfo } from './generated/SessionInfo'
import type { Workspace } from './generated/Workspace'
import {
  appQuit,
  buildTrayPayload,
  createTraySync,
  NOTIFICATION_EVENT_FOCUS_PANE,
  onTrayEvent,
  syncTray,
  TRAY_EVENT_FOCUS_PANE,
  TRAY_EVENT_STOP_DAEMON,
  updateTrayActivity,
  type TrayActivity,
  type TrayConnection,
  type TraySyncer
} from './tray'

// Stops the local daemon and each WSL environment's (through its relay port) at
// once; a failure is logged and never keeps the others running or the app open.
async function stopEveryDaemon(): Promise<void> {
  const environments = await listEnvironments().catch((err: unknown) => {
    console.warn('houston: env_list failed, stopping only the local daemon', err)
    return []
  })
  const targets = [undefined, ...environments.filter((e) => e.kind === 'wsl' && e.token !== '')]
  const results = await Promise.allSettled(targets.map((target) => daemonShutdown(target)))
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.warn(
        `houston: daemon_shutdown from the tray failed for ${targets[i]?.id ?? 'local'}, quitting without stopping it`,
        result.reason
      )
    }
  })
}

function stopDaemonThenQuit(): void {
  void stopEveryDaemon()
    .finally(() => {
      void appQuit().catch((err: unknown) => {
        console.warn('houston: app_quit failed', err)
      })
    })
}

export function useTrayBridge(options: {
  connection: TrayConnection
  sessions: ReadonlyMap<number, SessionInfo>
  workspaces: readonly Workspace[]
  onFocusPane: (session: number) => void
}): void {
  const { connection, sessions, workspaces, onFocusPane } = options

  const focusPane = useRef(onFocusPane)
  focusPane.current = onFocusPane

  const workspacesRef = useRef(workspaces)
  workspacesRef.current = workspaces
  const workspaceName = (projectDir: string): string =>
    workspacesRef.current.find((w) => w.path === projectDir)?.name ?? projectDir

  const activity = useRef<Map<number, TrayActivity>>(new Map())
  const syncer = useRef<TraySyncer | null>(null)
  if (syncer.current === null) {
    syncer.current = createTraySync((payload) => {
      void syncTray(payload).catch((err: unknown) => {
        console.warn('houston: tray_sync failed', err)
      })
    })
  }

  useEffect(() => () => syncer.current?.dispose(), [])

  useEffect(() => {
    const live = [...sessions.values()]
    activity.current = updateTrayActivity(activity.current, live, Date.now())
    syncer.current?.sync(buildTrayPayload(connection, live, activity.current, workspaceName))
  }, [sessions, connection, workspaces])

  useEffect(() => {
    const unlisten: Array<() => void> = []
    let disposed = false
    const track = (off: () => void): void => {
      if (disposed) off()
      else unlisten.push(off)
    }
    void onTrayEvent<number>(TRAY_EVENT_FOCUS_PANE, (session) => {
      focusPane.current(session)
    }).then(track)
    void onTrayEvent<number>(NOTIFICATION_EVENT_FOCUS_PANE, (session) => {
      focusPane.current(session)
    }).then(track)
    void onTrayEvent<null>(TRAY_EVENT_STOP_DAEMON, stopDaemonThenQuit).then(track)
    return () => {
      disposed = true
      for (const off of unlisten) off()
    }
  }, [])
}
