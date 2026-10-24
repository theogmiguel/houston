import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { RoutineWorkspaceOption } from '../../houston/routineTypes'
import { useNightShift } from '../../houston/useNightShift'
import { Button, EmptyState, Notice, PageHeader, Segmented, Select, Text } from '../ui'
import { IconClock } from '../icons'
import { NightShiftLive } from './NightShiftLive'
import { NightShiftPreflight } from './NightShiftPreflight'
import { NightShiftReport } from './NightShiftReport'
import { NightShiftSetup } from './NightShiftSetup'
import { nightRunSections, resolveNightTab, timeOfDay, type NightTab } from './nightShiftFormat'
import { nightWorkspaceId, nightWorkspaceKnown, nightWorkspaceName } from '../../nightShiftNav'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { NightRun } from '../../houston/generated/NightRun'
import type { NightShiftReportText } from '../../houston/useNightShift'

/** Routines ▸ Built in ▸ Night shift, for one workspace at a time. */
export function NightShiftView({ client, workspaces, now, onOpenSession, initialWorkspace = null, initialRunId = null }: {
  client: HoustonClient | null
  workspaces: RoutineWorkspaceOption[]
  now: number
  onOpenSession: (session: number) => void
  /** A morning notice opens its run's report in its workspace. */
  initialWorkspace?: string | null
  initialRunId?: number | null
}): React.JSX.Element {
  const [workspace, setWorkspace] = useState<string | null>(nightWorkspaceId(initialWorkspace, workspaces))
  useEffect(() => {
    if (!nightWorkspaceKnown(workspace, workspaces)) setWorkspace(nightWorkspaceId(null, workspaces))
  }, [workspace, workspaces])
  const { state, preflight, report, error, actions } = useNightShift(client, workspace)
  const [tab, setTab] = useState<NightTab | null>(null)
  const [reportRun, setReportRun] = useState<number | null>(initialRunId)
  const [dialog, setDialog] = useState(false)
  const { live, finished, shown } = nightRunSections(state?.runs, reportRun)
  const current = resolveNightTab(tab, live, shown, initialRunId)
  useEffect(() => { if (live) setTab('live') }, [live?.run_id]) // eslint-disable-line react-hooks/exhaustive-deps

  const name = nightWorkspaceName(workspace, workspaces)
  const workers = state?.settings.workers.map((w) => w.provider) ?? []
  const header = (
    <NightShiftHeader state={state ?? null} live={live} name={name} onRunNow={() => setDialog(true)} />
  )
  const picker = workspaces.length > 1 && (
    <Select aria-label="Workspace" value={workspace ?? ''} options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
      onChange={(id) => { setWorkspace(id); setTab(null); setReportRun(null) }} />
  )

  if (!client || workspaces.length === 0) {
    return <div className="grid gap-[var(--space-3)]">{header}<EmptyState icon={IconClock} heading="No workspace" description="Add a workspace to set up Night shift." /></div>
  }
  if (!state) return <div className="grid gap-[var(--space-3)]">{header}{picker}<Text role="status" tone="muted">Loading Night shift…</Text></div>
  if (!state.routine) {
    return <NightShiftNotSetup header={header} picker={picker} name={name} onCreate={actions.create} error={error} />
  }

  return (
    <div className="grid gap-[var(--space-3)]" data-testid="night-shift-view">
      {header}
      {picker}
      <Segmented aria-label="Night shift view" size="xs" value={current} onChange={(t) => setTab(t)} options={[
        { value: 'setup', label: 'Setup' },
        { value: 'live', label: 'Live run', disabled: !live, disabledReason: 'No run in flight' },
        { value: 'report', label: 'Morning report', disabled: !shown, disabledReason: 'No finished run yet' }
      ]} />
      <NightShiftTabContent current={current} state={state} live={live} shown={shown} finished={finished} workers={workers}
        now={now} onOpenSession={onOpenSession} error={error} actions={actions} report={report} onPickRun={setReportRun} />
      {dialog && <NightShiftPreflight items={preflight} now={now} onDuration={actions.preflight} onCancel={() => setDialog(false)}
        onStart={(until) => { actions.runNow(until); setDialog(false); setTab('live') }} />}
    </div>
  )
}

function NightShiftTabContent({ current, state, live, shown, finished, workers, now, onOpenSession, error, actions, report, onPickRun }: {
  current: NightTab
  state: NonNullable<ReturnType<typeof useNightShift>['state']>
  live: NightRun | null
  shown: NightRun | null
  finished: NightRun[]
  workers: AgentKind[]
  now: number
  onOpenSession: (session: number) => void
  error: string | null
  actions: ReturnType<typeof useNightShift>['actions']
  report: NightShiftReportText | null
  onPickRun: (runId: number) => void
}): React.JSX.Element {
  return <>
    {error && current !== 'setup' && <Notice tone="danger">{error}</Notice>}
    {current === 'setup' && <NightShiftSetup settings={state.settings} revision={state.revision} verifyCommand={state.mergeVerifyCommand} childCap={state.childCap} error={error} onSave={actions.save} />}
    {current === 'live' && live && <NightShiftLive run={live} machine={state.machine} workers={workers} now={now}
      onWrapUp={() => actions.wrapUp(live.run_id)} onStop={() => actions.stop(live.run_id)} onOpenSession={onOpenSession} />}
    {current === 'report' && shown && <NightShiftReportTab finished={finished} shown={shown} report={report} workers={workers}
      holdForQa={state.settings.output === 'merge_queue' && state.settings.hold_for_qa}
      onDecide={actions.decide} onQaPassed={actions.qaPassed} onLoadReport={() => actions.loadReport(shown.run_id)}
      onPickRun={onPickRun} />}
  </>
}

function NightShiftHeader({ state, live, name, onRunNow }: {
  state: { routine: unknown } | null
  live: NightRun | null
  name: string
  onRunNow: () => void
}): React.JSX.Element {
  return (
    <PageHeader heading="Night shift" description={`An orchestrator works on ${name || 'a workspace'} for a window and leaves a morning report.`}
      actions={state?.routine ? <Button variant="secondary" disabled={!!live} onClick={onRunNow}>Run now</Button> : undefined} />
  )
}

function NightShiftNotSetup({ header, picker, name, onCreate, error }: {
  header: React.JSX.Element
  picker: false | React.JSX.Element
  name: string
  onCreate: () => void
  error: string | null
}): React.JSX.Element {
  return <div className="grid gap-[var(--space-3)]">{header}{picker}
    <EmptyState icon={IconClock} heading={`Night shift is not set up for ${name}`}
      description="It is created paused: nothing runs until you choose nights or Run now." />
    <Button variant="primary" className="justify-self-start" onClick={onCreate}>Set up Night shift</Button>
    {error && <Notice tone="danger">{error}</Notice>}
  </div>
}

function NightShiftReportTab({ finished, shown, report, workers, holdForQa, onDecide, onQaPassed, onLoadReport, onPickRun }: {
  finished: NightRun[]
  shown: NightRun
  report: NightShiftReportText | null
  workers: AgentKind[]
  holdForQa: boolean
  onDecide: ReturnType<typeof useNightShift>['actions']['decide']
  onQaPassed: ReturnType<typeof useNightShift>['actions']['qaPassed']
  onLoadReport: () => void
  onPickRun: (runId: number) => void
}): React.JSX.Element {
  return <>
    {finished.length > 1 && <Select aria-label="Run" value={String(shown.run_id)}
      options={finished.map((r) => ({ value: String(r.run_id), label: `Run ${r.run_id} · ${new Date(r.started_at_ms).toLocaleDateString()} ${timeOfDay(r.started_at_ms)}` }))}
      onChange={(v) => onPickRun(Number(v))} />}
    <NightShiftReport run={shown} report={report} workers={workers} holdForQa={holdForQa}
      onDecide={onDecide} onQaPassed={onQaPassed} onLoadReport={onLoadReport} />
  </>
}
