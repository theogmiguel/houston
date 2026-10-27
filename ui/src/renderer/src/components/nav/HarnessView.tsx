import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { HarnessAttention } from '../../houston/generated/HarnessAttention'
import { useHarness } from '../../houston/useHarness'
import { useSuspectedDefects } from '../../houston/useSuspectedDefects'
import { HarnessSurface } from './HarnessSurface'
import { DefectIssueDrawer } from './DefectIssueDrawer'
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
  attentionRows,
  embedded = false,
  onOpenRoutines
}: {
  client: HoustonClient | null
  embedded?: boolean
  onOpenRoutines?: () => void
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
  const [issueKey, setIssueKey] = useState<string | null>(null)
  const { state, report, reportError, loadReport } = useHarness(client, workspace)
  const { defects } = useSuspectedDefects(client, workspace)
  const routineId = state?.routine?.id ?? null

  useEffect(() => {
    setWorkspace(selectedWorkspace === 'all' ? null : selectedWorkspace)
  }, [selectedWorkspace])

  useEffect(() => {
    setIssueKey(null)
  }, [workspace])

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
    <>
      <HarnessSurface
        embedded={embedded}
        onOpenRoutines={onOpenRoutines}
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
        defects={defects}
        onDecideDefect={(key, decision) => {
          if (client && workspace) client.defectDecide(workspace, key, decision)
        }}
        onOpenDefectIssue={setIssueKey}
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
      <DefectIssueDrawer
        client={client}
        defect={issueKey === null ? null : defects.find((defect) => defect.key === issueKey) ?? null}
        onClose={() => setIssueKey(null)}
      />
    </>
  )
}
