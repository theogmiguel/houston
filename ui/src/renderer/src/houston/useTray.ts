import { useEffect, useRef } from 'react'
import { daemonShutdown } from './manage'
import type { SessionInfo } from './generated/SessionInfo'
import type { Workspace } from './generated/Workspace'
import {
  appQuit,
  buildTrayPayload,
  createTraySync,
  onTrayEvent,
  syncTray,
  TRAY_EVENT_FOCUS_PANE,
  TRAY_EVENT_STOP_DAEMON,
  updateTrayActivity,
  type TrayActivity,
  type TrayConnection,
  type TraySyncer
} from './tray'

function stopDaemonThenQuit(): void {
  void daemonShutdown()
    .catch((err: unknown) => {
      console.warn(
        'houston: daemon_shutdown from the tray failed, quitting without stopping it',
        err
      )
    })
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
    void onTrayEvent<null>(TRAY_EVENT_STOP_DAEMON, stopDaemonThenQuit).then(track)
    return () => {
      disposed = true
      for (const off of unlisten) off()
    }
  }, [])
}
