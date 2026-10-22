import type { NightEntry } from '../../houston/generated/NightEntry'
import type { NightRun } from '../../houston/generated/NightRun'
import type { NightShiftReportText } from '../../houston/useNightShift'
import { MarkdownPreview } from '../MarkdownPreview'
import { Button, Card, GateChip, Inline, Notice, Readout, SectionHead, Text } from '../ui'
import { ReadoutGrid } from '../ui/Readout'
import { engineLabel } from '../engineLabel'
import { STOP_REASON, decisionOptions, decisionText, headline, prShelves, timeOfDay } from './nightShiftFormat'

function Gates({ entry }: { entry: NightEntry }): React.JSX.Element {
  const g = entry.gates
  return (
    <Inline wrap gap="small">
      <GateChip label="Checks" state={g.checks} kind="fact" />
      <GateChip label="CI" state={g.ci} kind="fact" />
      <GateChip label="Review" state={g.review} kind="verdict" />
      {entry.visible && <GateChip label="QA" state={g.qa} kind="verdict" />}
    </Inline>
  )
}

function Decision({ entry, onDecide }: { entry: NightEntry; onDecide: (choice: string) => void }): React.JSX.Element {
  const options = decisionOptions(entry)
  const choices = options.length ? options : ['Go ahead', 'Reject']
  return (
    <Card.Row heading={entry.title}
      meta={entry.choice ? `Answered: ${entry.choice}` : decisionText(entry) || 'Parked for you'}
      action={entry.choice ? null : <Inline wrap gap="small">
        {choices.map((c) => <Button key={c} variant="secondary" size="sm" onClick={() => onDecide(c)}>{c}</Button>)}
      </Inline>} />
  )
}

/** The morning report: headline, decisions, PRs by theme with their gates, merge order, events and cost. */
export function NightShiftReport({ run, report, holdForQa, onDecide, onQaPassed, onLoadReport }: {
  run: NightRun
  report: NightShiftReportText | null
  /** Merge queue output with Hold for my QA: visible PRs wait for the user. */
  holdForQa: boolean
  onDecide: (entryId: number, choice: string) => void
  onQaPassed: (entryId: number) => void
  onLoadReport: () => void
}): React.JSX.Element {
  const decisions = run.entries.filter((e) => e.kind === 'decision')
  const shelves = prShelves(run)
  const byNumber = new Map(run.entries.filter((e) => e.kind === 'pr').map((e) => [e.pr_number, e]))
  const lessons = run.entries.filter((e) => e.kind === 'lesson' || e.kind === 'flaky' || e.kind === 'deferred')
  const shownReport = report?.runId === run.run_id ? report : null
  return (
    <div className="grid gap-[var(--space-3)]" data-testid="night-shift-report">
      <div className="grid gap-[var(--space-0-5)]">
        <Text size="title" weight="semibold" data-testid="night-headline">{headline(run)}</Text>
        <Text size="small" tone="muted">
          {timeOfDay(run.started_at_ms)}–{run.ended_at_ms ? timeOfDay(run.ended_at_ms) : 'now'}
          {run.stop_reason ? ` · ${STOP_REASON[run.stop_reason]}` : ''}{run.stop_detail ? ` (${run.stop_detail})` : ''}
        </Text>
        {run.summary && <Text>{run.summary}</Text>}
      </div>

      {run.phase === 'refused' && <Notice tone="warn">{run.stop_detail ?? 'Preflight refused this run.'}</Notice>}

      <section className="grid gap-[var(--space-1-5)]" aria-label="Decisions">
        <SectionHead title="Decisions" count={decisions.filter((d) => !d.choice).length} variant="sentence" tone="muted" />
        {decisions.length === 0 ? <Text size="small" tone="muted">Nothing parked.</Text> : <Card>
          {decisions.map((d) => <Decision key={d.id} entry={d} onDecide={(c) => onDecide(d.id, c)} />)}
        </Card>}
      </section>

      <section className="grid gap-[var(--space-1-5)]" aria-label="Pull requests">
        <SectionHead title="Pull requests" count={byNumber.size} variant="sentence" tone="muted" />
        {shelves.length === 0 && <Text size="small" tone="muted">No pull requests this run.</Text>}
        {shelves.map((shelf) => (
          <div key={shelf.theme} className="grid gap-[var(--space-1)]" role="group" aria-label={`Theme ${shelf.theme}`}>
            <Text size="small" weight="semibold">{shelf.theme}</Text>
            <Card>
              {shelf.prs.map((pr) => (
                <Card.Row key={pr.id} heading={`#${pr.pr_number} ${pr.title}`}
                  meta={<div className="grid gap-[var(--space-1)]"><Gates entry={pr} />{pr.gates.reruns > 0 && <Text size="small" tone="muted">CI re-run {pr.gates.reruns}× for a known flaky test</Text>}</div>}
                  action={holdForQa && pr.visible ? (pr.qa_passed ? <Text size="small" tone="muted">QA passed</Text>
                    : <Button variant="secondary" size="sm" onClick={() => onQaPassed(pr.id)}>Mark QA passed</Button>) : null} />
              ))}
            </Card>
          </div>
        ))}
        <Text size="small" tone="muted">Checks and CI are what ran; review and QA are agents’ verdicts.</Text>
      </section>

      {run.merge_order.length > 0 && <section className="grid gap-[var(--space-1-5)]" aria-label="Merge order">
        <SectionHead title="Suggested merge order" variant="sentence" tone="muted" />
        <ol className="grid gap-[var(--space-0-5)]">
          {run.merge_order.map((n) => <li key={n}><Text size="small">#{n} {byNumber.get(n)?.title ?? ''}</Text></li>)}
        </ol>
      </section>}

      <section className="grid gap-[var(--space-1-5)]" aria-label="Events">
        <SectionHead title="Events" variant="sentence" tone="muted" />
        <Card>
          {run.interruptions.map((i, k) => <Card.Row key={`i${k}`} heading={`Interrupted at ${timeOfDay(i.at_ms)}`} meta={i.detail} />)}
          {run.limited.map((p) => <Card.Row key={`l${p}`} heading={`${engineLabel(p)} limited`} meta="Later spawns used the next worker provider." />)}
          {lessons.map((e) => <Card.Row key={e.id} heading={e.title} meta={e.kind === 'flaky' ? 'Known flaky test' : e.kind === 'deferred' ? 'Deferred to a later run' : 'Lesson'} />)}
          {run.interruptions.length + run.limited.length + lessons.length === 0 && <Card.Row heading={<Text tone="muted">No interruptions or limits.</Text>} />}
        </Card>
      </section>

      <section className="grid gap-[var(--space-1-5)]" aria-label="Cost">
        <SectionHead title="Cost" variant="sentence" tone="muted" />
        <ReadoutGrid>
          <Readout label="Pane-hours" value={run.cost.pane_hours.toFixed(1)} tabular />
          <Readout label="Panes" value={run.cost.panes} tabular />
          {run.cost.per_provider.map((l) => <Readout key={l.provider} label={engineLabel(l.provider)} value={`${l.pane_hours.toFixed(1)} h`} sub={`${l.panes} panes`} tabular />)}
        </ReadoutGrid>
      </section>

      {run.report_published && <section className="grid gap-[var(--space-1-5)]" aria-label="Report">
        <SectionHead title="Report" variant="sentence" tone="muted" />
        {shownReport ? <MarkdownPreview source={shownReport.markdown} variant="report" />
          : <Button variant="muted-link" size="sm" className="justify-self-start" onClick={onLoadReport}>Read the full report</Button>}
      </section>}
    </div>
  )
}
