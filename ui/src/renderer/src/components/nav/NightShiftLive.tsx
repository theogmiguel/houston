import { useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { NightMachine } from '../../houston/generated/NightMachine'
import type { NightRun } from '../../houston/generated/NightRun'
import { Button, Card, Inline, NightPlanBoard, NightPlanColumn, NightPlanItem, NightWindowStrip, Readout, SectionHead, Text } from '../ui'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { ReadoutGrid } from '../ui/Readout'
import { StatusLabel } from '../ui/StatusLabel'
import { engineLabel } from '../engineLabel'
import { countdownLabel, limitNote, runMarks, timeOfDay } from './nightShiftFormat'

const STATUS: Record<string, 'Working' | 'Idle' | 'Needs input' | 'Limited'> = {
  working: 'Working', idle: 'Idle', 'needs-input': 'Needs input'
}

/** A run in flight: countdown, window, tiles, crew, machine and the plan board. */
export function NightShiftLive({ run, machine, workers, now, onWrapUp, onStop, onOpenSession }: {
  run: NightRun
  machine: NightMachine
  /** The worker chain, in fallback order, that substitution follows. */
  workers: AgentKind[]
  now: number
  onWrapUp: () => void
  onStop: () => void
  onOpenSession: (session: number) => void
}): React.JSX.Element {
  const span = Math.max(1, run.hard_stop_at_ms - run.started_at_ms)
  const progress = (now - run.started_at_ms) / span
  const wrapping = run.phase === 'wrapping_up'
  const plans = run.entries.filter((e) => e.kind === 'plan')
  const prs = run.entries.filter((e) => e.kind === 'pr')
  const deferred = run.entries.filter((e) => e.kind === 'deferred')
  const decisions = run.entries.filter((e) => e.kind === 'decision')
  const [confirmStop, setConfirmStop] = useState(false)
  const crewLabel = (i: number): string => (i === 0 ? 'Orchestrator' : run.crew[i].role ?? 'Worker')
  return (
    <div className="grid gap-[var(--space-3)]" data-testid="night-shift-live">
      <Inline wrap gap="small" className="justify-between">
        <div className="grid gap-[var(--space-0-5)]">
          <Text weight="semibold" data-testid="night-countdown">{countdownLabel(run.hard_stop_at_ms, now)} left</Text>
          <Text size="small" tone="muted">{wrapping ? 'Wrap-up: nothing new starts' : `Wrap-up at ${timeOfDay(run.wrap_up_at_ms)}`} · hard stop at {timeOfDay(run.hard_stop_at_ms)}</Text>
        </div>
        <div className="flex gap-[var(--space-2)]">
          {!wrapping && <Button variant="secondary" onClick={onWrapUp}>Wrap up now</Button>}
          <Button variant="ghost" onClick={() => setConfirmStop(true)}>Stop</Button>
        </div>
      </Inline>
      {confirmStop && (
        <ConfirmDialog title="Stop this Night shift run?" confirmLabel="Stop the run" onCancel={() => setConfirmStop(false)}
          onConfirm={() => { setConfirmStop(false); onStop() }}>
          <Text size="small">
            {run.crew.length === 0 ? 'The run settles now.' : `Closes ${run.crew.length} ${run.crew.length === 1 ? 'pane' : 'panes'} now: ${run.crew.map((m, i) => `${crewLabel(i)} (pane ${m.session_id})`).join(', ')}.`}
          </Text>
          <Text size="small" tone="muted">Work not in a pull request or the ledger is lost; this cannot be undone.</Text>
        </ConfirmDialog>
      )}
      <NightWindowStrip label="Run timeline" progress={progress} marks={runMarks(run)} />
      {run.interruptions.length > 0 && <Text size="small" tone="muted">{run.interruptions.map((i) => `${timeOfDay(i.at_ms)}: ${i.detail}`).join(' · ')}</Text>}

      <ReadoutGrid>
        <Readout label="Pull requests" value={prs.length} tabular />
        <Readout label="Planned" value={plans.length} tabular />
        <Readout label="Decisions" value={decisions.length} tabular />
        <Readout label="Pane-hours" value={run.cost.pane_hours.toFixed(1)} sub={`${run.cost.panes} panes`} tabular />
      </ReadoutGrid>

      <section className="grid gap-[var(--space-1-5)]" aria-label="Crew">
        <SectionHead title="Crew" count={run.crew.length} variant="sentence" tone="muted" />
        <Card>
          {run.crew.map((m, i) => (
            <Card.Row key={m.session_id}
              heading={`${i === 0 ? 'Orchestrator' : m.role ?? 'Worker'} · ${engineLabel(m.provider)}`}
              meta={`Pane ${m.session_id} · since ${timeOfDay(m.started_at_ms)}`}
              status={<StatusLabel status={m.limited ? 'Limited' : STATUS[m.status ?? 'idle'] ?? 'Idle'} size="small" />}
              action={<Button variant="muted-link" size="sm" onClick={() => onOpenSession(m.session_id)}>Open</Button>} />
          ))}
        </Card>
        {run.limited.length > 0 && <Text size="small" tone="muted">Limited this run: {run.limited.map(engineLabel).join(', ')}. {run.limited.map((p) => limitNote(p, workers, run.limited)).join(' ')}</Text>}
      </section>

      <section className="grid gap-[var(--space-1-5)]" aria-label="Machine">
        <SectionHead title="Machine" variant="sentence" tone="muted" />
        <ReadoutGrid>
          <Readout label="Keep awake" value={run.keep_awake === 'held' ? 'Held' : run.keep_awake === 'unavailable' ? 'Unavailable' : 'Off'} />
          <Readout label="Free memory" value={machine.memory_free_mib == null ? '–' : `${(machine.memory_free_mib / 1024).toFixed(1)} GiB`} tabular />
          <Readout label="Free disk" value={machine.disk_free_mib == null ? '–' : `${Math.round(machine.disk_free_mib / 1024)} GiB`} tabular />
          <Readout label="Power" value={machine.on_battery ? 'Battery' : 'AC'} />
        </ReadoutGrid>
      </section>

      <section className="grid gap-[var(--space-1-5)]" aria-label="Plan">
        <SectionHead title="Plan" variant="sentence" tone="muted" />
        <NightPlanBoard>
          <NightPlanColumn heading="Planned" count={plans.length} empty="Nothing planned yet">
            {plans.map((e) => <NightPlanItem key={e.id} label={e.title} meta={e.theme ?? undefined} />)}
          </NightPlanColumn>
          <NightPlanColumn heading="Pull requests" count={prs.length} empty="No pull requests yet">
            {prs.map((e) => <NightPlanItem key={e.id} label={`#${e.pr_number} ${e.title}`} meta={e.theme ?? undefined} />)}
          </NightPlanColumn>
          <NightPlanColumn heading="Deferred" count={deferred.length} empty="Nothing deferred">
            {deferred.map((e) => <NightPlanItem key={e.id} label={e.title} />)}
          </NightPlanColumn>
        </NightPlanBoard>
      </section>
    </div>
  )
}
