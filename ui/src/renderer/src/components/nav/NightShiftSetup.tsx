import { useEffect, useState } from 'react'
import type { NightDetected } from '../../houston/generated/NightDetected'
import type { NightFocus } from '../../houston/generated/NightFocus'
import type { NightFocusLevel } from '../../houston/generated/NightFocusLevel'
import type { NightShiftSettings } from '../../houston/generated/NightShiftSettings'
import { Button, NightGrow, NightSetupFooter, NightSetupHeader, Notice, SaveStateMark, Text } from '../ui'
import { clockLabel, mergeRefusal, parseClock, readinessGaps, settingsProblems, suggestFocus } from './nightShiftFormat'
import { WorkOn, competitorsOf, rowsOf, type CompetitorRow } from './NightShiftSetupWork'
import { JudgeChange } from './NightShiftSetupJudge'
import { Advanced, GetBack, WhenRun, type Clocks } from './NightShiftSetupMore'

const NO_DETECTED: NightDetected = { checks: [], start_command: null, apps: [], apps_note: null }

const clocksOf = (s: NightShiftSettings): Clocks => ({
  start: clockLabel(s.window.start), wrap_up: clockLabel(s.window.wrap_up), hard_stop: clockLabel(s.window.hard_stop)
})

/** Routines ▸ Night shift ▸ Setup: four questions, Advanced, and a footer that says what a run
 * still needs. Edits a draft; Save sends the whole document against the revision it was read at. */
export function NightShiftSetup({ settings, revision, verifyCommand, childCap = 6, detected = NO_DETECTED, onSave, onRunNow, saving = false, error = null }: {
  settings: NightShiftSettings
  revision: string
  /** Whether the workspace has a merge queue verification command. */
  verifyCommand: boolean
  /** The global child panes per agent; the run's orchestrator has its own limit. */
  childCap?: number
  /** What Houston found in the workspace. */
  detected?: NightDetected
  onSave: (settings: NightShiftSettings, revision: string) => void
  onRunNow?: () => void
  saving?: boolean
  error?: string | null
}): React.JSX.Element {
  const [base, setBase] = useState({ settings, revision })
  const [draft, setDraft] = useState(settings)
  const [clocks, setClocks] = useState(() => clocksOf(settings))
  const [rows, setRows] = useState<CompetitorRow[]>(() => rowsOf(settings.competitors))
  // Focus areas the user set by hand; a direction never overrides them.
  const [touched, setTouched] = useState<ReadonlySet<keyof NightFocus>>(new Set())
  const [suggested, setSuggested] = useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(base.settings)
  // The draft Save sent, until the daemon answers with it; then Saved shows until the next edit.
  const [sent, setSent] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const reset = (): void => {
    setBase({ settings, revision })
    setDraft(settings)
    setClocks(clocksOf(settings))
    setRows(rowsOf(settings.competitors))
    setTouched(new Set())
    setSuggested(false)
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
  const onArea = (key: keyof NightFocus, level: NightFocusLevel): void => {
    setTouched((t) => new Set([...t, key]))
    // UI and UX polish changes are visible, so screenshots stay on with it.
    setDraft((d) => ({ ...d, focus: { ...d.focus, [key]: level }, screenshots: key === 'ui_polish' && level !== 'off' ? true : d.screenshots }))
  }
  const onDirection = (direction: string): void => {
    const next = suggestFocus(direction, base.settings.focus, draft.focus, touched)
    setSuggested(next.suggested)
    setDraft((d) => ({ ...d, direction, focus: next.focus, screenshots: next.focus.ui_polish !== 'off' ? true : d.screenshots }))
  }
  const onRows = (next: CompetitorRow[]): void => {
    setRows(next)
    set({ competitors: competitorsOf(next) })
  }
  const onClock = (key: keyof Clocks, text: string): void => {
    setClocks((c) => ({ ...c, [key]: text }))
    const parsed = parseClock(text)
    if (parsed) setDraft((d) => ({ ...d, window: { ...d.window, [key]: parsed } }))
  }
  const refusal = mergeRefusal(draft, verifyCommand)
  const incomplete = rows.length - draft.competitors.length
  const problems = [
    ...(Object.values(clocks).some((c) => !parseClock(c)) ? ['Times are HH:MM, for example 23:30.'] : []),
    ...(incomplete > 0 && draft.focus.competitor_gaps !== 'off' ? [`Complete or remove ${incomplete === 1 ? 'the unfinished competitor' : `${incomplete} unfinished competitors`}.`] : []),
    ...settingsProblems(draft),
    ...(refusal ? [refusal] : [])
  ]

  return (
    <div className="grid gap-[var(--space-3)]" data-testid="night-shift-setup">
      <NightSetupHeader heading="Set up Night shift" description="Choose what it should work on and press Run now. Everything else is found in the repository or has defaults you can leave alone." />
      <WorkOn draft={draft} suggested={suggested} rows={rows} detected={detected} onDirection={onDirection} onArea={onArea} onRows={onRows} />
      <JudgeChange draft={draft} detected={detected} set={set} />
      <GetBack draft={draft} set={set} refusal={refusal} />
      <WhenRun draft={draft} set={set} clocks={clocks} onClock={onClock} />
      <Advanced draft={draft} set={set} childCap={childCap} />
      {problems.filter((p) => p !== refusal).map((p) => <Notice key={p} tone="warn">{p}</Notice>)}
      {error && <Notice tone="danger">{error}</Notice>}
      <SetupFooter gaps={[...readinessGaps(draft, dirty), ...(problems.length > 0 ? ['fix the notes above'] : [])]} dirty={dirty} saving={saving} sent={sent} saved={saved}
        canSave={dirty && !saving && sent === null && problems.length === 0} onRunNow={onRunNow}
        onSave={() => { setSent(JSON.stringify(draft)); onSave(draft, base.revision) }} onDiscard={() => { setSent(null); reset() }} />
    </div>
  )
}

function SetupFooter({ gaps, dirty, saving, sent, saved, canSave, onSave, onDiscard, onRunNow }: {
  gaps: string[]
  dirty: boolean
  saving: boolean
  sent: string | null
  saved: boolean
  canSave: boolean
  onSave: () => void
  onDiscard: () => void
  onRunNow?: () => void
}): React.JSX.Element {
  const ready = gaps.length === 0
  return (
    <NightSetupFooter>
      <NightGrow>
        <Text data-testid="night-readiness" tone={ready ? 'ok' : 'warn'}>{ready ? 'Ready to run.' : `To run, ${gaps.join(' and ')}.`}</Text>
      </NightGrow>
      <span role="status" className="inline-flex items-center gap-[var(--space-1)]">
        {(sent !== null || saving) && <><SaveStateMark saving /><Text size="small" tone="muted" aria-hidden="true">Saving…</Text></>}
        {saved && !dirty && sent === null && <><SaveStateMark saving={false} /><Text size="small" tone="muted" aria-hidden="true">Saved</Text></>}
      </span>
      {dirty && <Button variant="ghost" onClick={onDiscard}>Discard changes</Button>}
      <Button variant="secondary" disabled={!canSave} onClick={onSave}>Save</Button>
      {onRunNow && <Button variant="primary" disabled={!ready} onClick={onRunNow}>Run now…</Button>}
    </NightSetupFooter>
  )
}
