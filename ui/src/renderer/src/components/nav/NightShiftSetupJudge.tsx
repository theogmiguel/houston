import { useState } from 'react'
import type { NightDetected } from '../../houston/generated/NightDetected'
import type { NightShiftSettings } from '../../houston/generated/NightShiftSettings'
import { Button, Chip, Inline, NightBox, NightGrow, NightQuestion, NightStep, Segmented, Text, TextArea, TextInput } from '../ui'
import { Switch } from '../ui/Switch'
import { ADDED_BY_YOU, DEPTH, appQaState, checksSummary } from './nightShiftFormat'

const FIXED = <Text size="small" tone="muted">Fixed, nothing to set</Text>

const lines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter(Boolean)

function ChecksList({ draft, detected, set }: { draft: NightShiftSettings; detected: NightDetected; set: (patch: Partial<NightShiftSettings>) => void }): React.JSX.Element {
  const [next, setNext] = useState('')
  const add = (): void => {
    const command = next.trim()
    if (!command || draft.checks.some((c) => c.command === command)) return
    set({ checks: [...draft.checks, { command, source: ADDED_BY_YOU }] })
    setNext('')
  }
  const unused = detected.checks.filter((d) => !draft.checks.some((c) => c.command === d.command))
  return (
    <div className="grid gap-[var(--space-1-5)]" role="group" aria-label="Repository checks">
      {draft.checks.map((c) => (
        <NightBox key={c.command}>
          <Inline wrap gap="small">
            <NightGrow><Text mono size="small" breakAll>{c.command}</Text></NightGrow>
            <Chip variant="label" label={c.source} />
            <Button variant="ghost" size="sm" aria-label={`Remove ${c.command}`} onClick={() => set({ checks: draft.checks.filter((x) => x.command !== c.command) })}>Remove</Button>
          </Inline>
        </NightBox>
      ))}
      <Inline wrap gap="small">
        <NightGrow>
          <TextInput aria-label="Add a check command" size="form" width="full" font="mono" value={next} placeholder="Another command, e.g. bash scripts/check-copy.sh"
            onChange={(e) => setNext(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
        </NightGrow>
        <Button variant="secondary" size="sm" disabled={!next.trim()} onClick={add}>Add check</Button>
        {unused.length > 0 && <Button variant="ghost" size="sm" onClick={() => set({ checks: [...draft.checks, ...unused] })}>
          {`Add ${unused.length} found in the repository`}
        </Button>}
      </Inline>
    </div>
  )
}

function AppQa({ draft, detected, set }: { draft: NightShiftSettings; detected: NightDetected; set: (patch: Partial<NightShiftSettings>) => void }): React.JSX.Element {
  const qa = draft.app_qa
  const patch = (p: Partial<NightShiftSettings['app_qa']>): void => set({ app_qa: { ...qa, ...p } })
  const noStart = !qa.start_command.trim()
  const toggle = (enabled: boolean): void => {
    const found = detected.start_command
    patch(enabled && noStart && found ? { enabled, start_command: found.command, source: found.source } : { enabled })
  }
  return (
    <NightStep number={5} optional heading="App QA"
      tip="Optional. A separate QA pane starts the app, drives it headless through your smoke flows and attaches captures for every change you can see. Required for Merge queue output."
      aside={<div className="flex items-center gap-[var(--space-2)]">
        <Text size="small" tone={appQaState(draft) === 'Needs a start command' ? 'warn' : 'muted'}>{appQaState(draft)}</Text>
        <Switch label="App QA on" on={qa.enabled} onChange={toggle} />
      </div>}>
      {qa.enabled && <>
        <div className="grid gap-[var(--space-1)]">
          <Text size="small" tone="secondary">Start command</Text>
          <Inline wrap gap="small">
            <NightGrow>
              <TextInput aria-label="Start command" size="form" width="full" font="mono" value={qa.start_command} placeholder="Command that starts the app"
                onChange={(e) => patch({ start_command: e.target.value, source: ADDED_BY_YOU })} />
            </NightGrow>
            {qa.source && <Chip variant="label" label={qa.source} />}
          </Inline>
        </div>
        <div className="grid gap-[var(--space-1)]">
          <Text size="small" tone="secondary">What to open</Text>
          <TextInput aria-label="What to open" size="form" width="full" placeholderTone="faint" disabled={noStart} value={qa.address} placeholder="Per change: the story or screen it touches"
            onChange={(e) => patch({ address: e.target.value })} />
        </div>
        <div className="grid gap-[var(--space-1)]">
          <Text size="small" tone="secondary">Flows to check</Text>
          <TextArea aria-label="Flows to run on every change" rows={2} disabled={noStart} value={qa.smoke_flows.join('\n')} placeholder="Optional, one per line: Open a workspace and spawn a pane"
            onChange={(e) => patch({ smoke_flows: lines(e.target.value) })} />
        </div>
        {noStart && <Text size="small" tone="warn">No start command found in this repository. Enter one; App QA stays off until you do.</Text>}
      </>}
    </NightStep>
  )
}

/** Question 2: the fixed method every change goes through, with its few settings. */
export function JudgeChange({ draft, detected, set }: { draft: NightShiftSettings; detected: NightDetected; set: (patch: Partial<NightShiftSettings>) => void }): React.JSX.Element {
  const [checksOpen, setChecksOpen] = useState(false)
  const expanded = checksOpen || draft.checks.length === 0
  const found = draft.checks.some((c) => c.source !== ADDED_BY_YOU)
  const badge = draft.checks.length === 0 ? { label: 'Required', tone: 'required' as const }
    : { label: found ? 'Answered from the repository' : 'Answered', tone: 'answered' as const }
  const depth = DEPTH[draft.verification]
  return (
    <NightQuestion number={2} heading="How do I know a change is good?" badge={badge}>
      <Text size="small" tone="secondary">Every change goes through four steps, plus App QA if you turn it on.</Text>
      <div className="grid">
        <NightStep number={1} heading="Claims and proofs" aside={FIXED}
          tip="Before building, each change lists what must be true, with a concrete value, and the specific test that proves each claim." />
        <NightStep number={2} heading="Build" aside={FIXED}
          tip="The worker writes the tests from the claims, never from the code, then implements. A test is never weakened or deleted to get green; the change is parked instead." />
        <NightStep number={3} heading="Independent verifier"
          tip="A pane that neither built the change nor wrote its brief re-runs every proof on the pull request branch and records a verdict per claim. Depth sets how hard it tries to break the change."
          aside={<Segmented aria-label="Verification depth" size="xs" value={draft.verification}
            options={[{ value: 'light', label: 'Light' }, { value: 'standard', label: 'Standard' }]} onChange={(verification) => set({ verification })} />}>
          <Text size="small" tone="secondary">{depth.does}</Text>
          <Text size="small" tone="muted">{`Cannot catch: ${depth.misses}`}</Text>
        </NightStep>
        <NightStep number={4} heading="Checks and CI"
          tip="Houston runs these commands on the pull request branch itself and reads CI from the pull request watch; both show as facts in the morning report. Found in the CI workflows, package manifests and AGENTS.md; only checks that run on this machine are listed, full suites run in CI."
          aside={<Button variant="secondary" size="sm" aria-expanded={expanded} onClick={() => setChecksOpen(!checksOpen)}>{`${checksSummary(draft.checks, detected.checks.length)} ${expanded ? '▾' : '▸'}`}</Button>}>
          {expanded && <ChecksList draft={draft} detected={detected} set={set} />}
        </NightStep>
        <AppQa draft={draft} detected={detected} set={set} />
      </div>
    </NightQuestion>
  )
}
