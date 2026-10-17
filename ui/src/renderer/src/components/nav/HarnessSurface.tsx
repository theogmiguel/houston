import { useEffect, useRef, useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { Cadence } from '../../houston/generated/Cadence'
import type { HarnessFindingState } from '../../houston/generated/HarnessFindingState'
import type { HarnessModelOption } from '../../houston/generated/HarnessModelOption'
import type { Routine } from '../../houston/generated/Routine'
import type { HarnessAttention } from '../../houston/generated/HarnessAttention'
import type { RoutineEngineRefusal } from '../../houston/generated/RoutineEngineRefusal'
import type { ChatPermissionMode } from '../../houston/generated/ChatPermissionMode'
import type { HarnessReport, HarnessReportError, HarnessState } from '../../houston/useHarness'
import { IconHistory, IconPlay } from '../icons'
import { ReviewSummary } from '../ui/ReviewSummary'
import { Select } from '../ui/Select'
import { BarSparkline, Button, Caption, Card, EmptyState, Field, NavSurfaceFrame, Notice, PageHeader, Segmented, StatusLabel, Text, TextInput } from '../ui'
import { BulletList, FieldGrid, SectionTitle } from '../ui/navText'
import { engineLabel } from '../engineLabel'
import { routineEngineOptions } from './routineEngines'
import { HarnessFindings } from './HarnessFindings'
import { HarnessReviewHistory } from './HarnessReviewHistory'
import {
  SCHEDULE_OPTIONS,
  scheduleFields,
  type HarnessSchedule
} from './harnessFormat'
import { AgentSettingsBody } from '../ui/AgentSettingsBody'
import { nextUpTimeLabel } from './routineFormat'
import { formatHarnessDate } from './harnessFormat'

export interface HarnessSetupValue {
  engine: AgentKind
  model: string | null
  cadence: Cadence
  enabled: boolean
}

export interface HarnessSurfaceProps {
  embedded?: boolean
  onOpenRoutines?: () => void
  workspaces: { id: string; name: string }[]
  workspace: string | null
  onWorkspace: (id: string) => void
  state: HarnessState | null
  report: HarnessReport | null
  reportError?: HarnessReportError | null
  running: boolean
  error?: string | null
  onDismissError?: () => void
  onCreateRoutine: (setup: HarnessSetupValue) => void
  onRunNow: (routineId: number) => void
  onDecide: (key: string, state: HarnessFindingState) => void
  attention?: HarnessAttention | null
  onSeen: (workspace: string, reviewId: number) => void
  onCreateTask: (key: string, engine: AgentKind, prompt: string) => void
  onLoadReport: (reviewId: number) => void
  onOpenFile: (path: string) => void
  onReveal: (path: string) => void
  trendValues?: number[]
  trendReviewCount?: number
  historyDeltaOverrides?: Record<number, { new: number; gone: number }>
}

export function HarnessSurface(props: HarnessSurfaceProps): React.JSX.Element {
  const { state, onRunNow } = props
  // A first review runs as soon as the routine it creates is listed.
  const pendingRun = useRef<string | null>(null)
  useEffect(() => {
    if (state?.routine && pendingRun.current === state.workspace) {
      pendingRun.current = null
      onRunNow(state.routine.id)
    }
  }, [state, onRunNow])

  const body = (
      <AgentSettingsBody embedded={props.embedded}>
        <HarnessHeader {...props} routine={props.workspace ? (state?.routine ?? null) : null} />
        <HarnessWorkspaceContent props={props} pendingRun={pendingRun} />
      </AgentSettingsBody>
  )
  return props.embedded ? body : <NavSurfaceFrame>{body}</NavSurfaceFrame>
}

function HarnessHeader({
  workspace,
  state,
  running,
  routine,
  attention,
  onRunNow,
  onSeen,
  error,
  onDismissError,
  embedded
}: HarnessSurfaceProps & { routine: Routine | null }): React.JSX.Element {
  const firstRun = workspace !== null && state !== null && state.routine === null
  const noticeReviewId = attention?.latest_published_review_id ?? null
  const noticeVisible = noticeReviewId !== null && noticeReviewId > (attention?.seen_review_id ?? 0)
  const noticeFindings = state?.findings ?? []
  const newCount = noticeFindings.filter((finding) => finding.review_id === noticeReviewId && !finding.task).length
  const verifiedCount = noticeFindings.filter((finding) => finding.verification?.review_id === noticeReviewId && finding.verification.verdict === 'gone').length
  return (
    <>
      <PageHeader
        heading={embedded ? 'Review' : 'Harness'}
        description={embedded ? "A weekly read of your sessions that looks for mistakes agents repeat. The schedule lives in Routines." : "Reads your agents' sessions and turns repeated mistakes into tasks. The next review checks whether each fix worked."}
        actions={<HarnessHeaderAction routine={routine} running={running} firstRun={firstRun} embedded={embedded} onRunNow={onRunNow} />}
      />
      {noticeVisible && workspace && state && (
        <Notice tone="info" indicator="dot" action={{ label: 'Dismiss', onClick: () => onSeen(workspace, noticeReviewId) }}>
          Review #{noticeReviewId} found {newCount} new {newCount === 1 ? 'thing' : 'things'} to fix and confirmed {verifiedCount} fix{verifiedCount === 1 ? '' : 'es'} worked.
        </Notice>
      )}
      {error && <Notice tone="danger" className="w-full" action={{ label: 'Dismiss', onClick: onDismissError ?? (() => {}) }}>{error}</Notice>}
    </>
  )
}

function HarnessHeaderAction({ routine, running, firstRun, embedded, onRunNow }: { routine: Routine | null; running: boolean; firstRun: boolean; embedded?: boolean; onRunNow: (id: number) => void }): React.JSX.Element | null {
  if (routine && embedded) return null
  if (routine) return <Button data-testid="harness-run" variant="primary" disabled={running} onClick={() => onRunNow(routine.id)}>{running ? 'Review running…' : 'Run review now'}</Button>
  if (!firstRun || embedded) return null
  return <Button type="submit" form={FIRST_RUN_FORM_ID} variant="primary">Run first review</Button>
}

function HarnessWorkspaceContent({
  props,
  pendingRun
}: {
  props: HarnessSurfaceProps
  pendingRun: React.MutableRefObject<string | null>
}): React.JSX.Element {
  const { workspace, state, workspaces } = props
  if (!workspace) {
    return (
      <Card shape="card" padding="md" className="grid gap-[var(--space-3)]">
        <div className="grid gap-[var(--space-1)]">
          <SectionTitle>{workspaces.length ? 'Choose a workspace' : 'No workspaces yet'}</SectionTitle>
          <Caption>{workspaces.length ? 'Choose a workspace to see its Harness reviews.' : 'Add a workspace to review its agent sessions.'}</Caption>
        </div>
        {workspaces.length > 0 && <Field label="Workspace"><Select aria-label="Workspace" data-testid="harness-workspace" width="full" value="" options={[{ value: '', label: 'Choose a workspace', disabled: true }, ...workspaces.map((item) => ({ value: item.id, label: item.name }))]} onChange={props.onWorkspace} /></Field>}
      </Card>
    )
  }
  if (!state) return <Text as="p" role="status" aria-busy="true" tone="muted" flush>Reading this workspace&apos;s reviews…</Text>
  if (!state.routine) {
    if (props.embedded) return <Card shape="card" padding="page"><EmptyState icon={IconHistory} heading="No review set up" description="Create a weekly review for this workspace in Routines. It reads recent sessions and lists what to change." action={{ label: 'Open Routines', onClick: props.onOpenRoutines ?? (() => {}) }} /></Card>
    return <FirstRun models={state.models} engineRefusals={state.engineRefusals} onStart={(value) => { pendingRun.current = workspace; props.onCreateRoutine(value) }} />
  }
  const published = state.reviews.filter((review) => review.status === 'published')
  const trend = reviewTrendValues(published, props.trendValues)
  const trendReviewCount = props.trendReviewCount ?? published.length
  return <HarnessBody {...props} state={state} routine={state.routine} published={published} latestReview={published[0] ?? null} trend={trend} trendReviewCount={trendReviewCount} />
}

const FIRST_RUN_FORM_ID = 'harness-first-run-form'
/** The daemon's review preset starts with accept edits. */
const REVIEW_ACCESS: ChatPermissionMode = 'accept_edits'
const REVIEW_ACCESS_REMEDY = 'A review starts with accept edits: start it with another provider, then change its access in Routines.'

function FirstRun({
  onStart,
  models,
  engineRefusals
}: {
  onStart: (setup: HarnessSetupValue) => void
  models: HarnessModelOption[]
  engineRefusals: readonly RoutineEngineRefusal[]
}): React.JSX.Element {
  return (
    <div className="grid gap-[var(--space-3)]" data-testid="harness-first-run">
      <Card padding="md" className="grid gap-[var(--space-3)]">
        <div className="grid gap-[var(--space-1)]">
          <SectionTitle>No reviews yet</SectionTitle>
          <Caption>
            A review reads this workspace&apos;s recent agent sessions, compares them with its instructions,
            rules, skills and settings, and lists what to change. It never edits them.
          </Caption>
        </div>
        <HarnessSetupFields models={models} engineRefusals={engineRefusals} onSubmit={onStart} />
      </Card>
      <HarnessReviewConsent />
    </div>
  )
}

export function HarnessReviewConsent(): React.JSX.Element {
  return (
    <Card tone="inset" padding="md" className="grid gap-[var(--space-1-5)]" data-testid="harness-consent">
      <SectionTitle>What a review sends to its provider</SectionTitle>
      <BulletList>
        <li>
          The harness files: CLAUDE.md, AGENTS.md, rules, skills, settings, hooks and MCP configuration.
        </li>
        <li>
          Excerpts of this workspace&apos;s Claude Code and Codex sessions in the review window: your prompts,
          tool failures, permission denials with secrets masked, the skills and subagents used, and each
          session&apos;s last assistant message.
        </li>
      </BulletList>
      <Caption>
        The run is an agent pane you can watch. It sends those excerpts through the chosen provider&apos;s own
        CLI, like any turn of that agent. The findings it publishes stay on this machine.
      </Caption>
    </Card>
  )
}

export function HarnessSetupFields({
  models,
  engineRefusals,
  onSubmit,
  submitLabel
}: {
  models: HarnessModelOption[]
  engineRefusals: readonly RoutineEngineRefusal[]
  onSubmit: (value: HarnessSetupValue) => void
  submitLabel?: string
}): React.JSX.Element {
  const [engine, setEngine] = useState<AgentKind>('claude')
  const [model, setModel] = useState('')
  const [schedule, setSchedule] = useState<Exclude<HarnessSchedule, 'custom'>>('off')
  const catalogProvider = engine === 'claude' || engine === 'codex'
  const modelOptions = [
    { value: '', label: "The provider's default" },
    ...models.filter((entry) => entry.provider === engine).map(({ id }) => ({ value: id, label: id }))
  ]
  return (
    <form
      id={FIRST_RUN_FORM_ID}
      className="grid gap-[var(--space-3)]"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({ engine, model: model.trim() || null, ...scheduleFields(schedule, null) })
      }}
    >
      <FieldGrid>
        <Field label="Provider">
          <Select
            aria-label="Provider"
            data-testid="harness-provider"
            className="w-full"
            value={engine}
            options={routineEngineOptions(engineRefusals, REVIEW_ACCESS, REVIEW_ACCESS_REMEDY)}
            onChange={(v) => {
              setEngine(v as AgentKind)
              setModel('')
            }}
          />
        </Field>
        <Field label="Model" hint={catalogProvider ? "Models come from Houston's shared catalog. Availability depends on your provider account." : undefined}>
          {catalogProvider ? (
            <Select aria-label="Model" data-testid="harness-model" className="w-full" value={model} options={modelOptions} onChange={setModel} />
          ) : (
            <TextInput aria-label="Model" autoComplete="off" surface="card" value={model} placeholder="The provider's default" onChange={(e) => setModel(e.target.value)} />
          )}
        </Field>
      </FieldGrid>
      <Field label="Schedule" hint="Every run spends tokens. A scheduled run reads from where the previous review stopped.">
        <Segmented aria-label="Schedule" value={schedule} options={SCHEDULE_OPTIONS} onChange={setSchedule} />
      </Field>
      {submitLabel && <Button type="submit" variant="primary" className="justify-self-start">{submitLabel}</Button>}
    </form>
  )
}

function HarnessBody(
  props: HarnessSurfaceProps & {
    state: HarnessState
    routine: Routine
    published: HarnessState['reviews']
    latestReview: HarnessState['reviews'][number] | null
    trend: number[]
    trendReviewCount: number
  }
): React.JSX.Element {
  const { state, routine, latestReview, published, trend, trendReviewCount } = props
  const firstValue = trend[0] ?? 0
  const lastValue = trend[trend.length - 1] ?? 0
  const coverage = state.providerCoverage.reduce((sum, item) => sum + item.sessions, 0)
  const unscanned = state.providerCoverage.map((item) => `${item.sessions} ${engineLabel(item.agent)} sessions`).join(', ')
  return (
    <div className="grid gap-[var(--space-5)]">
      {props.embedded && <HarnessReviewSummary {...props} />}
      {published.length === 0 && <HarnessReviewConsent />}
      {!props.embedded && trend.length > 1 && <div className="flex min-w-0 items-center gap-[var(--space-2)]">
        <BarSparkline values={trend} label={`Repeated mistakes per 100 sessions: ${firstValue} to ${lastValue}`} />
        <Caption className="min-w-0">
          Repeated mistakes per 100 sessions: {firstValue} → {lastValue} over {trendReviewCount} reviews
          {latestReview && <> · last review #{latestReview.id} {formatHarnessDate(latestReview.started_at_ms, true)}, {latestReview.sessions ?? 0} sessions</>}
          {routine.enabled && <> · next {nextUpTimeLabel(routine.next_run_at_ms, Date.now())}</>}
        </Caption>
      </div>}
      <HarnessFindings
        workspace={state.workspace}
        findings={state.findings}
        defaultEngine={routine.engine}
        latestReviewId={latestReview?.id ?? null}
        latestReviewSessions={latestReview?.sessions ?? null}
        onDecide={props.onDecide}
        onCreateTask={props.onCreateTask}
        onVerifyNow={() => props.onRunNow(routine.id)}
      />
      <HarnessReviewHistory
        state={state}
        report={props.report}
        reportError={props.reportError ?? null}
        onLoadReport={props.onLoadReport}
        onOpenFile={props.onOpenFile}
        onReveal={props.onReveal}
        deltaOverrides={props.historyDeltaOverrides}
      />
      <Caption tone="faint">
        {props.embedded && <>Reviews read session excerpts through the agent you pick and suggest changes. They never edit your instructions, skills or settings. </>}
        Read: Claude Code, Codex. {coverage ? `Not read: ${unscanned} in this window.` : 'All sessions in this window were read.'}
      </Caption>
    </div>
  )
}

function reviewTrendHeading(latest: HarnessState['reviews'][number] | null, trend: number[]): string {
  if (!latest) return 'No published reviews yet.'
  if (trend.length < 2) return `Last review found ${latest.finding_count} repeated mistake${latest.finding_count === 1 ? '' : 's'}`
  const first = trend[0], last = trend[trend.length - 1]
  if (first === last) return `Repeated mistakes stayed at ${last} per 100 sessions`
  return `Repeated mistakes ${last < first ? 'fell' : 'rose'} from ${first} to ${last} per 100 sessions`
}
function HarnessReviewSummary({ state, latestReview, trend, routine, running, onRunNow, onOpenRoutines }: HarnessSurfaceProps & { state: HarnessState; routine: Routine; latestReview: HarnessState['reviews'][number] | null; trend: number[] }): React.JSX.Element {
  const current = running ? state.reviews.find((review) => review.status === 'running') ?? null : null
  const last = latestReview ? `Last review ${formatHarnessDate(latestReview.started_at_ms, true)} · ${latestReview.sessions == null ? 'Session total not reported' : `${latestReview.sessions} sessions`}` : 'Run the first review to read this workspace’s sessions'
  const detail = <>{current ? <StatusLabel status="Running" size="small">{`Review #${current.id} is reading sessions, started ${formatHarnessDate(current.started_at_ms, true)}`}</StatusLabel> : last}{!current && routine.enabled && <> · next {nextUpTimeLabel(routine.next_run_at_ms, Date.now())}</>} · <Button variant="body-link" onClick={onOpenRoutines}>Edit schedule in Routines</Button></>
  return <ReviewSummary heading={reviewTrendHeading(latestReview, trend)} detail={detail} chart={trend.length > 1 ? <BarSparkline values={trend} label={`Repeated mistakes per 100 sessions: ${trend.join(', ')}`} /> : undefined} action={<Button icon={IconPlay} data-testid="harness-run" variant="primary" disabled={running} onClick={() => onRunNow(routine.id)}>{running ? 'Review running…' : 'Review now'}</Button>} />
}

function reviewTrendValues(published: HarnessState['reviews'], override?: number[]): number[] {
  if (!published[0]?.sessions) return []
  return override ?? published.filter((review) => review.sessions != null && review.sessions > 0).slice(0, 4).reverse().map((review) => Math.round((review.finding_count * 100) / review.sessions!))
}
