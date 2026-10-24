import type { AgentKind } from '../../houston/generated/AgentKind'
import type { NightShiftSettings } from '../../houston/generated/NightShiftSettings'
import {
  Button, Chip, Disclosure, InfoTip, Inline, NightBox, NightChoice, NightChoiceGrid, NightDisclosureBody, NightField, NightFieldGrid, NightQuestion,
  NightReveal, NightWindowStrip, Segmented, Select, Text, TextInput
} from '../ui'
import { NumberField } from '../ui/NumberField'
import { Switch } from '../ui/Switch'
import { engineLabel } from '../engineLabel'
import {
  NIGHTS, ORCHESTRATOR_PROVIDERS, WORKER_PROVIDERS, crewSummary, durationLabel, minutesBetween, ownLimitNote, prFormatSummary, scheduleHint, windowMarks
} from './nightShiftFormat'

type Set = (patch: Partial<NightShiftSettings>) => void

/** Question 3: what comes back, and how pull requests are cut. */
export function GetBack({ draft, set, refusal }: { draft: NightShiftSettings; set: Set; refusal: string | null }): React.JSX.Element {
  const locked = draft.focus.ui_polish !== 'off'
  return (
    <NightQuestion number={3} heading="What do I get back?">
      <NightChoiceGrid aria-label="Output">
        <NightChoice selected={draft.output === 'prs'} heading="Draft pull requests" description="You review and merge them yourself. Nothing is merged." onSelect={() => set({ output: 'prs' })} />
        <NightChoice selected={draft.output === 'merge_queue'} heading="Merge queue" description="Ready pull requests join this workspace's merge queue, which merges what passes." onSelect={() => set({ output: 'merge_queue' })} />
      </NightChoiceGrid>
      {draft.output === 'merge_queue' && (
        <NightBox>
          {refusal && <Text size="small" tone="warn" data-testid="merge-refusal">{refusal}</Text>}
          <div className="flex items-center gap-[var(--space-2)]">
            <Switch label="Hold for my QA" on={draft.hold_for_qa} onChange={(hold_for_qa) => set({ hold_for_qa })} />
            <Text weight="semibold">Hold for my QA</Text>
            <InfoTip about="Hold for my QA">Changes you can see wait for Mark QA passed in the morning report before they join the queue.</InfoTip>
          </div>
        </NightBox>
      )}
      <Disclosure variant="flush" summary={<Inline wrap gap="small" align="baseline">Pull request format<Text size="small" tone="muted">{prFormatSummary(draft)}</Text></Inline>}>
        <NightDisclosureBody>
          <NightField label="Pull request size" tip="A change is one planned item, such as one bug fix or one new test. Grouping puts related changes (same theme, for example hooks reliability) in one pull request, so you review fewer of them.">
            <Inline wrap gap="small">
              <Segmented aria-label="Pull request size" size="xs" value={draft.pr_size.kind}
                options={[{ value: 'one', label: 'One change each' }, { value: 'related', label: 'Related changes together' }]}
                onChange={(kind) => set({ pr_size: kind === 'one' ? { kind } : { kind, max_changes: 5 } })} />
              {draft.pr_size.kind === 'related' && <span className="inline-flex items-center gap-[var(--space-2)]">
                <Text size="small" tone="secondary">up to</Text>
                <NumberField width="compact" aria-label="Most changes in one pull request" min={2} max={20} value={draft.pr_size.max_changes}
                  onChange={(e) => set({ pr_size: { kind: 'related', max_changes: Math.min(20, Math.max(2, Number(e.target.value) || 2)) } })} />
                <Text size="small" tone="secondary">per pull request</Text>
              </span>}
            </Inline>
          </NightField>
          <NightField label="Screenshots" tip="Attach before and after images to changes you can see.">
            <div className="flex items-center gap-[var(--space-2)]">
              <Switch label="Screenshots" on={draft.screenshots || locked} disabled={locked} onChange={(screenshots) => set({ screenshots })} />
              {locked && <Text size="small" tone="muted">On while UI and UX polish is on</Text>}
            </div>
          </NightField>
        </NightDisclosureBody>
      </Disclosure>
    </NightQuestion>
  )
}

export type Clocks = Record<'start' | 'wrap_up' | 'hard_stop', string>

/** Question 4: the schedule; the nights and window only matter when it is on. */
export function WhenRun({ draft, set, clocks, onClock }: { draft: NightShiftSettings; set: Set; clocks: Clocks; onClock: (key: keyof Clocks, text: string) => void }): React.JSX.Element {
  const toggleNight = (day: number): void => {
    const nights = draft.window.nights.includes(day) ? draft.window.nights.filter((n) => n !== day) : [...draft.window.nights, day].sort()
    set({ window: { ...draft.window, nights } })
  }
  const total = minutesBetween(draft.window.start, draft.window.hard_stop)
  return (
    <NightQuestion number={4} heading="When does it run?">
      <div className="flex items-center gap-[var(--space-3)]">
        <Switch label="Run on a schedule" on={draft.enabled} onChange={(enabled) => set({ enabled })} />
        <Inline wrap gap="large" align="baseline">
          <Text weight="semibold">Run on a schedule</Text>
          <Text size="small" tone="muted">{scheduleHint(draft)}</Text>
        </Inline>
      </div>
      {draft.enabled && <NightReveal>
        <Inline wrap gap="small" role="group" aria-label="Nights">
          {NIGHTS.map((n) => <Chip key={n.day} variant="choice" label={n.label} selected={draft.window.nights.includes(n.day)} onClick={() => toggleNight(n.day)} />)}
        </Inline>
        <Inline wrap gap="large" align="end">
          {([['start', 'Starts'], ['wrap_up', 'Wraps up'], ['hard_stop', 'Stops']] as const).map(([key, label]) => (
            <label key={key} className="grid gap-[var(--space-1)]">
              <Text size="small" tone="secondary">{label}</Text>
              <TextInput aria-label={label} size="form" width="compact" value={clocks[key]} onChange={(e) => onClock(key, e.target.value)} />
            </label>
          ))}
          <Text size="small" tone="muted">{`${durationLabel(total)} · nothing new starts after wrap-up`}</Text>
        </Inline>
        <NightWindowStrip label="Run window" marks={windowMarks(draft.window)} />
      </NightReveal>}
    </NightQuestion>
  )
}

/** Advanced: who runs the night, in one grid. */
export function Advanced({ draft, set, childCap }: { draft: NightShiftSettings; set: Set; childCap: number }): React.JSX.Element {
  const workerOptions = WORKER_PROVIDERS.map((p) => ({ value: p, label: engineLabel(p) }))
  // A stored ZCode orchestrator stays visible, with its refusal, until it is changed.
  const orchestratorOptions = [...new Set([...ORCHESTRATOR_PROVIDERS, draft.orchestrator.provider])].map((p) => ({ value: p, label: engineLabel(p) }))
  const own = ownLimitNote(draft.live_workers, childCap)
  return (
    <Disclosure summary={<Inline wrap gap="small" align="baseline">Advanced<Text size="small" tone="muted">{crewSummary(draft)}</Text></Inline>}>
      <NightFieldGrid>
        <NightField label="Orchestrator" tip="Plans the night and runs the crew.">
          <div className="flex items-center gap-[var(--space-2)]">
            <Select aria-label="Orchestrator" value={draft.orchestrator.provider} options={orchestratorOptions}
              onChange={(p) => set({ orchestrator: p === draft.orchestrator.provider ? draft.orchestrator : { provider: p as AgentKind, model: null } })} />
            {draft.orchestrator.model && <Text size="small" tone="muted">{draft.orchestrator.model}</Text>}
          </div>
        </NightField>
        <NightField label="Workers, in fallback order" tip="When one hits its usage limit, the next takes over. Cursor, Antigravity and Grok report no usage limit and cannot be workers.">
          <div className="grid gap-[var(--space-1)]">
            {draft.workers.map((w, i) => (
              <div key={i} className="flex items-center gap-[var(--space-2)]">
                <Select aria-label={`Worker ${i + 1}`} value={w.provider} options={workerOptions}
                  onChange={(p) => set({ workers: draft.workers.map((x, j) => (j === i ? { provider: p as AgentKind, model: null } : x)) })} />
                {w.model && <Text size="small" tone="muted">{w.model}</Text>}
                {draft.workers.length > 1 && <Button variant="ghost" size="sm" aria-label={`Remove worker ${i + 1}`} onClick={() => set({ workers: draft.workers.filter((_, j) => j !== i) })}>Remove</Button>}
              </div>
            ))}
            {draft.workers.length < 4 && <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => set({ workers: [...draft.workers, { provider: 'claude', model: null }] })}>Add worker</Button>}
          </div>
        </NightField>
        <NightField label="Workers at a time" tip="How many workers run at once. A reviewer and a QA pane may run beside them, and the orchestrator runs throughout, so the run uses up to this many plus three panes. The run sets its own pane limit from this number; your orchestration limits for other agents stay as they are.">
          <div className="flex items-center gap-[var(--space-2)]">
            <NumberField width="compact" aria-label="Workers at a time" min={1} max={12} value={draft.live_workers} onChange={(e) => set({ live_workers: Math.min(12, Math.max(1, Number(e.target.value) || 1)) })} />
            {own && <Text size="small" tone="muted">{own}</Text>}
          </div>
        </NightField>
        <NightField label="Reviewer" tip="Reads every change before it becomes a pull request.">
          <Select aria-label="Reviewer" value={draft.reviewer?.provider ?? 'same'} options={[{ value: 'same', label: 'Same as orchestrator' }, ...workerOptions]}
            onChange={(p) => set({ reviewer: p === 'same' ? null : { provider: p as AgentKind, model: null } })} />
        </NightField>
        <NightField label="Questions at night" tip="Nobody answers at night, so the crew keeps going and its questions wait in the morning report.">
          <Text tone="secondary">Wait for the morning report</Text>
        </NightField>
      </NightFieldGrid>
    </Disclosure>
  )
}
