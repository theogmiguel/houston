import { useCallback, useEffect, useState } from 'react'
import type { Conn } from '../../App'
import { showItemInFolder } from '../../houston/bridge'
import { setRailView } from '../../railView'
import type { HoustonClient } from '../../houston/client'
import type { AgentKind } from '../../houston/generated/AgentKind'
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
  liveSessions,
  onOpenSession,
  onOpenFile,
  onReveal,
  onPrepareFix
}: {
  client: HoustonClient | null
  workspaces: { id: string; name: string }[]
  /** The app's selected workspace, or `all` when none is. */
  selectedWorkspace: string
  routinesRunning: number[]
  liveSessions: { has(id: number): boolean }
  onOpenSession: (sessionId: number) => void
  onOpenFile: (workspace: string, path: string) => void
  onReveal: (path: string) => void
  onPrepareFix: (workspace: string, engine: AgentKind, prompt: string) => void
}): React.JSX.Element {
  const [workspace, setWorkspace] = useState<string | null>(
    selectedWorkspace === 'all' ? null : selectedWorkspace
  )
  const [error, setError] = useState<string | null>(null)
  const { state, report, reportError, loadReport } = useHarness(client, workspace)
  const routineId = state?.routine?.id ?? null

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
      liveSessions={liveSessions}
      onCreateRoutine={(v) => {
        if (client && workspace) client.harnessRoutineCreate({ workspace, ...v })
      }}
      onUpdateRoutine={({ id, expected_revision, ...patch }) =>
        client?.routineUpdate(id, expected_revision, patch)
      }
      onRunNow={(id) => client?.routineRunNow(id)}
      onDecide={(key, next) => {
        if (client && workspace) client.harnessDecide(workspace, key, next)
      }}
      onLoadReport={loadReport}
      onOpenSession={onOpenSession}
      onOpenFile={(path) => {
        if (workspace) onOpenFile(workspace, path)
      }}
      onReveal={onReveal}
      onPrepareFix={(engine, prompt) => {
        if (workspace) onPrepareFix(workspace, engine, prompt)
      }}
    />
  )
}

/// What the Harness view asks of the rest of the app: open a file in an editor
/// leaf, show one in the file manager, or open an agent pane with a prompt,
/// each in the reviewed workspace, which it brings into view.
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
  spawnFix: (workspace: string, engine: AgentKind, prompt: string) => void
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
    spawnFix: useCallback(
      (workspace: string, engine: AgentKind, prompt: string) => {
        if (!client) return
        setRailView(null)
        showWorkspace(workspace)
        client.createSession({ agent: engine, project_dir: workspace, prompt })
      },
      [client, showWorkspace]
    )
  }
}
