import { useCallback, useEffect, useState } from 'react'
import type { Conn } from '../../App'
import { showItemInFolder } from '../../houston/bridge'
import { setRailView } from '../../railView'
import type { HoustonClient } from '../../houston/client'
import type { HarnessAttention } from '../../houston/generated/HarnessAttention'
import { useHarness } from '../../houston/useHarness'
import { HarnessSurface } from './HarnessSurface'
import { formatRoutineError } from './routineFormat'

/// The Harness rail view: owns the chosen workspace and talks to the daemon;
/// `HarnessSurface` only renders.
export function HarnessView({
  client,
  workspaces,
  selectedWorkspace,
  routinesRunning,
  onOpenFile,
  onReveal,
  attentionRows
}: {
  client: HoustonClient | null
  workspaces: { id: string; name: string }[]
  /** The app's selected workspace, or `all` when none is. */
  selectedWorkspace: string
  routinesRunning: number[]
  onOpenFile: (workspace: string, path: string) => void
  onReveal: (path: string) => void
  attentionRows: HarnessAttention[]
}): React.JSX.Element {
  const [workspace, setWorkspace] = useState<string | null>(
    selectedWorkspace === 'all' ? null : selectedWorkspace
  )
  const [error, setError] = useState<string | null>(null)
  const { state, report, reportError, loadReport } = useHarness(client, workspace)
  const routineId = state?.routine?.id ?? null

  useEffect(() => {
    setWorkspace(selectedWorkspace === 'all' ? null : selectedWorkspace)
  }, [selectedWorkspace])

  useEffect(() => {
    if (!client) return
    return client.subscribe('routine_refused', (msg) =>
      setError(
        formatRoutineError({
          id: msg.id ?? null,
          kind: msg.kind,
          limit: msg.limit ?? null,
          requested: msg.requested ?? null
        })
      )
    )
  }, [client])

  return (
    <HarnessSurface
      error={error}
      onDismissError={() => setError(null)}
      workspaces={workspaces}
      workspace={workspace}
      onWorkspace={(id) => {
        setError(null)
        setWorkspace(id)
      }}
      state={state}
      report={report}
      reportError={reportError}
      running={routineId !== null && routinesRunning.includes(routineId)}
      onCreateRoutine={(v) => {
        if (client && workspace) client.harnessRoutineCreate({ workspace, ...v })
      }}
      onRunNow={(id) => client?.routineRunNow(id)}
      onDecide={(key, next) => {
        if (client && workspace) client.harnessDecide(workspace, key, next)
      }}
      onLoadReport={loadReport}
      onOpenFile={(path) => {
        if (workspace) onOpenFile(workspace, path)
      }}
      onReveal={onReveal}
      attention={attentionRows.find((row) => row.workspace === workspace) ?? null}
      onSeen={(seenWorkspace, reviewId) => client?.harnessSeen(seenWorkspace, reviewId)}
      onCreateTask={(key, engine, prompt) => {
        if (workspace) client?.harnessFixTask(workspace, key, engine, prompt)
      }}
    />
  )
}

/// What the Harness view asks of the rest of the app: open a report file or show
/// it in the file manager, bringing the reviewed workspace into view.
export function useHarnessActions({
  conn,
  showWorkspace,
  openEditorFile,
  pushError
}: {
  conn: Conn
  showWorkspace: (dir: string) => void
  openEditorFile: (workspaceDir: string, path: string, anchor: null) => void
  pushError: (message: string) => void
}): {
  client: HoustonClient | null
  openFile: (workspace: string, path: string) => void
  reveal: (path: string) => void
} {
  const client = conn.kind === 'ready' ? conn.client : null
  return {
    client,
    openFile: useCallback(
      (workspace: string, path: string) => {
        setRailView(null)
        showWorkspace(workspace)
        openEditorFile(workspace, path, null)
      },
      [showWorkspace, openEditorFile]
    ),
    reveal: useCallback(
      (path: string) => {
        void showItemInFolder(path).then((res) => {
          if (!res.ok) pushError(res.error)
        })
      },
      [pushError]
    ),
  }
}
