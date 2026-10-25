import type { DefectDecision } from '../../houston/generated/DefectDecision'
import type { SuspectedDefect } from '../../houston/generated/SuspectedDefect'
import { Button, Caption, Card, InlineLink, StatusLabel, type StatusLabelValue } from '../ui'
import { SettingsToolbar } from '../ui/SettingsToolbar'
import { SectionTitle } from '../ui/navText'
import { ReviewFinding, ReviewFindingFacts, ReviewFindingList, ReviewFindingMeta, ReviewFindingQuote, type ReviewFindingFact } from '../ui/ReviewFinding'
import { formatHarnessDate } from './harnessFormat'

export function defectSourceLabel(defect: SuspectedDefect): string {
  if (defect.source === 'agent') return 'Reported by an agent'
  return defect.detector ? `Detector: ${defect.detector}` : 'Detector'
}

export function defectDestinationLabel(defect: SuspectedDefect): string {
  return defect.destination === 'houston' ? 'Houston' : "This workspace's repository"
}

export function defectStateLabel(defect: SuspectedDefect): StatusLabelValue {
  if (defect.state === 'open') return 'Open'
  return defect.state === 'resolved' ? 'Done' : 'Paused'
}

export function defectStateWord(defect: SuspectedDefect): string {
  if (defect.state === 'open') return 'Open'
  return defect.state === 'resolved' ? 'Resolved' : 'Dismissed'
}

/** Undecided defects first, then the most recently seen. */
export function sortSuspectedDefects(defects: SuspectedDefect[]): SuspectedDefect[] {
  return [...defects].sort((a, b) => Number(a.state !== 'open') - Number(b.state !== 'open') || b.last_seen_ms - a.last_seen_ms)
}

export function defectFacts(defect: SuspectedDefect): ReviewFindingFact[] {
  const facts: ReviewFindingFact[] = [
    { label: 'Source', value: defectSourceLabel(defect) },
    { label: 'Destination', value: defectDestinationLabel(defect) },
    { label: 'Seen', value: `${defect.count} time${defect.count === 1 ? '' : 's'}${defect.recurred ? ' · raised again after a decision' : ''}` },
    { label: 'First seen', value: formatHarnessDate(defect.first_seen_ms) },
    { label: 'Last seen', value: formatHarnessDate(defect.last_seen_ms) }
  ]
  if (defect.evidence.length > 0) {
    facts.push({
      label: 'Evidence',
      value: <span className="grid gap-[var(--space-1-5)]">{defect.evidence.map((item, index) => <ReviewFindingQuote key={index}>{item}</ReviewFindingQuote>)}</span>
    })
  }
  if (defect.issue_url) {
    facts.push({ label: 'Issue', value: <InlineLink href={defect.issue_url}>{defect.issue_url}</InlineLink> })
  }
  return facts
}

export interface HarnessDefectsProps {
  defects: SuspectedDefect[]
  onDecide: (key: string, decision: DefectDecision) => void
  onOpenIssue: (key: string) => void
}

export function HarnessDefects({ defects, onDecide, onOpenIssue }: HarnessDefectsProps): React.JSX.Element {
  const undecided = defects.filter((defect) => defect.state === 'open').length
  const sorted = sortSuspectedDefects(defects)
  return (
    <section className="grid gap-[var(--space-3)]" aria-label="Suspected defects">
      <SettingsToolbar actions={undecided > 0 ? <Caption>{undecided} need{undecided === 1 ? 's' : ''} a decision</Caption> : undefined}>
        <SectionTitle>Suspected defects</SectionTitle>
      </SettingsToolbar>
      {sorted.length === 0 ? (
        <Card shape="card" padding="md"><Caption>No suspected defects. Agents and Houston&apos;s own detectors add them here.</Caption></Card>
      ) : (
        <ReviewFindingList label="Suspected defects">
          {sorted.map((defect) => <DefectRow key={defect.key} defect={defect} onDecide={onDecide} onOpenIssue={onOpenIssue} />)}
        </ReviewFindingList>
      )}
    </section>
  )
}

function DefectRow({ defect, onDecide, onOpenIssue }: Pick<HarnessDefectsProps, 'onDecide' | 'onOpenIssue'> & { defect: SuspectedDefect }): React.JSX.Element {
  const meta = [defectSourceLabel(defect), defectDestinationLabel(defect), `${defect.count} time${defect.count === 1 ? '' : 's'}`, `last seen ${formatHarnessDate(defect.last_seen_ms)}`]
  if (defect.recurred) meta.push('recurred')
  const decided = defect.state !== 'open'
  return (
    <ReviewFinding
      heading={defect.title}
      meta={<ReviewFindingMeta parts={meta} />}
      status={<StatusLabel status={defectStateLabel(defect)} size="small">{defectStateWord(defect)}</StatusLabel>}
      primaryAction={defect.issue_url
        ? <InlineLink href={defect.issue_url}>View issue</InlineLink>
        : decisionAction(defect, onOpenIssue)}
      secondaryAction={decided
        ? <Button variant="ghost" onClick={() => onDecide(defect.key, 'reopen')}>Reopen</Button>
        : <Button variant="ghost" onClick={() => onDecide(defect.key, 'dismiss')}>Dismiss</Button>}
      detail={<>
        <ReviewFindingFacts facts={defectFacts(defect)} />
        {!decided && <Button variant="ghost" className="mt-[var(--space-2)] justify-self-start" onClick={() => onDecide(defect.key, 'not_a_bug')}>Not a bug</Button>}
      </>}
    />
  )
}

function decisionAction(defect: SuspectedDefect, onOpenIssue: (key: string) => void): React.JSX.Element | null {
  if (defect.state !== 'open') return null
  return <Button variant="secondary" onClick={() => onOpenIssue(defect.key)}>Open issue</Button>
}
