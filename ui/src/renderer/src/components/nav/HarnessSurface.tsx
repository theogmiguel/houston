import { useEffect, useRef, useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { Cadence } from '../../houston/generated/Cadence'
import type { HarnessFindingState } from '../../houston/generated/HarnessFindingState'
import type { HarnessModelOption } from '../../houston/generated/HarnessModelOption'
import type { Routine } from '../../houston/generated/Routine'
import type { HarnessAttention } from '../../houston/generated/HarnessAttention'
import type { HarnessReport, HarnessReportError, HarnessState } from '../../houston/useHarness'
import { Select } from '../ui/Select'
import { BarSparkline, Button, Caption, Card, Field, Notice, PageFrame, PageHeader, Segmented, TextInput } from '../ui'
import { BulletList as NavBulletList, FieldGrid, SectionTitle } from '../ui/navText'
import { engineLabel } from '../engineLabel'
import { HarnessFindings } from './HarnessFindings'
import { HarnessReviewHistory } from './HarnessReviewHistory'
import {
  HARNESS_ENGINES,
  SCHEDULE_OPTIONS,
  scheduleFields,
  type HarnessSchedule
} from './harnessFormat'
import { nextUpTimeLabel } from './routineFormat'
import { formatHarnessDate } from './harnessFormat'

export interface HarnessSetupValue {
  engine: AgentKind
  model: string | null
  cadence: Cadence
  enabled: boolean
}

export interface HarnessSurfaceProps {
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

  return (
    <PageFrame width="wide" data-testid="nav-surface">
      <HarnessHeader {...props} routine={props.workspace ? (state?.routine ?? null) : null} />
      <HarnessWorkspaceContent props={props} pendingRun={pendingRun} />
    </PageFrame>
  )
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
  onDismissError
}: HarnessSurfaceProps & { routine: Routine | null }): React.JSX.Element {
  const firstRun = workspace !== null && state !== null && state.routine === null
  const noticeReviewId = attention?.latest_published_review_id ?? null
  const noticeVisible = noticeReviewId !== null && noticeReviewId > (attention?.seen_review_id ?? 0)
  const noticeFindings = state?.findings ?? []
  const newCount = noticeFindings.filter((finding) => finding.review_id === noticeReviewId && !finding.task).length
  const verifiedCount = noticeFindings.filter((finding) => finding.verification?.review_id === noticeReviewId && finding.verification.verdict === 'gone').length
  return (
    <>
      {noticeVisible && workspace && state && (
        <Notice tone="info" indicator="dot" action={{ label: 'Dismiss', onClick: () => onSeen(workspace, noticeReviewId) }}>
          Review #{noticeReviewId} found {newCount} new {newCount === 1 ? 'thing' : 'things'} to fix and confirmed {verifiedCount} fix{verifiedCount === 1 ? '' : 'es'} worked.
        </Notice>
      )}
      <PageHeader
        heading="Harness"
        description="Reads your agents' sessions and turns repeated mistakes into tasks. The next review checks whether each fix worked."
        actions={routine
          ? <Button data-testid="harness-run" variant="primary" disabled={running} onClick={() => onRunNow(routine.id)}>{running ? 'Review running…' : 'Run review now'}</Button>
          : firstRun ? <Button type="submit" form={FIRST_RUN_FORM_ID} variant="primary">Run first review</Button> : undefined}
      />
      {error && <Notice tone="danger" className="w-full" action={{ label: 'Dismiss', onClick: onDismissError ?? (() => {}) }}>{error}</Notice>}
    </>
  )
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
      <div className="grid gap-[var(--space-2)]">
        <p>{workspaces.length ? 'Choose a workspace to see its Harness reviews.' : 'Add a workspace to review its agent sessions.'}</p>
        {workspaces.length > 0 && <Select aria-label="Workspace" data-testid="harness-workspace" value="" options={[{ value: '', label: 'Choose a workspace', disabled: true }, ...workspaces.map((item) => ({ value: item.id, label: item.name }))]} onChange={props.onWorkspace} />}
      </div>
    )
  }
  if (!state) return <p role="status" aria-busy="true">Reading this workspace&apos;s reviews…</p>
  if (!state.routine) {
    return <FirstRun models={state.models} onStart={(value) => { pendingRun.current = workspace; props.onCreateRoutine(value) }} />
  }
  const published = state.reviews.filter((review) => review.status === 'published')
  const trend = props.trendValues ?? published.slice(0, 4).reverse().map((review) =>
    review.sessions ? Math.round((review.finding_count * 100) / review.sessions) : 0
  )
  const trendReviewCount = props.trendReviewCount ?? published.length
  return <HarnessBody {...props} state={state} routine={state.routine} published={published} latestReview={published[0] ?? null} trend={trend} trendReviewCount={trendReviewCount} />
}

const FIRST_RUN_FORM_ID = 'harness-first-run-form'

function FirstRun({
  onStart,
  models
}: {
  onStart: (setup: HarnessSetupValue) => void
  models: HarnessModelOption[]
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
        <SetupFields models={models} onSubmit={onStart} />
      </Card>
      <WhatARunSends />
    </div>
  )
}

function WhatARunSends(): React.JSX.Element {
  return (
    <Card tone="inset" padding="md" className="grid gap-[var(--space-1-5)]" data-testid="harness-consent">
      <SectionTitle>What a review sends to its provider</SectionTitle>
      <NavBulletList>
        <li>
          The harness files: CLAUDE.md, AGENTS.md, rules, skills, settings, hooks and MCP configuration.
        </li>
        <li>
          Excerpts of this workspace&apos;s Claude Code and Codex sessions in the review window: your prompts,
          tool failures, permission denials with secrets masked, the skills and subagents used, and each
          session&apos;s last assistant message.
        </li>
      </NavBulletList>
      <Caption>
        The run is an agent pane you can watch. It sends those excerpts through the chosen provider&apos;s own
        CLI, like any turn of that agent. The findings it publishes stay on this machine.
      </Caption>
    </Card>
  )
}

function SetupFields({
  models,
  onSubmit
}: {
  models: HarnessModelOption[]
  onSubmit: (value: HarnessSetupValue) => void
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
            options={HARNESS_ENGINES.map((k) => ({ value: k, label: engineLabel(k) }))}
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
    <div className="grid gap-[var(--space-2)]">
      {published.length === 0 && <WhatARunSends />}
      {published.length > 0 && <div className="flex min-w-0 items-center gap-[var(--space-2)]">
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
        Read: Claude Code, Codex. {coverage ? `Not read: ${unscanned} in this window.` : 'All sessions in this window were read.'}
      </Caption>
    </div>
  )
}
