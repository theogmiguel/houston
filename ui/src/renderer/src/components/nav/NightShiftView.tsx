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
import { timeOfDay } from './nightShiftFormat'

type Tab = 'setup' | 'live' | 'report'

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
  const [workspace, setWorkspace] = useState<string | null>(initialWorkspace ?? workspaces[0]?.id ?? null)
  useEffect(() => {
    if (workspace === null || !workspaces.some((w) => w.id === workspace)) setWorkspace(workspaces[0]?.id ?? null)
  }, [workspace, workspaces])
  const { state, preflight, report, error, actions } = useNightShift(client, workspace)
  const [tab, setTab] = useState<Tab | null>(null)
  const [reportRun, setReportRun] = useState<number | null>(initialRunId)
  const [dialog, setDialog] = useState(false)
  const live = state?.runs.find((r) => r.phase === 'running' || r.phase === 'wrapping_up') ?? null
  const finished = state?.runs.filter((r) => r.phase === 'settled' || r.phase === 'refused') ?? []
  const shown = finished.find((r) => r.run_id === reportRun) ?? finished[0] ?? null
  const fallback: Tab = live ? 'live' : initialRunId !== null && shown ? 'report' : 'setup'
  // A run that ended while its live view was open lands on its report.
  const current: Tab = tab === 'live' && !live ? (shown ? 'report' : 'setup') : tab ?? fallback
  useEffect(() => { if (live) setTab('live') }, [live?.run_id]) // eslint-disable-line react-hooks/exhaustive-deps

  const name = workspaces.find((w) => w.id === workspace)?.name ?? workspace ?? ''
  const workers = state?.settings.workers.map((w) => w.provider) ?? []
  const header = (
    <PageHeader heading="Night shift" description={`An orchestrator works on ${name || 'a workspace'} for a window and leaves a morning report.`}
      actions={state?.routine ? <Button variant="secondary" disabled={!!live} onClick={() => setDialog(true)}>Run now</Button> : undefined} />
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
    return <div className="grid gap-[var(--space-3)]">{header}{picker}
      <EmptyState icon={IconClock} heading={`Night shift is not set up for ${name}`}
        description="It is created paused: nothing runs until you choose nights or Run now." />
      <Button variant="primary" className="justify-self-start" onClick={actions.create}>Set up Night shift</Button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
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
      {error && current !== 'setup' && <Notice tone="danger">{error}</Notice>}
      {current === 'setup' && <NightShiftSetup settings={state.settings} revision={state.revision} verifyCommand={state.mergeVerifyCommand} error={error} onSave={actions.save} />}
      {current === 'live' && live && <NightShiftLive run={live} machine={state.machine} workers={workers} now={now}
        onWrapUp={() => actions.wrapUp(live.run_id)} onStop={() => actions.stop(live.run_id)} onOpenSession={onOpenSession} />}
      {current === 'report' && shown && <>
        {finished.length > 1 && <Select aria-label="Run" value={String(shown.run_id)}
          options={finished.map((r) => ({ value: String(r.run_id), label: `Run ${r.run_id} · ${new Date(r.started_at_ms).toLocaleDateString()} ${timeOfDay(r.started_at_ms)}` }))}
          onChange={(v) => setReportRun(Number(v))} />}
        <NightShiftReport run={shown} report={report} workers={workers} holdForQa={state.settings.output === 'merge_queue' && state.settings.hold_for_qa}
          onDecide={actions.decide} onQaPassed={actions.qaPassed} onLoadReport={() => actions.loadReport(shown.run_id)} />
      </>}
      {dialog && <NightShiftPreflight items={preflight} now={now} onDuration={actions.preflight} onCancel={() => setDialog(false)}
        onStart={(until) => { actions.runNow(until); setDialog(false); setTab('live') }} />}
    </div>
  )
}
