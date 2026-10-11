import { useEffect, useRef } from 'react'
import type { SessionInfo } from './generated/SessionInfo'
import type { Workspace } from './generated/Workspace'
import {
  appStopDaemonsAndQuit,
  buildTrayPayload,
  createTraySync,
  NOTIFICATION_EVENT_FOCUS_PANE,
  onTrayEvent,
  syncTray,
  TRAY_EVENT_FOCUS_PANE,
  updateTrayActivity,
  type TrayActivity,
  type TrayConnection,
  type TraySyncer
} from './tray'

/** The command palette confirms before handing shutdown to the native host. */
export function stopDaemonThenQuit(): void {
  void appStopDaemonsAndQuit().catch((err: unknown) => {
    console.warn('houston: native shutdown request failed', err)
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
    return () => {
      disposed = true
      for (const off of unlisten) off()
    }
  }, [])
}
