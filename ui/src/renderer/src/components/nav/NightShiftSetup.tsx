import { useEffect, useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { NightFocusLevel } from '../../houston/generated/NightFocusLevel'
import type { NightShiftSettings } from '../../houston/generated/NightShiftSettings'
import { Button, Card, Chip, Inline, Notice, NightWindowStrip, SaveStateMark, Segmented, Select, Text, TextArea, TextInput } from '../ui'
import { Toggle } from '../ui/settingsPrimitives'
import { NumberField } from '../ui/NumberField'
import { engineLabel } from '../engineLabel'
import {
  FOCUS_AREAS, NIGHTS, NO_LIMIT_SIGNAL, ORCHESTRATOR_PROVIDERS, WORKER_PROVIDERS, clockLabel, durationLabel, mergeRefusal,
  minutesBetween, parseClock, settingsProblems, windowMarks
} from './nightShiftFormat'

const LEVELS: { value: NightFocusLevel; label: string }[] = [
  { value: 'off', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }
]

const lines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter(Boolean)

const clocksOf = (s: NightShiftSettings): Record<'start' | 'wrap_up' | 'hard_stop', string> => ({
  start: clockLabel(s.window.start), wrap_up: clockLabel(s.window.wrap_up), hard_stop: clockLabel(s.window.hard_stop)
})

function ClockField({ label, value, onChange }: { label: string; value: string; onChange: (text: string) => void }): React.JSX.Element {
  return <TextInput aria-label={label} value={value} size="form" width="compact" onChange={(e) => onChange(e.target.value)} />
}

/** Routines ▸ Night shift ▸ Setup. Edits a draft; Save sends the whole document against the revision it was read at. */
export function NightShiftSetup({ settings, revision, verifyCommand, onSave, saving = false, error = null }: {
  settings: NightShiftSettings
  revision: string
  /** Whether the workspace has a merge queue verification command. */
  verifyCommand: boolean
  onSave: (settings: NightShiftSettings, revision: string) => void
  saving?: boolean
  error?: string | null
}): React.JSX.Element {
  const [base, setBase] = useState({ settings, revision })
  const [draft, setDraft] = useState(settings)
  const [clocks, setClocks] = useState(() => clocksOf(settings))
  const dirty = JSON.stringify(draft) !== JSON.stringify(base.settings)
  // The draft Save sent, until the daemon answers with it; then Saved shows until the next edit.
  const [sent, setSent] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const reset = (): void => {
    setBase({ settings, revision })
    setDraft(settings)
    setClocks(clocksOf(settings))
  }
  // A new revision replaces a clean form; an edited one keeps its edit and base revision, so a
  // concurrent change makes Save refuse as stale instead of overwriting it.
  useEffect(() => {
    if (revision !== base.revision && (!dirty || JSON.stringify(draft) === JSON.stringify(settings))) reset()
    if (sent !== null && JSON.stringify(settings) === sent) {
      setSent(null)
      setSaved(true)
    }
  }, [revision]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (error) setSent(null) }, [error])
  useEffect(() => { if (dirty) setSaved(false) }, [dirty])
  const set = (patch: Partial<NightShiftSettings>): void => setDraft((d) => ({ ...d, ...patch }))
  const setClock = (key: 'start' | 'wrap_up' | 'hard_stop', text: string): void => {
    setClocks((c) => ({ ...c, [key]: text }))
    const parsed = parseClock(text)
    if (parsed) setDraft((d) => ({ ...d, window: { ...d.window, [key]: parsed } }))
  }
  const toggleNight = (day: number): void => setDraft((d) => {
    const nights = d.window.nights.includes(day) ? d.window.nights.filter((n) => n !== day) : [...d.window.nights, day].sort()
    return { ...d, window: { ...d.window, nights } }
  })
  const refusal = mergeRefusal(draft, verifyCommand)
  const clockError = Object.values(clocks).some((c) => !parseClock(c)) ? 'Times are HH:MM, for example 23:30.' : null
  const problems = [...(clockError ? [clockError] : []), ...settingsProblems(draft), ...(refusal ? [refusal] : [])]
  const total = minutesBetween(draft.window.start, draft.window.hard_stop)
  const workerOptions = WORKER_PROVIDERS.map((p) => ({ value: p, label: engineLabel(p) }))
  // A stored ZCode orchestrator stays visible, with its refusal, until it is changed.
  const orchestratorOptions = [...new Set([...ORCHESTRATOR_PROVIDERS, draft.orchestrator.provider])]
    .map((p) => ({ value: p, label: engineLabel(p) }))
  const appCheck = (patch: Partial<NonNullable<NightShiftSettings['app_check']>>): NightShiftSettings['app_check'] => {
    const next = { start_command: '', address: '', smoke_flows: [], ...draft.app_check, ...patch }
    return next.start_command.trim() || next.address.trim() || next.smoke_flows.length > 0 ? next : null
  }

  return (
    <div className="grid gap-[var(--space-3)]" data-testid="night-shift-setup">
      <Card layout="fields" shape="card" role="group" aria-label="Window">
        <Card.Field label="Night shift">
          <div className="flex items-center gap-[var(--space-2)]">
            <Toggle aria-label="Night shift on" on={draft.enabled} onChange={(on) => set({ enabled: on })} />
            <Text size="small" tone="muted">{draft.enabled ? 'Runs on the nights below' : 'Off: runs only with Run now'}</Text>
          </div>
        </Card.Field>
        <Card.Field label="Window">
          <div className="grid gap-[var(--space-2)]">
            <Inline wrap gap="small">
              <Text size="small" tone="muted">Start</Text><ClockField label="Start" value={clocks.start} onChange={(t) => setClock('start', t)} />
              <Text size="small" tone="muted">Wrap-up</Text><ClockField label="Wrap-up" value={clocks.wrap_up} onChange={(t) => setClock('wrap_up', t)} />
              <Text size="small" tone="muted">Hard stop</Text><ClockField label="Hard stop" value={clocks.hard_stop} onChange={(t) => setClock('hard_stop', t)} />
              <Text size="small" tone="muted">{durationLabel(total)}</Text>
            </Inline>
            <NightWindowStrip label="Run window" marks={windowMarks(draft.window)} />
          </div>
        </Card.Field>
        <Card.Field label="Nights">
          <Inline wrap gap="small" role="group" aria-label="Nights">
            {NIGHTS.map((n) => <Chip key={n.day} variant="choice" label={n.label} selected={draft.window.nights.includes(n.day)} onClick={() => toggleNight(n.day)} />)}
          </Inline>
          {draft.window.nights.length === 0 && <Text size="small" tone="muted">No nights selected</Text>}
        </Card.Field>
      </Card>

      <Card layout="fields" shape="card" role="group" aria-label="Focus">
        {FOCUS_AREAS.map((area) => (
          <Card.Field key={area.key} label={area.label}>
            <Segmented aria-label={`${area.label} focus`} size="xs" value={draft.focus[area.key]} options={LEVELS}
              onChange={(level) => set({ focus: { ...draft.focus, [area.key]: level } })} />
          </Card.Field>
        ))}
        <Card.Field label="Direction">
          <TextArea aria-label="Direction" rows={2} value={draft.direction} placeholder="e.g. Make it feel faster and stop it crashing in long sessions" onChange={(e) => set({ direction: e.target.value })} />
        </Card.Field>
        <Card.Field label="Competitor sources">
          <TextArea aria-label="Competitor sources" rows={2} value={draft.competitor_sources.join('\n')} placeholder="One repository URL per line"
            onChange={(e) => set({ competitor_sources: lines(e.target.value) })} />
        </Card.Field>
      </Card>

      <Card layout="fields" shape="card" role="group" aria-label="Crew">
        <CrewFields draft={draft} set={set} workerOptions={workerOptions} orchestratorOptions={orchestratorOptions} />
      </Card>

      <Card layout="fields" shape="card" role="group" aria-label="Output">
        <OutputFields draft={draft} set={set} refusal={refusal} appCheck={appCheck} />
      </Card>

      <Card layout="fields" shape="card" role="group" aria-label="Before hand-back">
        <Card.Field label="Checks before hand-back">
          <TextArea aria-label="Checks before hand-back" rows={3} mono value={draft.checks.join('\n')} placeholder="One command per line; required before the first run"
            onChange={(e) => set({ checks: lines(e.target.value) })} />
        </Card.Field>
        <Card.Field label="Questions at night"><Text>Parked for the morning report</Text></Card.Field>
      </Card>

      {problems.map((p) => <Notice key={p} tone="warn">{p}</Notice>)}
      <SaveRow draft={draft} baseRevision={base.revision} onSave={onSave} saving={saving} dirty={dirty} sent={sent} saved={saved}
        problems={problems} error={error} onSend={setSent} onDiscard={() => { setSent(null); reset() }} />
    </div>
  )
}

function CrewFields({ draft, set, workerOptions, orchestratorOptions }: {
  draft: NightShiftSettings
  set: (patch: Partial<NightShiftSettings>) => void
  workerOptions: { value: AgentKind; label: string }[]
  orchestratorOptions: { value: AgentKind; label: string }[]
}): React.JSX.Element {
  return <>
    <Card.Field label="Orchestrator">
      <div className="flex items-center gap-[var(--space-2)]">
        <Select aria-label="Orchestrator" value={draft.orchestrator.provider} options={orchestratorOptions}
          onChange={(p) => set({ orchestrator: p === draft.orchestrator.provider ? draft.orchestrator : { provider: p as AgentKind, model: null } })} />
        {draft.orchestrator.model && <Text size="small" tone="muted">{draft.orchestrator.model}</Text>}
      </div>
    </Card.Field>
    <Card.Field label="Workers, in fallback order">
      <div className="grid gap-[var(--space-1)]">
        {draft.workers.map((w, i) => (
          <div key={i} className="flex items-center gap-[var(--space-2)]">
            <Select aria-label={`Worker ${i + 1}`} value={w.provider} options={workerOptions}
              onChange={(p) => set({ workers: draft.workers.map((x, j) => (j === i ? { provider: p as AgentKind, model: null } : x)) })} />
            {w.model && <Text size="small" tone="muted">{w.model}</Text>}
            {draft.workers.length > 1 && <Button variant="ghost" size="sm" onClick={() => set({ workers: draft.workers.filter((_, j) => j !== i) })}>Remove</Button>}
          </div>
        ))}
        {draft.workers.length < 4 && <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => set({ workers: [...draft.workers, { provider: 'claude', model: null }] })}>Add worker</Button>}
        <Text size="small" tone="muted">{NO_LIMIT_SIGNAL.map(engineLabel).join(', ')} report no usage limit and cannot be workers.</Text>
      </div>
    </Card.Field>
    <Card.Field label="Live workers">
      <NumberField width="compact" aria-label="Live workers" min={1} max={12} value={draft.live_workers} onChange={(e) => set({ live_workers: Math.max(1, Number(e.target.value) || 1) })} />
    </Card.Field>
    <Card.Field label="Reviewer">
      <Select aria-label="Reviewer" value={draft.reviewer?.provider ?? 'same'}
        options={[{ value: 'same', label: 'Same as orchestrator' }, ...workerOptions]}
        onChange={(p) => set({ reviewer: p === 'same' ? null : { provider: p as AgentKind, model: null } })} />
    </Card.Field>
  </>
}

function OutputFields({ draft, set, refusal, appCheck }: {
  draft: NightShiftSettings
  set: (patch: Partial<NightShiftSettings>) => void
  refusal: string | null
  appCheck: (patch: Partial<NonNullable<NightShiftSettings['app_check']>>) => NightShiftSettings['app_check']
}): React.JSX.Element {
  return <>
    <Card.Field label="Output">
      <Segmented aria-label="Output" size="xs" value={draft.output}
        options={[{ value: 'prs', label: 'Pull requests only' }, { value: 'merge_queue', label: 'Merge queue' }]}
        onChange={(output) => set({ output })} />
      {refusal && <Notice tone="warn" data-testid="merge-refusal">{refusal}</Notice>}
    </Card.Field>
    <Card.Field label="Pull request size">
      <Segmented aria-label="Pull request size" size="xs" value={draft.pr_size.kind}
        options={[{ value: 'one', label: 'One change each' }, { value: 'related', label: 'Related changes together' }]}
        onChange={(kind) => set({ pr_size: kind === 'one' ? { kind } : { kind, max_changes: 5 } })} />
      {draft.pr_size.kind === 'related' && (
        <NumberField width="compact" aria-label="Most changes in one pull request" min={2} max={20} value={draft.pr_size.max_changes}
          onChange={(e) => set({ pr_size: { kind: 'related', max_changes: Math.min(20, Math.max(2, Number(e.target.value) || 2)) } })} />
      )}
    </Card.Field>
    <Card.Field label="Screenshots"><Toggle aria-label="Screenshots for visible changes" on={draft.screenshots} onChange={(screenshots) => set({ screenshots })} /></Card.Field>
    <Card.Field label="App check">
      <div className="grid gap-[var(--space-1)]">
        <TextInput aria-label="App start command" placeholder="Start command, for example bun run dev" value={draft.app_check?.start_command ?? ''}
          onChange={(e) => set({ app_check: appCheck({ start_command: e.target.value }) })} />
        <TextInput aria-label="App address" placeholder="Address or story" value={draft.app_check?.address ?? ''}
          onChange={(e) => set({ app_check: appCheck({ address: e.target.value }) })} />
        <TextArea aria-label="Smoke flows" rows={2} value={draft.app_check?.smoke_flows.join('\n') ?? ''} placeholder="One smoke flow per line"
          onChange={(e) => set({ app_check: appCheck({ smoke_flows: lines(e.target.value) }) })} />
        {!draft.app_check?.start_command.trim() && <Text size="small" tone="muted">App QA is off until a start command is set.</Text>}
      </div>
    </Card.Field>
    <Card.Field label="Hold for my QA"><Toggle aria-label="Hold for my QA" on={draft.hold_for_qa} onChange={(hold_for_qa) => set({ hold_for_qa })} /></Card.Field>
  </>
}

function SaveRow({ draft, baseRevision, onSave, saving, dirty, sent, saved, problems, error, onSend, onDiscard }: {
  draft: NightShiftSettings
  baseRevision: string
  onSave: (settings: NightShiftSettings, revision: string) => void
  saving: boolean
  dirty: boolean
  sent: string | null
  saved: boolean
  problems: string[]
  error: string | null
  onSend: (serialized: string) => void
  onDiscard: () => void
}): React.JSX.Element {
  return <>
    {error && <Notice tone="danger">{error}</Notice>}
    <div className="flex items-center gap-[var(--space-2)]">
      <Button variant="primary" disabled={!dirty || saving || sent !== null || problems.length > 0}
        onClick={() => { onSend(JSON.stringify(draft)); onSave(draft, baseRevision) }}>Save</Button>
      {dirty && <Button variant="ghost" onClick={onDiscard}>Discard changes</Button>}
      <span role="status" className="inline-flex items-center gap-[var(--space-1)]">
        {sent !== null && <><SaveStateMark saving /><Text size="small" tone="muted" aria-hidden="true">Saving…</Text></>}
        {saved && !dirty && sent === null && <><SaveStateMark saving={false} /><Text size="small" tone="muted" aria-hidden="true">Saved</Text></>}
      </span>
    </div>
  </>
}
