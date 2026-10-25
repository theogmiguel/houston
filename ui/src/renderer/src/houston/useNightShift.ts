import { useCallback, useEffect, useRef, useState } from 'react'
import type { NightDetected } from './generated/NightDetected'
import type { HoustonClient } from './client'
import type { NightMachine } from './generated/NightMachine'
import type { NightRun } from './generated/NightRun'
import type { NightShiftSettings } from './generated/NightShiftSettings'
import type { PreflightItem } from './generated/PreflightItem'
import type { Routine } from './generated/Routine'

export interface NightShiftState {
  workspace: string
  routine: Routine | null
  settings: NightShiftSettings
  revision: string
  runs: NightRun[]
  machine: NightMachine
  /** Whether the workspace's merge queue has a verification command. */
  mergeVerifyCommand: boolean
  /** The global child panes per agent. */
  childCap: number
  /** What Houston found in the workspace for Setup to offer. */
  detected: NightDetected
}

export interface NightShiftReportText {
  runId: number
  markdown: string
  truncated: boolean
}

export interface NightShiftActions {
  create: () => void
  /** `revision` is the one the edit started from, so a concurrent change is refused. */
  save: (settings: NightShiftSettings, revision: string) => void
  preflight: (untilMs: number) => void
  runNow: (untilMs: number) => void
  wrapUp: (runId: number) => void
  stop: (runId: number) => void
  decide: (entryId: number, choice: string) => void
  qaPassed: (entryId: number) => void
  loadReport: (runId: number) => void
  dismissError: () => void
}

function upsertRun(runs: NightRun[], run: NightRun): NightRun[] {
  const rest = runs.filter((r) => r.run_id !== run.run_id)
  return [run, ...rest].sort((a, b) => b.run_id - a.run_id)
}

/// A workspace's Night shift routine, settings and runs, kept current from the
/// daemon's broadcasts. Mutation refusals arrive as the error the view shows.
export function useNightShift(client: HoustonClient | null, workspace: string | null): {
  state: NightShiftState | null
  preflight: PreflightItem[] | null
  report: NightShiftReportText | null
  error: string | null
  actions: NightShiftActions
} {
  const [state, setState] = useState<NightShiftState | null>(null)
  const [preflight, setPreflight] = useState<PreflightItem[] | null>(null)
  const [report, setReport] = useState<NightShiftReportText | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stateRef = useRef<NightShiftState | null>(null)
  stateRef.current = state

  useEffect(() => {
    setState(null)
    setPreflight(null)
    setReport(null)
    setError(null)
    if (!client || !workspace) return
    const offState = client.subscribe('night_shift_state', (msg) => {
      if (msg.workspace !== workspace) return
      // A refresh with the same revision keeps the settings object, so an open
      // Setup form is not reset by unrelated routine broadcasts.
      setState((current) => ({
        workspace: msg.workspace,
        routine: msg.routine ?? null,
        settings: current?.workspace === msg.workspace && current.revision === msg.revision ? current.settings : msg.settings,
        revision: msg.revision,
        runs: msg.runs,
        machine: msg.machine,
        mergeVerifyCommand: msg.merge_verify_command,
        childCap: msg.child_cap,
        detected: msg.detected
      }))
      if (msg.preflight) setPreflight(msg.preflight)
    })
    const offRun = client.subscribe('night_shift_run_event', (msg) => {
      if (msg.run.workspace !== workspace) return
      setState((current) => (current ? { ...current, runs: upsertRun(current.runs, msg.run) } : current))
    })
    const offRoutines = client.subscribe('routines', () => client.nightShiftState(workspace))
    const offReport = client.subscribe('night_shift_report', (msg) => {
      setReport({ runId: msg.run_id, markdown: msg.markdown, truncated: msg.truncated })
    })
    const offError = client.subscribe('error', (msg) => {
      // Night shift refusals carry their context and reach only the connection that asked.
      if (msg.context === 'night_shift' || msg.context?.startsWith('night_shift_report:')) setError(msg.message)
    })
    client.nightShiftState(workspace)
    return () => {
      offState()
      offRun()
      offRoutines()
      offReport()
      offError()
    }
  }, [client, workspace])

  const send = useCallback((f: (c: HoustonClient) => void) => {
    if (!client) return
    setError(null)
    f(client)
  }, [client])

  const routineId = state?.routine?.id ?? null
  const actions: NightShiftActions = {
    create: () => { if (workspace) send((c) => c.nightShiftCreate(workspace)) },
    save: (settings, revision) => {
      const routine = stateRef.current?.routine
      if (routine) send((c) => c.nightShiftUpdate(routine.id, settings, revision))
    },
    preflight: (untilMs) => { if (workspace) { setPreflight(null); client?.nightShiftState(workspace, untilMs) } },
    runNow: (untilMs) => { if (routineId !== null) send((c) => c.nightShiftRunNow(routineId, untilMs)) },
    wrapUp: (runId) => send((c) => c.nightShiftWrapUp(runId)),
    stop: (runId) => send((c) => c.nightShiftStop(runId)),
    decide: (entryId, choice) => send((c) => c.nightShiftDecide(entryId, choice)),
    qaPassed: (entryId) => send((c) => c.nightShiftQaPassed(entryId)),
    loadReport: (runId) => { setReport(null); client?.nightShiftReport(runId) },
    dismissError: () => setError(null)
  }

  return {
    state: state?.workspace === workspace ? state : null,
    preflight,
    report,
    error,
    actions
  }
}
